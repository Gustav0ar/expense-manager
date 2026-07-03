import { describe, expect, it } from 'vitest';
import { formatCents, formatDate, formatPercent } from './format';

describe('format helpers', () => {
	it('formats cents with English and USD defaults', () => {
		expect(formatCents(123456)).toBe('$1,234.56');
		expect(formatCents(123456, 'BRL', 'pt-BR')).toBe('R$ 1.234,56');
	});

	it('formats percent deltas and null baselines', () => {
		expect(formatPercent(12.345)).toBe('+12.3%');
		expect(formatPercent(-4.56)).toBe('-4.6%');
		expect(formatPercent(0)).toBe('+0.0%');
		expect(formatPercent(null)).toBe('No baseline');
		expect(formatPercent(null, 'pt-BR')).toBe('Sem base');
		expect(formatPercent(null, ['pt-BR'])).toBe('Sem base');
		// Passing undefined falls through to defaultLocale in the ternary chain
		expect(formatPercent(null, undefined)).toBe('No baseline');
	});

	it('formats ISO dates with the provided Intl locale', () => {
		expect(formatDate('2026-06-25', 'pt-BR')).toBe('25/06/2026');
		expect(formatDate('2026-06-25', 'en-US')).toBe('06/25/2026');
	});
});
