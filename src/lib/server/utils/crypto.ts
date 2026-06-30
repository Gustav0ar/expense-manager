import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32) {
	return randomBytes(bytes).toString('base64url');
}

export function sha256(input: string) {
	return createHash('sha256').update(input).digest('hex');
}

export function safeEqual(a: string, b: string) {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}
