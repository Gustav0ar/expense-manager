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
import {
	isGroupedReport,
	parseReportFilters,
	toGroupedReportFilters
} from '$lib/server/report-filters';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	const filters = parseReportFilters(event.url.searchParams, { defaultGroupBy: 'category' });
	if (!filters.success) throw error(400, translate(event.locals.locale, 'Filters are invalid.'));

	const reportPromise = isGroupedReport(filters.data)
		? getReport(context, toGroupedReportFilters(filters.data))
		: Promise.resolve([]);
	const analyticsPromise =
		filters.data.groupBy === 'expense'
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
