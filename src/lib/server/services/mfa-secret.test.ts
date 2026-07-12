import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptMfaSecret, encryptMfaSecret, MfaSecretDecryptionError } from './mfa-secret';

describe('MFA secret encryption', () => {
	const currentApplicationSecret = 'current-application-secret-at-least-32-bytes';
	const previousApplicationSecret = 'previous-application-secret-at-least-32-bytes';
	const totpSecret = 'JBSWY3DPEHPK3PXP';

	it('round-trips a domain-separated current ciphertext without plaintext disclosure', () => {
		const encrypted = encryptMfaSecret(totpSecret, currentApplicationSecret);

		expect(encrypted).toMatch(/^v2:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
		expect(encrypted).not.toContain(totpSecret);
		expect(decryptMfaSecret(encrypted, [currentApplicationSecret])).toEqual({
			secret: totpSecret,
			needsReEncryption: false
		});
	});

	it('decrypts a retained-key ciphertext and marks it for safe re-encryption', () => {
		const encrypted = encryptMfaSecret(totpSecret, previousApplicationSecret);
		const decrypted = decryptMfaSecret(encrypted, [
			currentApplicationSecret,
			previousApplicationSecret
		]);
		const reEncrypted = encryptMfaSecret(decrypted.secret, currentApplicationSecret);

		expect(decrypted.needsReEncryption).toBe(true);
		expect(decryptMfaSecret(reEncrypted, [currentApplicationSecret])).toEqual({
			secret: totpSecret,
			needsReEncryption: false
		});
		expect(() => decryptMfaSecret(encrypted, [currentApplicationSecret])).toThrow(
			MfaSecretDecryptionError
		);
	});

	it('reads legacy v1 ciphertext with a retained key without a destructive migration', () => {
		const legacy = encryptLegacyMfaSecret(totpSecret, previousApplicationSecret);

		expect(decryptMfaSecret(legacy, [currentApplicationSecret, previousApplicationSecret])).toEqual(
			{ secret: totpSecret, needsReEncryption: true }
		);
	});

	it('rejects malformed, tampered and unrelated-key ciphertext without leaking material', () => {
		const encrypted = encryptMfaSecret(totpSecret, currentApplicationSecret);
		const parts = encrypted.split(':');
		const ciphertext = Buffer.from(parts[3], 'base64url');
		ciphertext[0] ^= 1;
		const tampered = [...parts.slice(0, 3), ciphertext.toString('base64url')].join(':');

		for (const value of ['v2:incomplete', tampered]) {
			try {
				decryptMfaSecret(value, ['unrelated-application-secret-at-least-32-bytes']);
				expect.unreachable('decryption should fail');
			} catch (error) {
				expect(error).toBeInstanceOf(MfaSecretDecryptionError);
				expect(String(error)).not.toContain(totpSecret);
				expect(String(error)).not.toContain(encrypted);
			}
		}
	});
});

function encryptLegacyMfaSecret(secret: string, applicationSecret: string) {
	const nonce = randomBytes(12);
	const key = createHash('sha256').update(applicationSecret).digest();
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
	return [
		'v1',
		nonce.toString('base64url'),
		cipher.getAuthTag().toString('base64url'),
		ciphertext.toString('base64url')
	].join(':');
}
