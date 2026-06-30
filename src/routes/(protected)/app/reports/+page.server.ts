import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { listCategories } from '$lib/server/services/categories';
import { getReport } from '$lib/server/services/expenses';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { firstDayOfMonth, lastDayOfMonth } from '$lib/server/utils/date';
import { reportFilterSchema } from '$lib/server/validation';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	const today = new Date();
	const filters = reportFilterSchema.safeParse({
		from: event.url.searchParams.get('from') || firstDayOfMonth(today, context.timezone),
		to: event.url.searchParams.get('to') || lastDayOfMonth(today, context.timezone),
		groupBy: event.url.searchParams.get('groupBy') || 'category',
		categoryId: event.url.searchParams.get('categoryId') || undefined
	});
	if (!filters.success) throw error(400, 'Filtros invalidos.');

	return {
		categories: await listCategories(context),
		filters: filters.data,
		report: await getReport(context, filters.data)
	};
};
