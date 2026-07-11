import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { getPrivateSecret } from '$lib/server/config';
import { sha256 } from '$lib/server/utils/crypto';

const cipherVersion = 'v1';
const keyLength = 32;
const nonceLength = 12;
const authTagLength = 16;
const hkdfSalt = Buffer.from('expense-manager:invitation-outbox', 'utf8');
const hkdfInfo = Buffer.from(`workspace-invitation-token:${cipherVersion}`, 'utf8');

export class InvitationTokenDecryptionError extends Error {
	constructor() {
		super('Invitation token ciphertext could not be authenticated.');
		this.name = 'InvitationTokenDecryptionError';
	}
}

export function encryptInvitationToken(
	token: string,
	tokenHash: string,
	secret = currentApplicationSecret()
) {
	const nonce = randomBytes(nonceLength);
	const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), nonce, {
		authTagLength
	});
	cipher.setAAD(associatedData(tokenHash));
	const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
	const authTag = cipher.getAuthTag();

	return [
		cipherVersion,
		nonce.toString('base64url'),
		ciphertext.toString('base64url'),
		authTag.toString('base64url')
	].join('.');
}

export function decryptInvitationToken(
	encryptedToken: string,
	tokenHash: string,
	secrets = applicationSecretKeyring()
) {
	const parts = encryptedToken.split('.');
	if (parts.length !== 4 || parts[0] !== cipherVersion || secrets.length === 0) {
		throw new InvitationTokenDecryptionError();
	}

	const nonce = decodePart(parts[1], nonceLength);
	const ciphertext = decodePart(parts[2]);
	const authTag = decodePart(parts[3], authTagLength);
	if (!nonce || !ciphertext || !authTag) throw new InvitationTokenDecryptionError();

	for (const secret of secrets) {
		try {
			const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), nonce, {
				authTagLength
			});
			decipher.setAAD(associatedData(tokenHash));
			decipher.setAuthTag(authTag);
			const token = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
			if (sha256(token) === tokenHash) return token;
		} catch {
			// Try the next retained application secret. Authentication failures are
			// intentionally collapsed into one secret-free error below.
		}
	}

	throw new InvitationTokenDecryptionError();
}

export function applicationSecretKeyring() {
	const current = currentApplicationSecret();
	const previous = (getPrivateSecret('BETTER_AUTH_SECRET_PREVIOUS') ?? '')
		.split(',')
		.map((value) => value.trim())
		.filter(Boolean);
	return [...new Set([current, ...previous])];
}

function currentApplicationSecret() {
	const secret = getPrivateSecret('BETTER_AUTH_SECRET');
	if (!secret) throw new Error('BETTER_AUTH_SECRET is not configured.');
	return secret;
}

function deriveKey(secret: string) {
	return Buffer.from(
		hkdfSync('sha256', Buffer.from(secret, 'utf8'), hkdfSalt, hkdfInfo, keyLength)
	);
}

function associatedData(tokenHash: string) {
	return Buffer.from(`${cipherVersion}\0${tokenHash}`, 'utf8');
}

function decodePart(value: string, expectedLength?: number) {
	try {
		const decoded = Buffer.from(value, 'base64url');
		if (expectedLength != null && decoded.length !== expectedLength) return null;
		return decoded;
	} catch {
		return null;
	}
}
