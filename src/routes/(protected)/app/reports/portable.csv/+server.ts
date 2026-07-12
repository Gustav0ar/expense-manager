import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { translate } from '$lib/i18n';
import { streamAnalyticalExpenseReport } from '$lib/server/services/expenses';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import {
	maxExpenseImportBytes,
	maxExpenseImportRows,
	serializePortableExpenseCsv,
	type PortableExpenseCsvRow
} from '$lib/server/utils/import';
import { parseReportFilters } from '$lib/server/report-filters';

export const GET: RequestHandler = async (event) => {
	const context = await requireWorkspaceContext(event);
	const filters = parseReportFilters(event.url.searchParams, { defaultGroupBy: 'expense' });
	if (!filters.success) throw error(400, translate(context.locale, 'Filters are invalid.'));

	const portableRows: PortableExpenseCsvRow[] = [];
	for await (const batch of streamAnalyticalExpenseReport(context, filters.data, {
		batchSize: maxExpenseImportRows + 1
	})) {
		portableRows.push(
			...batch.map((row) => ({
				expenseDate: row.expenseDate,
				description: row.description,
				amountCents: row.amountCents,
				categoryName: row.categoryName,
				paymentMethod: row.paymentMethod,
				vendor: row.vendor,
				costCenter: row.costCenter,
				notes: row.notes
			}))
		);
		if (portableRows.length > maxExpenseImportRows) {
			throw error(
				413,
				translate(
					context.locale,
					'Portable CSV export supports at most {count} expenses. Narrow the report filters and try again.',
					{ count: maxExpenseImportRows }
				)
			);
		}
	}

	const csv = serializePortableExpenseCsv(portableRows);
	if (new TextEncoder().encode(csv).byteLength > maxExpenseImportBytes) {
		throw error(
			413,
			translate(
				context.locale,
				'Portable CSV exceeds the 1 MB import file limit. Narrow the report filters and try again.'
			)
		);
	}

	return new Response(csv, {
		headers: {
			'cache-control': 'private, no-store',
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': 'attachment; filename="expense-manager-portable-v1.csv"'
		}
	});
};
