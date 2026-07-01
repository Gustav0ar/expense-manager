import { createHmac, randomBytes } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20) {
	return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer) {
	let bits = '';
	let output = '';

	for (const byte of buffer) {
		bits += byte.toString(2).padStart(8, '0');
	}

	for (let index = 0; index < bits.length; index += 5) {
		const chunk = bits.slice(index, index + 5).padEnd(5, '0');
		output += alphabet[Number.parseInt(chunk, 2)];
	}

	return output;
}

export function base32Decode(input: string) {
	const normalized = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
	let bits = '';

	for (const char of normalized) {
		const value = alphabet.indexOf(char);
		if (value === -1) throw new Error('TOTP secret is invalid.');
		bits += value.toString(2).padStart(5, '0');
	}

	const bytes: number[] = [];
	for (let index = 0; index + 8 <= bits.length; index += 8) {
		bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
	}

	return Buffer.from(bytes);
}

export function generateTotpCode(secret: string, timestamp = Date.now(), stepSeconds = 30) {
	const counter = Math.floor(timestamp / 1000 / stepSeconds);
	const counterBuffer = Buffer.alloc(8);
	counterBuffer.writeBigUInt64BE(BigInt(counter));

	const digest = createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const binary =
		((digest[offset] & 0x7f) << 24) |
		((digest[offset + 1] & 0xff) << 16) |
		((digest[offset + 2] & 0xff) << 8) |
		(digest[offset + 3] & 0xff);

	return String(binary % 1_000_000).padStart(6, '0');
}

export function verifyTotpCode(
	secret: string,
	code: string,
	options: { timestamp?: number; window?: number; stepSeconds?: number } = {}
) {
	const normalized = code.replace(/\s/g, '');
	if (!/^\d{6}$/.test(normalized)) return false;

	const timestamp = options.timestamp ?? Date.now();
	const window = options.window ?? 1;
	const stepSeconds = options.stepSeconds ?? 30;

	for (let drift = -window; drift <= window; drift += 1) {
		const expected = generateTotpCode(secret, timestamp + drift * stepSeconds * 1000, stepSeconds);
		if (expected === normalized) return true;
	}

	return false;
}

export function buildOtpAuthUri(input: { issuer: string; account: string; secret: string }) {
	const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
	const params = new URLSearchParams({
		secret: input.secret,
		issuer: input.issuer,
		algorithm: 'SHA1',
		digits: '6',
		period: '30'
	});

	return `otpauth://totp/${label}?${params.toString()}`;
}
