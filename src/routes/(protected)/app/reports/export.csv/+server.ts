import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import { getReport } from '$lib/server/services/expenses';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { firstDayOfMonth, lastDayOfMonth } from '$lib/server/utils/date';
import { csvCell } from '$lib/server/utils/csv';
import { reportFilterSchema } from '$lib/server/validation';

export const GET: RequestHandler = async (event) => {
	const context = await requireWorkspaceContext(event);
	const today = new Date();
	const filters = reportFilterSchema.safeParse({
		from: event.url.searchParams.get('from') || firstDayOfMonth(today, context.timezone),
		to: event.url.searchParams.get('to') || lastDayOfMonth(today, context.timezone),
		groupBy: event.url.searchParams.get('groupBy') || 'category',
		categoryId: event.url.searchParams.get('categoryId') || undefined
	});
	if (!filters.success) throw error(400, 'Filtros inválidos.');

	const report = await getReport(context, filters.data);
	const lines = [
		['grupo', 'valor_centavos'].join(','),
		...report.map((row) => [csvCell(row.label), row.totalCents].join(','))
	];

	return new Response(lines.join('\n'), {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': 'attachment; filename="expense-report.csv"'
		}
	});
};
