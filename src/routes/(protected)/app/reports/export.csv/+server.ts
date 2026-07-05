import type { RequestHandler } from './$types';
import { error } from '@sveltejs/kit';
import {
	analyticalReportExportLimit,
	getAnalyticalExpenseReport,
	getReport,
	type AnalyticalExpenseReportRow
} from '$lib/server/services/expenses';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { firstDayOfMonth, lastDayOfMonth } from '$lib/server/utils/date';
import { csvCell } from '$lib/server/utils/csv';
import { reportFilterSchema } from '$lib/server/validation';
import { translate } from '$lib/i18n';

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
		const report = await getAnalyticalExpenseReport(context, filters.data, {
			limit: analyticalReportExportLimit
		});
		const header = [
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

		const encoder = new TextEncoder();
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode(header + '\n'));
				for (const row of report.items) {
					controller.enqueue(
						encoder.encode(
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
								csvCell(reviewLabel(row.reviewStatus, context.locale)),
								csvCell(paymentLabel(row.paymentStatus, context.locale)),
								csvCell(row.paidAt ?? ''),
								csvCell(installmentLabel(row)),
								row.attachmentCount,
								csvCell(row.createdAt.toISOString()),
								csvCell(row.notes ?? '')
							].join(',') + '\n'
						)
					);
				}
				controller.close();
			}
		});

		return new Response(stream, {
			headers: {
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

function categoryLabel(row: AnalyticalExpenseReportRow) {
	return `${row.categoryIcon ? `${row.categoryIcon} ` : ''}${row.categoryName}`;
}

function installmentLabel(row: AnalyticalExpenseReportRow) {
	return row.installmentNumber && row.installmentsTotal
		? `${row.installmentNumber}/${row.installmentsTotal}`
		: '';
}

function reviewLabel(status: AnalyticalExpenseReportRow['reviewStatus'], locale: string) {
	return (
		{
			pending: translate(locale, 'Pending'),
			approved: translate(locale, 'Approved'),
			rejected: translate(locale, 'Rejected')
		} satisfies Record<AnalyticalExpenseReportRow['reviewStatus'], string>
	)[status];
}

function paymentLabel(status: AnalyticalExpenseReportRow['paymentStatus'], locale: string) {
	return (
		{
			unpaid: translate(locale, 'Open'),
			paid: translate(locale, 'Paid'),
			reconciled: translate(locale, 'Reconciled')
		} satisfies Record<AnalyticalExpenseReportRow['paymentStatus'], string>
	)[status];
}
