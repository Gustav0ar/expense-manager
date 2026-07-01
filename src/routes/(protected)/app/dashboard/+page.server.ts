import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getDashboard } from '$lib/server/services/expenses';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { firstDayOfMonth, lastDayOfMonth } from '$lib/server/utils/date';
import { dashboardFilterSchema } from '$lib/server/validation';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	const today = new Date();
	const filters = dashboardFilterSchema.safeParse({
		from: event.url.searchParams.get('from') || firstDayOfMonth(today),
		to: event.url.searchParams.get('to') || lastDayOfMonth(today)
	});
	if (!filters.success) throw error(400, translate(event.locals.locale, 'Filters are invalid.'));

	return {
		dashboard: await getDashboard(context, filters.data.from, filters.data.to)
	};
};
