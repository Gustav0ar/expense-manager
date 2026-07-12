import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { session, user } from '$lib/server/db/auth.schema';
import { userMfaConfig } from '$lib/server/db/schema';
import { db } from '$lib/server/db';
import { generateTotpCode } from '$lib/server/utils/totp';
import { decryptMfaSecret, encryptMfaSecret } from './mfa-secret';
import {
	beginMfaSetup,
	disableMfa,
	enableMfa,
	getMfaStatus,
	isMfaEnabled,
	isMfaSessionVerified,
	verifyMfaChallenge
} from './mfa';

const userIds: string[] = [];

describe('MFA persistence integration', () => {
	afterEach(async () => {
		for (const userId of userIds.splice(0)) {
			await db.delete(user).where(eq(user.id, userId));
		}
	});

	it('enables MFA, persists verified sessions, consumes recovery codes and disables MFA', async () => {
		const account = await createUser('mfa-lifecycle');
		expect(await getMfaStatus(account.id)).toEqual({
			enabled: false,
			enabledAt: null,
			recoveryCodesRemaining: 0
		});
		expect(await isMfaEnabled(account.id)).toBe(false);

		const setup = await beginMfaSetup({ email: account.email });
		expect(setup.secret).toMatch(/^[A-Z2-7]+$/);
		expect(setup.otpAuthUri).toContain(encodeURIComponent(account.email));
		const enrollmentCode = generateTotpCode(setup.secret);
		await createSession(account.id, 'enrollment-session');
		await createSession(account.id, 'recovery-session');
		const enabled = await enableMfa({
			userId: account.id,
			email: account.email,
			secret: setup.secret,
			code: enrollmentCode,
			sessionId: 'enrollment-session'
		});
		expect(enabled.recoveryCodes).toHaveLength(10);
		expect(await getMfaStatus(account.id)).toMatchObject({
			enabled: true,
			enabledAt: expect.any(Date),
			recoveryCodesRemaining: 10
		});
		expect(await isMfaSessionVerified(account.id, 'enrollment-session')).toBe(true);
		expect(await isMfaSessionVerified(account.id, 'unknown-session')).toBe(false);

		// The enrollment TOTP counter is already claimed, so an immediate replay is rejected.
		await expect(
			verifyMfaChallenge({
				userId: account.id,
				sessionId: 'replay-session',
				code: enrollmentCode
			})
		).resolves.toBe(false);
		await expect(
			verifyMfaChallenge({
				userId: account.id,
				sessionId: 'recovery-session',
				code: ` ${enabled.recoveryCodes[0].toLowerCase()} `
			})
		).resolves.toBe(true);
		expect(await getMfaStatus(account.id)).toMatchObject({ recoveryCodesRemaining: 9 });
		expect(await isMfaSessionVerified(account.id, 'recovery-session')).toBe(true);

		await expect(
			disableMfa({ userId: account.id, code: enabled.recoveryCodes[1] })
		).resolves.toBeUndefined();
		expect(await isMfaEnabled(account.id)).toBe(false);
		expect(await isMfaSessionVerified(account.id, 'recovery-session')).toBe(false);
	});

	it('rejects challenges without a configuration and reports corrupt encrypted state safely', async () => {
		const account = await createUser('mfa-invalid');
		await expect(
			verifyMfaChallenge({ userId: account.id, sessionId: 'none', code: '123456' })
		).resolves.toBe(false);
		await expect(disableMfa({ userId: account.id, code: '123456' })).rejects.toMatchObject({
			status: 400
		});

		await db.insert(userMfaConfig).values({
			userId: account.id,
			encryptedSecret: 'not-a-valid-payload',
			recoveryCodeHashes: []
		});
		await expect(
			verifyMfaChallenge({ userId: account.id, sessionId: 'bad', code: '123456' })
		).rejects.toMatchObject({ status: 500, body: { message: 'MFA configuration is invalid.' } });
	});

	it('re-encrypts a retained-key secret only after a successful challenge', async () => {
		const account = await createUser('mfa-secret-rotation');
		const sessionId = `rotation-${randomUUID()}`;
		await createSession(account.id, sessionId);
		const oldApplicationSecret = 'old-mfa-application-secret-at-least-32-bytes';
		const currentApplicationSecret = process.env.BETTER_AUTH_SECRET;
		if (!currentApplicationSecret) throw new Error('BETTER_AUTH_SECRET is required for this test.');
		const totpSecret = (await beginMfaSetup({ email: account.email })).secret;
		const oldCiphertext = encryptMfaSecret(totpSecret, oldApplicationSecret);
		await db.insert(userMfaConfig).values({
			userId: account.id,
			encryptedSecret: oldCiphertext,
			recoveryCodeHashes: []
		});

		const previous = process.env.BETTER_AUTH_SECRET_PREVIOUS;
		process.env.BETTER_AUTH_SECRET_PREVIOUS = oldApplicationSecret;
		try {
			await expect(
				verifyMfaChallenge({ userId: account.id, sessionId, code: 'invalid' })
			).resolves.toBe(false);
			const [unchanged] = await db
				.select({ encryptedSecret: userMfaConfig.encryptedSecret })
				.from(userMfaConfig)
				.where(eq(userMfaConfig.userId, account.id));
			expect(unchanged.encryptedSecret).toBe(oldCiphertext);

			await expect(
				verifyMfaChallenge({
					userId: account.id,
					sessionId,
					code: generateTotpCode(totpSecret)
				})
			).resolves.toBe(true);
			const [rewrapped] = await db
				.select({ encryptedSecret: userMfaConfig.encryptedSecret })
				.from(userMfaConfig)
				.where(eq(userMfaConfig.userId, account.id));
			expect(rewrapped.encryptedSecret).not.toBe(oldCiphertext);
			expect(decryptMfaSecret(rewrapped.encryptedSecret, [currentApplicationSecret])).toEqual({
				secret: totpSecret,
				needsReEncryption: false
			});
		} finally {
			if (previous === undefined) delete process.env.BETTER_AUTH_SECRET_PREVIOUS;
			else process.env.BETTER_AUTH_SECRET_PREVIOUS = previous;
		}
	});
});

async function createUser(prefix: string) {
	const id = `${prefix}-${randomUUID()}`;
	const email = `${id}@example.com`;
	await db.insert(user).values({ id, name: prefix, email, emailVerified: true });
	userIds.push(id);
	return { id, email };
}

async function createSession(userId: string, id: string) {
	await db.insert(session).values({
		id,
		userId,
		token: `${id}-${randomUUID()}`,
		expiresAt: new Date(Date.now() + 86_400_000),
		updatedAt: new Date()
	});
}
