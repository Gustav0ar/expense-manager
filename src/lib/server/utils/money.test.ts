import { describe, expect, it } from 'vitest';
import { formatCents, parseBrlToCents } from './money';

describe('parseBrlToCents', () => {
	it('parses Brazilian currency formats', () => {
		expect(parseBrlToCents('10')).toBe(1000);
		expect(parseBrlToCents('10,50')).toBe(1050);
		expect(parseBrlToCents('10.50')).toBe(1050);
		expect(parseBrlToCents('R$ 1.234')).toBe(123400);
		expect(parseBrlToCents('R$ 1.234,56')).toBe(123456);
	});

	it('rejects invalid and non-positive values', () => {
		expect(() => parseBrlToCents('')).toThrow('Valor obrigatório.');
		expect(() => parseBrlToCents('0')).toThrow();
		expect(() => parseBrlToCents('-1')).toThrow();
		expect(() => parseBrlToCents('1,234')).toThrow('Valor inválido.');
		expect(() => parseBrlToCents('abc')).toThrow();
	});

	it('formats cents as currency', () => {
		expect(formatCents(123456)).toBe('R$ 1.234,56');
		expect(formatCents(123456, 'USD')).toBe('US$ 1.234,56');
	});
});
