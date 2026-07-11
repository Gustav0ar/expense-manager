import { describe, expect, it } from 'vitest';
import {
	amountExceedsMaximumMessage,
	formatCents,
	maxMoneyCents,
	parseBrlToCents,
	parseCurrencyToCents
} from './money';

describe('parseBrlToCents', () => {
	it('parses Brazilian currency formats', () => {
		expect(parseBrlToCents('10')).toBe(1000);
		expect(parseBrlToCents('10,50')).toBe(1050);
		expect(parseBrlToCents('10.50')).toBe(1050);
		expect(parseBrlToCents('R$ 1.234')).toBe(123400);
		expect(parseBrlToCents('R$ 1.234,56')).toBe(123456);
	});

	it('rejects invalid and non-positive values', () => {
		expect(() => parseBrlToCents('')).toThrow('Amount is required.');
		expect(() => parseBrlToCents('0')).toThrow();
		expect(() => parseBrlToCents('-1')).toThrow();
		expect(() => parseBrlToCents('abc')).toThrow();
	});

	it('parses English currency formats', () => {
		expect(parseCurrencyToCents('$1,234.56')).toBe(123456);
		expect(parseCurrencyToCents('1234.56')).toBe(123456);
	});

	it('formats cents as currency', () => {
		expect(formatCents(123456)).toBe('$1,234.56');
		// Intl.NumberFormat may emit a narrow no-break space (U+202F) as the
		// thousands separator in pt-BR. Normalize before comparing.
		expect(formatCents(123456, 'BRL', 'pt-BR').replace(/\s/g, ' ')).toContain('1.234,56');
	});
});

describe('parseCurrencyToCents – integer arithmetic (no float drift)', () => {
	it('accepts the exact product maximum in supported locale formats', () => {
		expect(parseCurrencyToCents('1,000,000,000.00')).toBe(maxMoneyCents);
		expect(parseCurrencyToCents('1.000.000.000,00')).toBe(maxMoneyCents);
		expect(parseCurrencyToCents('000001000000000.00')).toBe(maxMoneyCents);
		expect(Number.isSafeInteger(maxMoneyCents)).toBe(true);
	});

	it('rejects one cent above the product maximum and arbitrarily large digit strings', () => {
		for (const value of ['1,000,000,000.01', '1.000.000.000,01', '9'.repeat(10_000)]) {
			expect(() => parseCurrencyToCents(value)).toThrow(amountExceedsMaximumMessage);
		}
	});

	it('parses two-decimal amounts without rounding errors', () => {
		// These specific values are known to be well-behaved under integer parsing.
		// The old Math.round(n * 100) code was susceptible to IEEE 754 drift for values
		// whose float representation rounds down (e.g., 1.005 * 100 = 100.4999...).
		// The integer path parses "05" directly as 5 cents, so there is no drift.
		expect(parseCurrencyToCents('10.07')).toBe(1007);
		expect(parseCurrencyToCents('99.99')).toBe(9999);
		expect(parseCurrencyToCents('0.01')).toBe(1);
		expect(parseCurrencyToCents('0.99')).toBe(99);
		expect(parseCurrencyToCents('1.05')).toBe(105);
		expect(parseCurrencyToCents('28.25')).toBe(2825);
	});

	it('parses whole-cent amounts exactly', () => {
		expect(parseCurrencyToCents('1')).toBe(100);
		expect(parseCurrencyToCents('100')).toBe(10000);
		expect(parseCurrencyToCents('1000000')).toBe(100000000);
	});

	it('parses one-decimal amounts correctly', () => {
		expect(parseCurrencyToCents('1.5')).toBe(150);
		expect(parseCurrencyToCents('10.9')).toBe(1090);
	});

	it('rejects negative amounts', () => {
		expect(() => parseCurrencyToCents('-0.01')).toThrow('Amount must be greater than zero.');
		expect(() => parseCurrencyToCents('-100')).toThrow('Amount must be greater than zero.');
	});

	it('rejects zero', () => {
		expect(() => parseCurrencyToCents('0')).toThrow('Amount must be greater than zero.');
		expect(() => parseCurrencyToCents('0.00')).toThrow('Amount must be greater than zero.');
	});

	it('treats a 3-digit-fraction value as thousands-separated integer', () => {
		// '1.005' is ambiguous — normalizeCurrencyInput treats it as the European
		// thousands-separated integer 1005 (not as 1.005 with 3 decimal places),
		// because parts.slice(1) = ['005'] which matches the \d{3} thousands pattern.
		expect(parseCurrencyToCents('1.005')).toBe(100500); // 1005 EUR/USD = 100500 cents
	});

	it('parses European format with thousands dot and comma decimal', () => {
		expect(parseCurrencyToCents('1.234,56')).toBe(123456);
		expect(parseCurrencyToCents('1.000')).toBe(100000);
		expect(parseCurrencyToCents('1.000,00')).toBe(100000);
	});

	it('parses US format with thousands comma and dot decimal', () => {
		expect(parseCurrencyToCents('1,234.56')).toBe(123456);
		expect(parseCurrencyToCents('1,000')).toBe(100000);
	});
});
