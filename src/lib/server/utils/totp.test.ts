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
		const secret = 'JBSWY3DPEHPK3PXP';
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
			secret: 'JBSWY3DPEHPK3PXP'
		});

		expect(uri).toContain('otpauth://totp/Expense%20Manager:user%40example.com');
		expect(uri).toContain('digits=6');
	});
});

describe('TOTP counter derivation (replay prevention contract)', () => {
	const secret = 'JBSWY3DPEHPK3PXP';

	it('produces the same code for all timestamps within a 30-second step', () => {
		const base = Date.UTC(2026, 5, 27, 12, 0, 0); // exact step boundary
		const code0 = generateTotpCode(secret, base);
		expect(generateTotpCode(secret, base + 1_000)).toBe(code0);
		expect(generateTotpCode(secret, base + 29_000)).toBe(code0);
	});

	it('rejects a code from 2 steps ago (outside window=1)', () => {
		const timestamp = Date.UTC(2026, 5, 27, 12, 0, 0);
		const oldCode = generateTotpCode(secret, timestamp - 60_000); // 2 steps back
		expect(verifyTotpCode(secret, oldCode, { timestamp, window: 1 })).toBe(false);
	});

	it('accepts a code from 1 step ago (within window=1)', () => {
		const timestamp = Date.UTC(2026, 5, 27, 12, 0, 0);
		const prevCode = generateTotpCode(secret, timestamp - 30_000);
		expect(verifyTotpCode(secret, prevCode, { timestamp, window: 1 })).toBe(true);
	});

	it('accepts a code from 1 step ahead (within window=1)', () => {
		const timestamp = Date.UTC(2026, 5, 27, 12, 0, 0);
		const nextCode = generateTotpCode(secret, timestamp + 30_000);
		expect(verifyTotpCode(secret, nextCode, { timestamp, window: 1 })).toBe(true);
	});

	it('strips whitespace before verifying', () => {
		const timestamp = Date.UTC(2026, 5, 27, 12, 0, 0);
		const code = generateTotpCode(secret, timestamp);
		expect(verifyTotpCode(secret, ` ${code} `, { timestamp, window: 0 })).toBe(true);
	});

	it('rejects non-digit codes', () => {
		const timestamp = Date.UTC(2026, 5, 27, 12, 0, 0);
		expect(verifyTotpCode(secret, 'abcdef', { timestamp })).toBe(false);
		expect(verifyTotpCode(secret, '12345', { timestamp })).toBe(false); // 5 digits
		expect(verifyTotpCode(secret, '1234567', { timestamp })).toBe(false); // 7 digits
	});
});
