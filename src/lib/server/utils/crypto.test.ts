import { describe, expect, it } from 'vitest';
import { randomToken, safeEqual, sha256 } from './crypto';

describe('crypto helpers', () => {
	it('creates URL-safe random tokens', () => {
		const token = randomToken(16);

		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(token.length).toBeGreaterThanOrEqual(20);
		expect(randomToken(16)).not.toBe(token);
	});

	it('hashes values with sha256', () => {
		expect(sha256('expense-manager')).toBe(
			'd339519b1e0a62528c0bfbb2caf8806b21c1c2f300b1b47206d2f3fbfd3ed1df'
		);
	});

	it('compares strings safely without leaking length mismatches', () => {
		expect(safeEqual('same-value', 'same-value')).toBe(true);
		expect(safeEqual('same-value', 'other-value')).toBe(false);
		expect(safeEqual('short', 'a much longer value')).toBe(false);
	});
});
