import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	formatDateLabel,
	formatDatePart,
	formatDateRangeLabel,
	formatDateTimeLabel,
	formatMonthLabel,
	formatPeriodLabel,
	formatYearLabel,
	getBrowserLocales,
	parseIsoDate
} from './date-format';

describe('date format helpers', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('parses ISO calendar dates as UTC dates', () => {
		expect(parseIsoDate('2026-06-25')?.toISOString()).toBe('2026-06-25T00:00:00.000Z');
		expect(parseIsoDate('not-a-date')).toBeNull();
		expect(parseIsoDate('2026-02-31')).toBeNull();
	});

	it('formats dates with the provided locale instead of a hard-coded locale', () => {
		expect(formatDateLabel('2026-06-25', 'pt-BR')).toBe('25/06/2026');
		expect(formatDateLabel('2026-06-25', 'en-US')).toBe('06/25/2026');
	});

	it('formats ranges, months, years and date parts with native Intl', () => {
		expect(formatDateRangeLabel('2026-06-01', '2026-06-30', 'pt-BR')).toContain('06/2026');
		expect(formatMonthLabel('2026-06-01', 'pt-BR')).toContain('2026');
		expect(formatMonthLabel('2026-06-01', 'pt-BR', 'compact')).toContain('06');
		expect(formatYearLabel('2026-01-01', 'pt-BR')).toBe('2026');
		expect(formatDatePart('2026-06-25', 'day', 'pt-BR')).toBe('25');
		expect(formatDatePart('2026-06-25', 'month', 'pt-BR').toLowerCase()).toContain('jun');
	});

	it('formats period labels according to the period type', () => {
		expect(formatPeriodLabel('2026-06-01', 'date', 'pt-BR')).toBe('01/06/2026');
		expect(formatPeriodLabel('2026-06-01', 'date', 'pt-BR', 'compact')).toBe('01/06');
		expect(formatPeriodLabel('2026-06-01', 'week', 'pt-BR')).toBe('01/06/2026');
		expect(formatPeriodLabel('2026-06-01', 'month', 'pt-BR')).toContain('2026');
		expect(formatPeriodLabel('2026-01-01', 'year', 'pt-BR')).toBe('2026');
	});

	it('formats date-time values with native Intl', () => {
		const label = formatDateTimeLabel(new Date('2026-06-25T12:30:00.000Z'), 'pt-BR');
		expect(label).toContain('2026');
		expect(formatDateTimeLabel('invalid', 'pt-BR')).toBe('invalid');
		expect(formatDateTimeLabel('2026-06-25T12:30:00.000Z', 'en-US', 'compact')).toContain('/');
	});

	it('keeps invalid values unchanged', () => {
		expect(formatDateLabel('invalid', 'pt-BR')).toBe('invalid');
		expect(formatMonthLabel('invalid', 'pt-BR')).toBe('invalid');
		expect(formatYearLabel('invalid', 'pt-BR')).toBe('invalid');
		expect(formatDatePart('invalid', 'day', 'pt-BR')).toBe('invalid');
		expect(formatDateRangeLabel('invalid', '2026-06-30', 'pt-BR')).toBe('invalid a 2026-06-30');
	});

	it('returns no browser locales during server-side execution', () => {
		expect(getBrowserLocales()).toBeUndefined();
	});

	it('reads locales from the browser navigator', () => {
		vi.stubGlobal('window', {});
		vi.stubGlobal('navigator', { languages: ['pt-BR', 'en-US'], language: 'pt-BR' });
		expect(getBrowserLocales()).toEqual(['pt-BR', 'en-US']);

		vi.stubGlobal('navigator', { languages: [], language: 'pt-BR' });
		expect(getBrowserLocales()).toBe('pt-BR');
	});

	it('falls back when Intl formatRange is not available', () => {
		const original = Intl.DateTimeFormat.prototype.formatRange;
		Object.defineProperty(Intl.DateTimeFormat.prototype, 'formatRange', {
			value: undefined,
			configurable: true
		});

		try {
			expect(formatDateRangeLabel('2026-06-01', '2026-06-30', 'pt-BR')).toBe(
				'01/06/2026 a 30/06/2026'
			);
		} finally {
			Object.defineProperty(Intl.DateTimeFormat.prototype, 'formatRange', {
				value: original,
				configurable: true
			});
		}
	});
});
