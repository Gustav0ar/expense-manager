import { describe, expect, it } from 'vitest';
import {
	base32Decode,
	base32Encode,
	buildOtpAuthUri,
	generateTotpCode,
	generateTotpSecret,
	verifyTotpCode
} from './totp';

describe('totp helpers', () => {
	it('round-trips base32 secrets', () => {
		const encoded = base32Encode(Buffer.from('hello world'));
		expect(base32Decode(encoded).toString('utf8')).toBe('hello world');
		expect(generateTotpSecret()).toMatch(/^[A-Z2-7]+$/);
	});

	it('generates and verifies six digit TOTP codes', () => {
		const secret = base32Encode(Buffer.from('public totp fixture'));
		const timestamp = Date.UTC(2026, 5, 27, 12, 0, 0);
		const code = generateTotpCode(secret, timestamp);

		expect(code).toMatch(/^\d{6}$/);
		expect(verifyTotpCode(secret, code, { timestamp, window: 0 })).toBe(true);
		expect(verifyTotpCode(secret, code, { timestamp: timestamp + 30_000, window: 1 })).toBe(true);
		expect(verifyTotpCode(secret, generateTotpCode(secret))).toBe(true);
		expect(verifyTotpCode(secret, '000000', { timestamp, window: 0 })).toBe(false);
		expect(verifyTotpCode(secret, 'abc', { timestamp })).toBe(false);
	});

	it('builds otpauth URIs for authenticator apps', () => {
		const uri = buildOtpAuthUri({
			issuer: 'Expense Manager',
			account: 'user@example.com',
			secret: base32Encode(Buffer.from('public totp fixture'))
		});

		expect(uri).toContain('otpauth://totp/Expense%20Manager:user%40example.com');
		expect(uri).toContain('digits=6');
	});
});
