import { describe, expect, it } from 'vitest';
import {
	addDays,
	addMonths,
	advanceDate,
	firstDayOfMonth,
	lastDayOfMonth,
	previousPeriod,
	startOfMonth,
	todayIso
} from './date';

describe('date helpers', () => {
	it('adds days in UTC', () => {
		expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
	});

	it('calculates previous period with same size', () => {
		expect(previousPeriod('2026-06-01', '2026-06-07')).toEqual({
			from: '2026-05-25',
			to: '2026-05-31'
		});
	});

	it('calculates month bounds in UTC', () => {
		const leapFebruary = new Date(Date.UTC(2024, 1, 15, 23, 30));
		expect(firstDayOfMonth(leapFebruary)).toBe('2024-02-01');
		expect(lastDayOfMonth(leapFebruary)).toBe('2024-02-29');
	});

	it('calculates month bounds with the workspace timezone', () => {
		const utcStartOfJuly = new Date('2026-07-01T01:00:00.000Z');
		expect(firstDayOfMonth(utcStartOfJuly, 'America/Sao_Paulo')).toBe('2026-06-01');
		expect(lastDayOfMonth(utcStartOfJuly, 'America/Sao_Paulo')).toBe('2026-06-30');
		expect(firstDayOfMonth(utcStartOfJuly, 'UTC')).toBe('2026-07-01');
		expect(todayIso('America/Sao_Paulo', utcStartOfJuly)).toBe('2026-06-30');
	});

	it('advances dates for monthly installments and recurrence', () => {
		expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
		expect(startOfMonth('2026-06-25')).toBe('2026-06-01');
		expect(advanceDate('2026-06-01', 'weekly', 2)).toBe('2026-06-15');
		expect(advanceDate('2026-06-30', 'monthly', 1)).toBe('2026-07-30');
		expect(advanceDate('2024-02-29', 'yearly', 1)).toBe('2025-02-28');
	});

	it('formats today as an ISO date', () => {
		expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
