import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { applicationSecretKeyring } from './invitation-token';

const currentCipherVersion = 'v2';
const legacyCipherVersion = 'v1';
const keyLength = 32;
const nonceLength = 12;
const authTagLength = 16;
const hkdfSalt = Buffer.from('expense-manager:mfa-secret', 'utf8');
const hkdfInfo = Buffer.from(`totp-seed:${currentCipherVersion}`, 'utf8');
const associatedData = Buffer.from(currentCipherVersion, 'utf8');

export class MfaSecretDecryptionError extends Error {
	constructor() {
		super('MFA secret ciphertext could not be authenticated.');
		this.name = 'MfaSecretDecryptionError';
	}
}

export function encryptMfaSecret(
	secret: string,
	applicationSecret = applicationSecretKeyring()[0]
) {
	if (!applicationSecret) throw new MfaSecretDecryptionError();
	const nonce = randomBytes(nonceLength);
	const cipher = createCipheriv('aes-256-gcm', deriveKey(applicationSecret), nonce, {
		authTagLength
	});
	cipher.setAAD(associatedData);
	const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();
	return [
		currentCipherVersion,
		nonce.toString('base64url'),
		authTag.toString('base64url'),
		ciphertext.toString('base64url')
	].join(':');
}

export function decryptMfaSecret(
	payload: string,
	applicationSecrets = applicationSecretKeyring()
): { secret: string; needsReEncryption: boolean } {
	const [version, nonceValue, authTagValue, ciphertextValue, ...extra] = payload.split(':');
	if (
		extra.length > 0 ||
		(version !== currentCipherVersion && version !== legacyCipherVersion) ||
		applicationSecrets.length === 0
	) {
		throw new MfaSecretDecryptionError();
	}

	const nonce = decodePart(nonceValue, nonceLength);
	const authTag = decodePart(authTagValue, authTagLength);
	const ciphertext = decodePart(ciphertextValue);
	if (!nonce || !authTag || !ciphertext) throw new MfaSecretDecryptionError();

	for (const [index, applicationSecret] of applicationSecrets.entries()) {
		try {
			const decipher = createDecipheriv(
				'aes-256-gcm',
				version === currentCipherVersion
					? deriveKey(applicationSecret)
					: legacyKey(applicationSecret),
				nonce,
				{ authTagLength }
			);
			if (version === currentCipherVersion) decipher.setAAD(associatedData);
			decipher.setAuthTag(authTag);
			const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
				'utf8'
			);
			return {
				secret,
				needsReEncryption: version !== currentCipherVersion || index !== 0
			};
		} catch {
			// Try the next retained application secret. Authentication failures are
			// intentionally collapsed into one secret-free error below.
		}
	}

	throw new MfaSecretDecryptionError();
}

function deriveKey(applicationSecret: string) {
	return Buffer.from(
		hkdfSync('sha256', Buffer.from(applicationSecret, 'utf8'), hkdfSalt, hkdfInfo, keyLength)
	);
}

function legacyKey(applicationSecret: string) {
	return createHash('sha256').update(applicationSecret).digest();
}

function decodePart(value: string | undefined, expectedLength?: number) {
	if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
	const decoded = Buffer.from(value, 'base64url');
	if (decoded.toString('base64url') !== value) return null;
	if (expectedLength != null && decoded.length !== expectedLength) return null;
	return decoded;
}
