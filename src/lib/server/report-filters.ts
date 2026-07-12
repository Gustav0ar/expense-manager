import type { z } from 'zod';
import { firstDayOfMonth, lastDayOfMonth } from '$lib/server/utils/date';
import { reportFilterSchema } from '$lib/server/validation';
import type { GroupedReportFilters, GroupedReportGroupBy } from '$lib/server/services/expenses';

export type ReportFilters = z.infer<typeof reportFilterSchema>;

type ReportFilterDefaults = {
	defaultGroupBy: ReportFilters['groupBy'];
	now?: Date;
};

export function parseReportFilters(searchParams: URLSearchParams, defaults: ReportFilterDefaults) {
	const now = defaults.now ?? new Date();
	return reportFilterSchema.safeParse({
		from: searchParams.get('from') || firstDayOfMonth(now),
		to: searchParams.get('to') || lastDayOfMonth(now),
		groupBy: searchParams.get('groupBy') || defaults.defaultGroupBy,
		dateField: searchParams.get('dateField') || 'expenseDate',
		categoryId: searchParams.get('categoryId') || undefined,
		vendorId: searchParams.get('vendorId') || undefined,
		costCenterId: searchParams.get('costCenterId') || undefined,
		competencyMonth: searchParams.get('competencyMonth') || undefined,
		reviewStatus: searchParams.get('reviewStatus') || undefined,
		paymentStatus: searchParams.get('paymentStatus') || undefined,
		q: searchParams.get('q') || undefined
	});
}

export function isGroupedReport(
	filters: ReportFilters
): filters is ReportFilters & { groupBy: GroupedReportGroupBy } {
	return filters.groupBy !== 'expense';
}

export function toGroupedReportFilters(
	filters: ReportFilters & { groupBy: GroupedReportGroupBy }
): GroupedReportFilters & {
	groupBy: GroupedReportGroupBy;
	dateField: 'expenseDate' | 'competencyMonth';
} {
	return {
		from: filters.from,
		to: filters.to,
		groupBy: filters.groupBy,
		dateField: filters.dateField,
		categoryId: filters.categoryId,
		vendorId: filters.vendorId,
		costCenterId: filters.costCenterId,
		competencyMonth: filters.competencyMonth,
		reviewStatus: filters.reviewStatus,
		paymentStatus: filters.paymentStatus
	};
}
