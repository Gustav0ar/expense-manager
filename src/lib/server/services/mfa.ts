import { error } from '@sveltejs/kit';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { auditEvent, mfaSession, userMfaConfig } from '$lib/server/db/schema';
import { safeEqual, sha256 } from '$lib/server/utils/crypto';
import { buildOtpAuthUri, generateTotpSecret, verifyTotpCode } from '$lib/server/utils/totp';

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
			issuer: env.PUBLIC_APP_NAME || 'Expense Manager',
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
}) {
	if (!verifyTotpCode(input.secret, input.code)) throw error(400, 'Codigo MFA inválido.');

	const recoveryCodes = generateRecoveryCodes();
	const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);

	await db.transaction(async (tx) => {
		await tx
			.insert(userMfaConfig)
			.values({
				userId: input.userId,
				encryptedSecret: encryptSecret(input.secret),
				recoveryCodeHashes
			})
			.onConflictDoUpdate({
				target: userMfaConfig.userId,
				set: {
					encryptedSecret: encryptSecret(input.secret),
					recoveryCodeHashes,
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

export async function disableMfa(input: { userId: string; code: string }) {
	const verified = await verifyMfaCodeForUser(input.userId, input.code);
	if (!verified) throw error(400, 'Codigo MFA inválido.');

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
}) {
	const verified = await verifyMfaCodeForUser(input.userId, input.code);
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

async function verifyMfaCodeForUser(userId: string, code: string) {
	const [config] = await db
		.select({
			encryptedSecret: userMfaConfig.encryptedSecret,
			recoveryCodeHashes: userMfaConfig.recoveryCodeHashes
		})
		.from(userMfaConfig)
		.where(eq(userMfaConfig.userId, userId))
		.limit(1);

	if (!config) return false;

	const secret = decryptSecret(config.encryptedSecret);
	if (verifyTotpCode(secret, code)) return true;

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
		where user_id = ${userId}
			and recovery_code_hashes @> ${JSON.stringify([matchedHash])}::jsonb
		returning user_id
	`);

	return updated.length > 0;
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

function encryptSecret(secret: string) {
	const key = encryptionKey();
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

function decryptSecret(payload: string) {
	const [version, ivValue, tagValue, encryptedValue] = payload.split(':');
	if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) {
		throw error(500, 'Configuração MFA invalida.');
	}

	const decipher = createDecipheriv(
		'aes-256-gcm',
		encryptionKey(),
		Buffer.from(ivValue, 'base64url')
	);
	decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
	return Buffer.concat([
		decipher.update(Buffer.from(encryptedValue, 'base64url')),
		decipher.final()
	]).toString('utf8');
}

function encryptionKey() {
	if (!env.BETTER_AUTH_SECRET) throw error(500, 'BETTER_AUTH_SECRET não configurado.');
	return createHash('sha256').update(env.BETTER_AUTH_SECRET).digest();
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
