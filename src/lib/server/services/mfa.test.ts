/**
 * Unit tests for MFA service — no real DB required.
 *
 * Key security properties tested:
 *   1. TOTP replay prevention: the same valid code cannot be accepted twice.
 *   2. Recovery-code single-use: a consumed code cannot be reused.
 *
 * Both properties are enforced by atomic DB UPDATE guards in verifyMfaCodeForUser.
 * We mock the DB to drive those code-paths deterministically without a live database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── hoisted mocks ──────────────────────────────────────────────────────────────

const dbMock = vi.hoisted(() => {
	// Mutable state for the fake mfa_config row.
	let row: {
		encryptedSecret: string;
		recoveryCodeHashes: string[];
		lastUsedTotpCounter: number | null;
	} | null = null;

	const resetRow = (r: typeof row) => {
		row = r;
	};

	// We only need to intercept the three query shapes used by verifyMfaCodeForUser:
	//   1. SELECT from userMfaConfig  (returns [row] or [])
	//   2. UPDATE to claim TOTP counter (returns [{userId}] when counter < new, else [])
	//   3. db.execute() for recovery-code removal (returns [{user_id}] when hash found, else [])
	//
	// Drizzle chains look like: db.select(...).from(...).where(...).limit(1)
	// We intercept at the thenable end of the chain.

	const selectChain = () => ({
		from: () => ({
			where: () => ({
				limit: async () => (row ? [{ ...row }] : [])
			})
		})
	});

	const updateChain = (shouldSucceed: () => boolean) => ({
		set: () => ({
			where: () => ({
				returning: async () => {
					if (!row || !shouldSucceed()) return [];
					return [{ userId: 'user-1' }];
				}
			})
		})
	});

	const deleteChain = () => ({
		where: () => ({
			catch: (_fn: (e: unknown) => unknown) => Promise.resolve()
		})
	});

	const dbObj = {
		_resetRow: resetRow,
		_getRow: () => row,

		select: () => selectChain(),
		update: () => updateChain(() => true), // default: always succeeds
		delete: () => deleteChain(),
		execute: async () => [],

		// Separate handles so tests can customise per-call behaviour.
		__totpUpdateSucceeds: true,
		__recoveryUpdateSucceeds: true
	};

	return dbObj;
});

vi.mock('$lib/server/db', () => ({ db: dbMock }));

vi.mock('$app/environment', () => ({
	browser: false,
	building: false,
	dev: false,
	version: 'test'
}));

vi.mock('$env/dynamic/private', () => ({
	env: { BETTER_AUTH_SECRET: 'test-secret-at-least-32-bytes-long!' }
}));

// ── imports (after mocks are hoisted) ─────────────────────────────────────────

import { createHash, randomBytes } from 'node:crypto';
import { createCipheriv } from 'node:crypto';
import { generateTotpCode, generateTotpSecret } from '$lib/server/utils/totp';
import { sha256 } from '$lib/server/utils/crypto';
import { verifyMfaChallenge } from './mfa';

// ── helpers ────────────────────────────────────────────────────────────────────

function encryptionKey() {
	return createHash('sha256').update('test-secret-at-least-32-bytes-long!').digest();
}

function encryptSecret(secret: string): string {
	const key = encryptionKey();
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

function hashRecoveryCode(code: string): string {
	return sha256(code.trim().replace(/\s/g, '').toUpperCase());
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('MFA verifyMfaChallenge — TOTP replay prevention', () => {
	const secret = generateTotpSecret();
	const userId = 'user-totp-replay';
	const sessionId = 'session-1';
	const now = Date.now();
	// Pin to a known counter step so the code is stable for the whole test.
	const stepSeconds = 30;
	const counter = Math.floor(now / 1000 / stepSeconds);
	const code = generateTotpCode(secret, now, stepSeconds);

	beforeEach(() => {
		// Reset DB mock state before each test.
		vi.restoreAllMocks();

		dbMock._resetRow({
			encryptedSecret: encryptSecret(secret),
			recoveryCodeHashes: [],
			lastUsedTotpCounter: null
		});

		// Override db.update to simulate the atomic counter-claim behaviour:
		// first call succeeds (counter was null/smaller), second call fails
		// (counter is now equal, so `lastUsedTotpCounter < counter` is false).
		let updateCallCount = 0;
		vi.spyOn(dbMock, 'update').mockImplementation(
			() =>
				({
					set: () => ({
						where: () => ({
							returning: async () => {
								updateCallCount += 1;
								// First claim succeeds; subsequent claims for the same counter fail.
								return updateCallCount === 1 ? [{ userId }] : [];
							}
						})
					})
				}) as ReturnType<typeof dbMock.update>
		);

		// markMfaSessionVerified calls db.insert — stub it out.
		(dbMock as unknown as Record<string, unknown>).insert = () => ({
			values: () => ({
				onConflictDoUpdate: () => ({
					then: async (fn: (v: unknown) => unknown) => fn(undefined)
				}),
				[Symbol.toStringTag]: 'Promise',
				then: async (fn: (v: unknown) => unknown) => fn(undefined),
				catch: () => ({ then: async (fn: (v: unknown) => unknown) => fn(undefined) })
			})
		});
	});

	it('accepts a valid TOTP code on first use', async () => {
		const accepted = await verifyMfaChallenge({ userId, sessionId, code });
		expect(accepted).toBe(true);
	});

	it('rejects the same TOTP code submitted a second time (replay prevention)', async () => {
		// First submission — must succeed.
		const first = await verifyMfaChallenge({ userId, sessionId: 'session-a', code });
		expect(first).toBe(true);

		// Second submission with the identical code — must be rejected.
		const second = await verifyMfaChallenge({ userId, sessionId: 'session-b', code });
		expect(second).toBe(false);
	});
});

describe('MFA verifyMfaChallenge — recovery-code single-use', () => {
	const plainCode = 'AABB1-CC2DD';
	const codeHash = hashRecoveryCode(plainCode);
	const userId = 'user-recovery';
	const sessionId = 'session-r';

	beforeEach(() => {
		vi.restoreAllMocks();

		dbMock._resetRow({
			encryptedSecret: encryptSecret(generateTotpSecret()),
			recoveryCodeHashes: [codeHash],
			lastUsedTotpCounter: null
		});

		// TOTP check will fail (wrong code format triggers early return), so the
		// recovery-code branch runs. Mock db.update to return [] (counter claim
		// irrelevant here — TOTP won't match a recovery code string).
		vi.spyOn(dbMock, 'update').mockImplementation(
			() =>
				({
					set: () => ({ where: () => ({ returning: async () => [] }) })
				}) as ReturnType<typeof dbMock.update>
		);

		// db.execute drives the recovery-code removal. First call: hash is present →
		// remove it and return a row. Second call: hash is gone → return [].
		let executeCallCount = 0;
		(dbMock as unknown as Record<string, unknown>).execute = async () => {
			executeCallCount += 1;
			if (executeCallCount === 1) {
				// Simulate successful removal.
				const row = dbMock._getRow();
				if (row) row.recoveryCodeHashes = [];
				return [{ user_id: userId }];
			}
			return [];
		};

		// Stub insert for markMfaSessionVerified.
		(dbMock as unknown as Record<string, unknown>).insert = () => ({
			values: () => ({
				onConflictDoUpdate: () => ({
					then: async (fn: (v: unknown) => unknown) => fn(undefined)
				}),
				[Symbol.toStringTag]: 'Promise',
				then: async (fn: (v: unknown) => unknown) => fn(undefined),
				catch: () => ({ then: async (fn: (v: unknown) => unknown) => fn(undefined) })
			})
		});
	});

	it('accepts a valid recovery code on first use', async () => {
		const accepted = await verifyMfaChallenge({ userId, sessionId, code: plainCode });
		expect(accepted).toBe(true);
	});

	it('rejects the same recovery code on second use (single-use enforcement)', async () => {
		// First use — accepted.
		const first = await verifyMfaChallenge({ userId, sessionId: 'session-r1', code: plainCode });
		expect(first).toBe(true);

		// Second use of the same code — rejected.
		const second = await verifyMfaChallenge({
			userId,
			sessionId: 'session-r2',
			code: plainCode
		});
		expect(second).toBe(false);
	});
});
