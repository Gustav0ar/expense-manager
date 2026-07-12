import { error } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { getPrivateEnv } from '$lib/server/config';
import { db } from '$lib/server/db';
import { auditEvent, mfaSession, userMfaConfig } from '$lib/server/db/schema';
import { safeEqual, sha256 } from '$lib/server/utils/crypto';
import { buildOtpAuthUri, generateTotpCode, generateTotpSecret } from '$lib/server/utils/totp';
import { translate, type SupportedLocale } from '$lib/i18n';
import { decryptMfaSecret, encryptMfaSecret, MfaSecretDecryptionError } from './mfa-secret';

const mfaSessionTtlMs = 12 * 60 * 60 * 1000;
const cleanupIntervalMs = 60 * 60 * 1000;
let lastMfaSessionCleanupAt = 0;

export async function getMfaStatus(userId: string) {
	const [config] = await db
		.select({
			userId: userMfaConfig.userId,
			enabledAt: userMfaConfig.enabledAt,
			recoveryCodeHashes: userMfaConfig.recoveryCodeHashes
		})
		.from(userMfaConfig)
		.where(eq(userMfaConfig.userId, userId))
		.limit(1);

	return {
		enabled: Boolean(config),
		enabledAt: config?.enabledAt ?? null,
		recoveryCodesRemaining: config?.recoveryCodeHashes.length ?? 0
	};
}

export async function beginMfaSetup(input: { email: string }) {
	const secret = generateTotpSecret();
	return {
		secret,
		otpAuthUri: buildOtpAuthUri({
			issuer: getPrivateEnv('PUBLIC_APP_NAME') || 'Expense Manager',
			account: input.email,
			secret
		})
	};
}

export async function enableMfa(input: {
	userId: string;
	email: string;
	secret: string;
	code: string;
	sessionId?: string;
	locale?: SupportedLocale;
}) {
	// Use findAcceptedTotpCounter so we capture the matched counter and can
	// record it immediately, preventing replay of the enrollment code.
	const enrollCounter = findAcceptedTotpCounter(input.secret, input.code);
	if (enrollCounter === null) throw error(400, translate(input.locale, 'Invalid MFA code.'));

	const recoveryCodes = generateRecoveryCodes();
	const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);

	await db.transaction(async (tx) => {
		await tx
			.insert(userMfaConfig)
			.values({
				userId: input.userId,
				encryptedSecret: encryptMfaSecret(input.secret),
				recoveryCodeHashes,
				lastUsedTotpCounter: enrollCounter
			})
			.onConflictDoUpdate({
				target: userMfaConfig.userId,
				set: {
					encryptedSecret: encryptMfaSecret(input.secret),
					recoveryCodeHashes,
					lastUsedTotpCounter: enrollCounter,
					enabledAt: new Date(),
					updatedAt: new Date()
				}
			});

		await tx.insert(auditEvent).values({
			actorUserId: input.userId,
			action: 'mfa.enabled',
			entityType: 'user',
			entityId: input.userId,
			metadata: { email: input.email }
		});
	});

	if (input.sessionId) await markMfaSessionVerified(input.userId, input.sessionId);

	return { recoveryCodes };
}

export async function disableMfa(input: {
	userId: string;
	code: string;
	locale?: SupportedLocale;
}) {
	const verified = await verifyMfaCodeForUser(input.userId, input.code, input.locale);
	if (!verified) throw error(400, translate(input.locale, 'Invalid MFA code.'));

	await db.transaction(async (tx) => {
		await tx.delete(userMfaConfig).where(eq(userMfaConfig.userId, input.userId));
		await tx.delete(mfaSession).where(eq(mfaSession.userId, input.userId));
		await tx.insert(auditEvent).values({
			actorUserId: input.userId,
			action: 'mfa.disabled',
			entityType: 'user',
			entityId: input.userId
		});
	});
}

export async function verifyMfaChallenge(input: {
	userId: string;
	sessionId: string;
	code: string;
	locale?: SupportedLocale;
}) {
	const verified = await verifyMfaCodeForUser(input.userId, input.code, input.locale);
	if (!verified) return false;

	await markMfaSessionVerified(input.userId, input.sessionId);
	return true;
}

export async function isMfaEnabled(userId: string) {
	const status = await getMfaStatus(userId);
	return status.enabled;
}

export async function isMfaSessionVerified(userId: string, sessionId: string) {
	await cleanupExpiredMfaSessions();

	const [row] = await db
		.select({ id: mfaSession.id })
		.from(mfaSession)
		.where(
			and(
				eq(mfaSession.userId, userId),
				eq(mfaSession.sessionId, sessionId),
				gt(mfaSession.expiresAt, new Date())
			)
		)
		.limit(1);

	return Boolean(row);
}

