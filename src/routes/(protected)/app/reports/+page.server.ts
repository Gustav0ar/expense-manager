import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { listCategories } from '$lib/server/services/categories';
import { listExpenseCatalogs } from '$lib/server/services/expense-catalogs';
import {
	analyticalReportUiLimit,
	getAnalyticalExpenseReport,
	getReport
} from '$lib/server/services/expenses';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { firstDayOfMonth, lastDayOfMonth } from '$lib/server/utils/date';
import { reportFilterSchema } from '$lib/server/validation';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	const today = new Date();
	const filters = reportFilterSchema.safeParse({
		from: event.url.searchParams.get('from') || firstDayOfMonth(today),
		to: event.url.searchParams.get('to') || lastDayOfMonth(today),
		groupBy: event.url.searchParams.get('groupBy') || 'category',
		dateField: event.url.searchParams.get('dateField') || 'expenseDate',
		categoryId: event.url.searchParams.get('categoryId') || undefined,
		vendorId: event.url.searchParams.get('vendorId') || undefined,
		costCenterId: event.url.searchParams.get('costCenterId') || undefined,
		competencyMonth: event.url.searchParams.get('competencyMonth') || undefined,
		reviewStatus: event.url.searchParams.get('reviewStatus') || undefined,
		paymentStatus: event.url.searchParams.get('paymentStatus') || undefined,
		q: event.url.searchParams.get('q') || undefined
	});
	if (!filters.success) throw error(400, translate(event.locals.locale, 'Filters are invalid.'));

	const groupBy = filters.data.groupBy;
	const reportPromise =
		groupBy === 'expense'
			? Promise.resolve([])
			: getReport(context, {
					from: filters.data.from,
					to: filters.data.to,
					groupBy,
					dateField: filters.data.dateField,
					categoryId: filters.data.categoryId,
					vendorId: filters.data.vendorId,
					costCenterId: filters.data.costCenterId,
					competencyMonth: filters.data.competencyMonth,
					reviewStatus: filters.data.reviewStatus,
					paymentStatus: filters.data.paymentStatus
				});
	const analyticsPromise =
		groupBy === 'expense'
			? getAnalyticalExpenseReport(context, filters.data, { limit: analyticalReportUiLimit })
			: Promise.resolve(null);
	const [categories, catalogs, report, analytics] = await Promise.all([
		listCategories(context),
		listExpenseCatalogs(context),
		reportPromise,
		analyticsPromise
	]);

	return {
		categories,
		catalogs,
		filters: filters.data,
		report,
		analytics
	};
};
