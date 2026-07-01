import { describe, expect, it } from 'vitest';
import { formatCents, parseBrlToCents, parseCurrencyToCents } from './money';

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
		expect(formatCents(123456, 'BRL', 'pt-BR')).toBe('R$ 1.234,56');
	});
});
