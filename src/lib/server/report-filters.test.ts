import { describe, expect, it } from 'vitest';
import { isGroupedReport, parseReportFilters, toGroupedReportFilters } from './report-filters';

describe('report filters', () => {
	it('uses a caller-specific group default and the current month range', () => {
		const filters = parseReportFilters(new URLSearchParams(), {
			defaultGroupBy: 'expense',
			now: new Date('2026-07-12T12:00:00.000Z')
		});

		expect(filters).toMatchObject({
			success: true,
			data: { from: '2026-07-01', to: '2026-07-31', groupBy: 'expense', dateField: 'expenseDate' }
		});
	});

	it('normalizes optional values once for every report endpoint', () => {
		const filters = parseReportFilters(
			new URLSearchParams({
				from: '2026-01-01',
				to: '2026-03-31',
				groupBy: 'vendor',
				categoryId: '12',
				competencyMonth: '2026-02',
				reviewStatus: 'approved',
				paymentStatus: 'paid'
			}),
			{ defaultGroupBy: 'category' }
		);

		expect(filters.success).toBe(true);
		if (!filters.success) return;
		expect(isGroupedReport(filters.data)).toBe(true);
		if (!isGroupedReport(filters.data)) return;
		expect(toGroupedReportFilters(filters.data)).toEqual({
			from: '2026-01-01',
			to: '2026-03-31',
			groupBy: 'vendor',
			dateField: 'expenseDate',
			categoryId: 12,
			vendorId: undefined,
			costCenterId: undefined,
			competencyMonth: '2026-02-01',
			reviewStatus: 'approved',
			paymentStatus: 'paid'
		});
	});

	it('preserves validation failures', () => {
		const filters = parseReportFilters(
			new URLSearchParams({ from: '2026-02-30', to: '2026-03-01' }),
			{ defaultGroupBy: 'category' }
		);

		expect(filters.success).toBe(false);
	});
});
