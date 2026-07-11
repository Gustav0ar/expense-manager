import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { sha256 } from '$lib/server/utils/crypto';
import {
	applicationSecretKeyring,
	decryptInvitationToken,
	encryptInvitationToken,
	InvitationTokenDecryptionError
} from './invitation-token';

describe('invitation token encryption', () => {
	const currentSecret = 'current-application-secret-at-least-32-bytes';
	const previousSecret = 'previous-application-secret-at-least-32-bytes';
	const token = 'raw-invitation-token-that-must-never-be-persisted';
	const tokenHash = sha256(token);

	it('round-trips an authenticated token without storing plaintext', () => {
		const encrypted = encryptInvitationToken(token, tokenHash, currentSecret);

		expect(encrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		expect(encrypted).not.toContain(token);
		expect(decryptInvitationToken(encrypted, tokenHash, [currentSecret])).toBe(token);
	});

	it('binds ciphertext to its token hash and rejects tampering', () => {
		const encrypted = encryptInvitationToken(token, tokenHash, currentSecret);
		const parts = encrypted.split('.');
		const ciphertext = Buffer.from(parts[2], 'base64url');
		ciphertext[0] ^= 1;
		const tampered = [parts[0], parts[1], ciphertext.toString('base64url'), parts[3]].join('.');

		expect(() => decryptInvitationToken(encrypted, sha256('different'), [currentSecret])).toThrow(
			InvitationTokenDecryptionError
		);
		expect(() => decryptInvitationToken(tampered, tokenHash, [currentSecret])).toThrow(
			InvitationTokenDecryptionError
		);
	});

	it('supports a bounded application-secret rotation window', () => {
		const encrypted = encryptInvitationToken(token, tokenHash, previousSecret);

		expect(decryptInvitationToken(encrypted, tokenHash, [currentSecret, previousSecret])).toBe(
			token
		);
		expect(() => decryptInvitationToken(encrypted, tokenHash, [currentSecret])).toThrow(
			InvitationTokenDecryptionError
		);
	});

	it('never includes ciphertext or token material in authentication errors', () => {
		const encrypted = encryptInvitationToken(token, tokenHash, currentSecret);

		try {
			decryptInvitationToken(encrypted, tokenHash, ['wrong-secret-at-least-32-bytes-long']);
			expect.unreachable('decryption should fail');
		} catch (error) {
			expect(String(error)).not.toContain(token);
			expect(String(error)).not.toContain(encrypted);
		}
	});

	it('rejects unsupported, incomplete and structurally invalid ciphertext', () => {
		const encrypted = encryptInvitationToken(token, tokenHash, currentSecret);
		const parts = encrypted.split('.');

		expect(() => decryptInvitationToken('v1.incomplete', tokenHash, [currentSecret])).toThrow(
			InvitationTokenDecryptionError
		);
		expect(() =>
			decryptInvitationToken(['v2', ...parts.slice(1)].join('.'), tokenHash, [currentSecret])
		).toThrow(InvitationTokenDecryptionError);
		expect(() => decryptInvitationToken(encrypted, tokenHash, [])).toThrow(
			InvitationTokenDecryptionError
		);
		expect(() =>
			decryptInvitationToken([parts[0], 'AA', parts[2], parts[3]].join('.'), tokenHash, [
				currentSecret
			])
		).toThrow(InvitationTokenDecryptionError);
	});

	it('deduplicates retained application secrets during rotation', () => {
		const previous = process.env.BETTER_AUTH_SECRET_PREVIOUS;
		process.env.BETTER_AUTH_SECRET_PREVIOUS = `${previousSecret}, ${previousSecret}, older-secret`;
		try {
			const keyring = applicationSecretKeyring();
			expect(keyring.slice(1)).toEqual([previousSecret, 'older-secret']);
		} finally {
			if (previous === undefined) delete process.env.BETTER_AUTH_SECRET_PREVIOUS;
			else process.env.BETTER_AUTH_SECRET_PREVIOUS = previous;
		}
	});

	it('loads retained application secrets from the Compose secret file', () => {
		const directory = mkdtempSync(join(tmpdir(), 'invitation-keyring-'));
		const secretFile = join(directory, 'previous');
		const previousFile = process.env.BETTER_AUTH_SECRET_PREVIOUS_FILE;
		const previousDirect = process.env.BETTER_AUTH_SECRET_PREVIOUS;
		writeFileSync(secretFile, `${previousSecret},older-file-secret\n`);
		process.env.BETTER_AUTH_SECRET_PREVIOUS_FILE = secretFile;
		delete process.env.BETTER_AUTH_SECRET_PREVIOUS;

		try {
			expect(applicationSecretKeyring().slice(1)).toEqual([previousSecret, 'older-file-secret']);
		} finally {
			if (previousFile === undefined) delete process.env.BETTER_AUTH_SECRET_PREVIOUS_FILE;
			else process.env.BETTER_AUTH_SECRET_PREVIOUS_FILE = previousFile;
			if (previousDirect === undefined) delete process.env.BETTER_AUTH_SECRET_PREVIOUS;
			else process.env.BETTER_AUTH_SECRET_PREVIOUS = previousDirect;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
