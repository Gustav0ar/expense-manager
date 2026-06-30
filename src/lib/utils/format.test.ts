import { describe, expect, it } from 'vitest';
import { formatCents, formatDate, formatPercent } from './format';

describe('format helpers', () => {
	it('formats cents as BRL by default', () => {
		expect(formatCents(123456)).toBe('R$ 1.234,56');
		expect(formatCents(123456, 'USD')).toBe('US$ 1.234,56');
	});

	it('formats percent deltas and null baselines', () => {
		expect(formatPercent(12.345)).toBe('+12.3%');
		expect(formatPercent(-4.56)).toBe('-4.6%');
		expect(formatPercent(0)).toBe('+0.0%');
		expect(formatPercent(null)).toBe('Sem base');
	});

	it('formats ISO dates with the provided Intl locale', () => {
		expect(formatDate('2026-06-25', 'pt-BR')).toBe('25/06/2026');
		expect(formatDate('2026-06-25', 'en-US')).toBe('06/25/2026');
	});
});
