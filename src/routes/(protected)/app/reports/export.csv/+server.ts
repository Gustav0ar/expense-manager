import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import {
	getReport,
	streamAnalyticalExpenseReport,
	type AnalyticalExpenseReportRow
} from '$lib/server/services/expenses';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { firstDayOfMonth, lastDayOfMonth } from '$lib/server/utils/date';
import { csvCell } from '$lib/server/utils/csv';
import { reportFilterSchema } from '$lib/server/validation';
import { translate } from '$lib/i18n';
import { reviewLabel, paymentLabel } from '$lib/utils/status';

export const GET: RequestHandler = async (event) => {
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
	if (groupBy === 'expense') {
		const t = (key: string) => translate(context.locale, key);
		const stream = analyticalCsvStream(streamAnalyticalExpenseReport(context, filters.data), t);

		return new Response(stream, {
			headers: {
				'cache-control': 'private, no-store',
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': 'attachment; filename="expense-analytical-report.csv"'
			}
		});
	}

	const report = await getReport(context, {
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

	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(['group', 'amount_cents'].join(',') + '\n'));
			for (const row of report) {
				controller.enqueue(encoder.encode([csvCell(row.label), row.totalCents].join(',') + '\n'));
			}
			controller.close();
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': 'attachment; filename="expense-report.csv"'
		}
	});
};

const analyticalHeader = [
	'id',
	'date',
	'competency',
	'description',
	'category',
	'vendor',
	'cost_center',
	'payment',
	'amount_cents',
	'currency',
	'review',
	'payment_status',
	'payment_date',
	'installment',
	'attachments',
	'created_at',
	'notes'
].join(',');

function analyticalCsvStream(
	batches: AsyncIterable<AnalyticalExpenseReportRow[]>,
	t: (key: string) => string
) {
	const encoder = new TextEncoder();
	const iterator = batches[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>(
		{
			start(controller) {
				controller.enqueue(encoder.encode(`${analyticalHeader}\n`));
			},
			async pull(controller) {
				try {
					const batch = await iterator.next();
					if (batch.done) {
						controller.close();
						return;
					}
					controller.enqueue(encoder.encode(batch.value.map((row) => csvRow(row, t)).join('')));
				} catch (streamError) {
					await iterator.return?.();
					controller.error(streamError);
				}
			},
			async cancel() {
				await iterator.return?.();
			}
		},
		{ highWaterMark: 1 }
	);
}

function csvRow(row: AnalyticalExpenseReportRow, t: (key: string) => string) {
	return (
		[
			row.id,
			csvCell(row.expenseDate),
			csvCell(row.competencyMonth ?? ''),
			csvCell(row.description),
			csvCell(categoryLabel(row)),
			csvCell(row.vendor ?? ''),
			csvCell(row.costCenter ?? ''),
			csvCell(row.paymentMethod ?? ''),
			row.amountCents,
			csvCell(row.currency),
			csvCell(reviewLabel(row.reviewStatus, t)),
			csvCell(paymentLabel(row.paymentStatus, t)),
			csvCell(row.paidAt ?? ''),
			csvCell(installmentLabel(row)),
			row.attachmentCount,
			csvCell(row.createdAt.toISOString()),
			csvCell(row.notes ?? '')
		].join(',') + '\n'
	);
}

function categoryLabel(row: AnalyticalExpenseReportRow) {
	return `${row.categoryIcon ? `${row.categoryIcon} ` : ''}${row.categoryName}`;
}

function installmentLabel(row: AnalyticalExpenseReportRow) {
	return row.installmentNumber && row.installmentsTotal
		? `${row.installmentNumber}/${row.installmentsTotal}`
		: '';
}