async function markMfaSessionVerified(userId: string, sessionId: string) {
	await cleanupExpiredMfaSessions();

	await db
		.insert(mfaSession)
		.values({
			userId,
			sessionId,
			expiresAt: new Date(Date.now() + mfaSessionTtlMs)
		})
		.onConflictDoUpdate({
			target: [mfaSession.userId, mfaSession.sessionId],
			set: {
				expiresAt: new Date(Date.now() + mfaSessionTtlMs)
			}
		});
}

async function verifyMfaCodeForUser(userId: string, code: string, locale: SupportedLocale = 'en') {
	const [config] = await db
		.select({
			encryptedSecret: userMfaConfig.encryptedSecret,
			recoveryCodeHashes: userMfaConfig.recoveryCodeHashes
		})
		.from(userMfaConfig)
		.where(eq(userMfaConfig.userId, userId))
		.limit(1);

	if (!config) return false;

	let decrypted: ReturnType<typeof decryptMfaSecret>;
	try {
		decrypted = decryptMfaSecret(config.encryptedSecret);
	} catch (decryptionError) {
		if (decryptionError instanceof MfaSecretDecryptionError)
			throw error(500, translate(locale, 'MFA configuration is invalid.'));
		throw decryptionError;
	}
	const replacementCiphertext = decrypted.needsReEncryption
		? encryptMfaSecret(decrypted.secret)
		: null;
	const secret = decrypted.secret;
	const totpResult = findAcceptedTotpCounter(secret, code);
	if (totpResult !== null) {
		// Atomically claim this counter: only succeeds when the row still has
		// last_used_totp_counter IS NULL or a smaller value, which prevents
		// replays within the acceptance window.
		const updated = await db
			.update(userMfaConfig)
			.set({
				lastUsedTotpCounter: totpResult,
				updatedAt: new Date(),
				...(replacementCiphertext ? { encryptedSecret: replacementCiphertext } : {})
			})
			.where(
				and(
					eq(userMfaConfig.userId, userId),
					replacementCiphertext
						? eq(userMfaConfig.encryptedSecret, config.encryptedSecret)
						: undefined,
					or(
						isNull(userMfaConfig.lastUsedTotpCounter),
						sql`${userMfaConfig.lastUsedTotpCounter} < ${totpResult}`
					)
				)
			)
			.returning({ userId: userMfaConfig.userId });
		return updated.length > 0;
	}

	const normalizedRecoveryCode = normalizeRecoveryCode(code);
	const recoveryHash = hashRecoveryCode(normalizedRecoveryCode);
	const matchedHash = config.recoveryCodeHashes.find((hash) => safeEqual(hash, recoveryHash));
	if (!matchedHash) return false;

	const updated = await db.execute<{ user_id: string }>(sql`
		update user_mfa_config
		set recovery_code_hashes = (
				select coalesce(jsonb_agg(code.value), '[]'::jsonb)
				from jsonb_array_elements_text(recovery_code_hashes) as code(value)
				where code.value <> ${matchedHash}
			),
				updated_at = now()
				${
					replacementCiphertext
						? sql`, encrypted_secret = case
							when encrypted_secret = ${config.encryptedSecret} then ${replacementCiphertext}
							else encrypted_secret
						end`
						: sql``
				}
		where user_id = ${userId}
			and recovery_code_hashes @> ${JSON.stringify([matchedHash])}::jsonb
		returning user_id
	`);

	return updated.length > 0;
}

/**
 * Find the TOTP counter value for the accepted code, or null if rejected.
 * Returns the counter so the caller can persist it for replay prevention.
 */
function findAcceptedTotpCounter(
	secret: string,
	code: string,
	timestamp = Date.now(),
	window = 1,
	stepSeconds = 30
): number | null {
	const normalized = code.replace(/\s/g, '');
	if (!/^\d{6}$/.test(normalized)) return null;

	for (let drift = -window; drift <= window; drift += 1) {
		const t = timestamp + drift * stepSeconds * 1000;
		const expected = generateTotpCode(secret, t, stepSeconds);
		if (expected === normalized) {
			return Math.floor(t / 1000 / stepSeconds);
		}
	}
	return null;
}

async function cleanupExpiredMfaSessions() {
	const now = Date.now();
	if (now - lastMfaSessionCleanupAt < cleanupIntervalMs) return;
	lastMfaSessionCleanupAt = now;
	await db
		.delete(mfaSession)
		.where(lte(mfaSession.expiresAt, new Date()))
		.catch(() => {});
}

function generateRecoveryCodes() {
	return Array.from({ length: 10 }, () => {
		const value = randomBytes(5).toString('hex').toUpperCase();
		return `${value.slice(0, 5)}-${value.slice(5, 10)}`;
	});
}

function normalizeRecoveryCode(code: string) {
	return code.trim().replace(/\s/g, '').toUpperCase();
}

function hashRecoveryCode(code: string) {
	return sha256(normalizeRecoveryCode(code));
}
