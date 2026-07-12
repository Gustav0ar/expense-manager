import { and, desc, eq, inArray, isNull, lte, lt, or, sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { client, db } from '$lib/server/db';
import * as schema from '$lib/server/db/schema';
import {
	category,
	costCenter,
	expense,
	expenseAttachment,
	paymentMethod,
	vendor
} from '$lib/server/db/schema';
import {
	firstDayOfMonth,
	lastDayOfMonth,
	previousPeriod,
	startOfMonth
} from '$lib/server/utils/date';
import { getBudgetSummary } from './budgets';
import { buildExpenseConditions } from './expense-conditions';
import type {
	AnalyticalExpenseReport,
	AnalyticalExpenseReportFilters,
	AnalyticalExpenseReportRow,
	GroupedReportFilters,
	GroupedReportGroupBy
} from './expenses';
import type { WorkspaceContext } from './workspaces';

export const analyticalReportUiLimit = 500;
export const analyticalReportExportBatchSize = 1_000;

export async function getDashboard(context: WorkspaceContext, from?: string, to?: string) {
	const today = new Date();
	from ??= firstDayOfMonth(today);
	to ??= lastDayOfMonth(today);
	const previous = previousPeriod(from, to);
	const currentFilters = { from, to };

	const [currentTotal, previousTotal, byCategory, byWeek, byMonth, byPaymentMethod, budgetSummary] =
		await Promise.all([
			getTotal(context.workspaceId, from, to),
			getTotal(context.workspaceId, previous.from, previous.to),
			getTotalsByCategory(context.workspaceId, currentFilters),
			getTotalsByPeriod(context.workspaceId, currentFilters, 'week', context.weekStartsOn),
			getTotalsByPeriod(context.workspaceId, currentFilters, 'month', context.weekStartsOn),
			getTotalsByPaymentMethod(context.workspaceId, currentFilters),
			getBudgetSummary(context, startOfMonth(from))
		]);

	const deltaPct =
		previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : null;

	const topCategory = byCategory[0] ?? null;
	const periodDays = Math.max(
		1,
		Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000) + 1
	);

	return {
		from,
		to,
		totalCents: currentTotal,
		previousPeriodDeltaPct: deltaPct,
		weeklyAverageCents: Math.round((currentTotal / periodDays) * 7),
		topCategory,
		byCategory,
		byWeek,
		byMonth,
		byPaymentMethod,
		budgetSummary
	};
}

export async function getReport(
	context: WorkspaceContext,
	input: GroupedReportFilters & {
		groupBy: GroupedReportGroupBy;
		dateField?: 'expenseDate' | 'competencyMonth';
	}
) {
	if (input.groupBy === 'category') {
		return getTotalsByCategory(context.workspaceId, input);
	}

	if (input.groupBy === 'payment') {
		return getTotalsByPaymentMethod(context.workspaceId, input);
	}

	if (input.groupBy === 'vendor') {
		return getTotalsByVendor(context.workspaceId, input);
	}

	if (input.groupBy === 'costCenter') {
		return getTotalsByCostCenter(context.workspaceId, input);
	}

	return getTotalsByPeriod(
		context.workspaceId,
		input,
		input.groupBy,
		context.weekStartsOn,
		input.dateField
	);
}

export async function getAnalyticalExpenseReport(
	context: WorkspaceContext,
	input: AnalyticalExpenseReportFilters,
	options: { limit?: number } = {}
): Promise<AnalyticalExpenseReport> {
	const limit = Math.min(Math.max(options.limit ?? analyticalReportUiLimit, 1), 100_000);
	const baseConditions = [
		...buildExpenseConditions(context.workspaceId, input, false),
		eq(expense.status, 'posted')
	];

	const [rows, summaryRows] = await Promise.all([
		selectAnalyticalExpenseRows(db, baseConditions, limit + 1),
		db
			.select({
				itemCount: sql<number>`count(*)::int`,
				totalCents: sql<number>`coalesce(sum(${expense.amountCents}), 0)::bigint`,
				approvedCents: sql<number>`coalesce(sum(case when ${expense.reviewStatus} = 'approved' then ${expense.amountCents} else 0 end), 0)::bigint`,
				pendingCents: sql<number>`coalesce(sum(case when ${expense.reviewStatus} = 'pending' then ${expense.amountCents} else 0 end), 0)::bigint`,
				rejectedCents: sql<number>`coalesce(sum(case when ${expense.reviewStatus} = 'rejected' then ${expense.amountCents} else 0 end), 0)::bigint`,
				paidCents: sql<number>`coalesce(sum(case when ${expense.paymentStatus} = 'paid' then ${expense.amountCents} else 0 end), 0)::bigint`,
				unpaidCents: sql<number>`coalesce(sum(case when ${expense.paymentStatus} = 'unpaid' then ${expense.amountCents} else 0 end), 0)::bigint`,
				reconciledCents: sql<number>`coalesce(sum(case when ${expense.paymentStatus} = 'reconciled' then ${expense.amountCents} else 0 end), 0)::bigint`
			})
			.from(expense)
			.leftJoin(paymentMethod, eq(paymentMethod.id, expense.paymentMethodId))
			.leftJoin(vendor, eq(vendor.id, expense.vendorId))
			.leftJoin(costCenter, eq(costCenter.id, expense.costCenterId))
			.where(and(...baseConditions))
	]);

	const summary = summaryRows[0]!;
	const items = await attachAnalyticalExpenseCounts(db, context.workspaceId, rows.slice(0, limit));

	return {
		items,
		summary: {
			itemCount: Number(summary.itemCount),
			totalCents: Number(summary.totalCents),
			approvedCents: Number(summary.approvedCents),
			pendingCents: Number(summary.pendingCents),
			rejectedCents: Number(summary.rejectedCents),
			paidCents: Number(summary.paidCents),
			unpaidCents: Number(summary.unpaidCents),
			reconciledCents: Number(summary.reconciledCents)
		},
		limit,
		truncated: rows.length > limit
	};
}

export async function* streamAnalyticalExpenseReport(
	context: WorkspaceContext,
	input: AnalyticalExpenseReportFilters,
	options: { batchSize?: number } = {}
): AsyncGenerator<AnalyticalExpenseReportRow[]> {
	const batchSize = Math.min(
		Math.max(options.batchSize ?? analyticalReportExportBatchSize, 1),
		5_000
	);
	const reserved = await client.reserve();
	let transactionOpen = false;
	try {
		// A read-only repeatable-read snapshot gives the CSV one explicit point-in-time
		// view. The ID watermark is captured inside that snapshot and keeps the keyset
		// boundary visible and testable while new expenses are inserted concurrently.
		await reserved`begin transaction isolation level repeatable read read only`;
		transactionOpen = true;
		// postgres.js intentionally omits pool options from a reserved Sql handle,
		// while Drizzle reads its parser configuration when binding that handle.
		// Reuse the already configured pool options; queries still execute only on
		// the reserved connection that owns this transaction.
		const snapshotDb = drizzle(Object.assign(reserved, { options: client.options }), { schema });
		const [watermarkRow] = await snapshotDb
			.select({ id: sql<number | null>`max(${expense.id})` })
			.from(expense)
			.where(
				and(
					eq(expense.workspaceId, context.workspaceId),
					isNull(expense.deletedAt),
					eq(expense.status, 'posted')
				)
			);
		const watermark = watermarkRow?.id == null ? null : Number(watermarkRow.id);
		let cursor: { expenseDate: string; id: number } | null = null;

		while (watermark != null) {
			const conditions: SQL[] = [
				...buildExpenseConditions(context.workspaceId, input, false),
				eq(expense.status, 'posted'),
				lte(expense.id, watermark)
			];
			if (cursor) {
				conditions.push(
					or(
						lt(expense.expenseDate, cursor.expenseDate),
						and(eq(expense.expenseDate, cursor.expenseDate), lt(expense.id, cursor.id))
					)!
				);
			}
			const rows = await selectAnalyticalExpenseRows(snapshotDb, conditions, batchSize);
			if (rows.length === 0) break;
			yield await attachAnalyticalExpenseCounts(snapshotDb, context.workspaceId, rows);
			const last = rows.at(-1)!;
			cursor = { expenseDate: last.expenseDate, id: last.id };
			if (rows.length < batchSize) break;
		}

		await reserved`commit`;
		transactionOpen = false;
	} finally {
		if (transactionOpen) await reserved`rollback`.catch(() => undefined);
		reserved.release();
	}
}

async function selectAnalyticalExpenseRows(executor: typeof db, conditions: SQL[], limit: number) {
	return executor
		.select({
			id: expense.id,
			expenseDate: expense.expenseDate,
			competencyMonth: expense.competencyMonth,
			description: expense.description,
			categoryName: category.name,
			categoryColor: category.color,
			categoryIcon: category.icon,
			amountCents: expense.amountCents,
			currency: expense.currency,
			paymentMethod: sql<string | null>`coalesce(${paymentMethod.name}, ${expense.paymentMethod})`,
			vendor: sql<string | null>`coalesce(${vendor.name}, ${expense.vendor})`,
			costCenter: sql<string | null>`coalesce(${costCenter.name}, ${expense.costCenter})`,
			reviewStatus: expense.reviewStatus,
			paymentStatus: expense.paymentStatus,
			paidAt: expense.paidAt,
			installmentNumber: expense.installmentNumber,
			installmentsTotal: expense.installmentsTotal,
			notes: expense.notes,
			createdAt: expense.createdAt
		})
		.from(expense)
		.innerJoin(category, eq(category.id, expense.categoryId))
		.leftJoin(paymentMethod, eq(paymentMethod.id, expense.paymentMethodId))
		.leftJoin(vendor, eq(vendor.id, expense.vendorId))
		.leftJoin(costCenter, eq(costCenter.id, expense.costCenterId))
		.where(and(...conditions))
		.orderBy(desc(expense.expenseDate), desc(expense.id))
		.limit(limit);
}

type AnalyticalExpenseQueryRow = Awaited<ReturnType<typeof selectAnalyticalExpenseRows>>[number];

async function attachAnalyticalExpenseCounts(
	executor: typeof db,
	workspaceId: number,
	rows: AnalyticalExpenseQueryRow[]
): Promise<AnalyticalExpenseReportRow[]> {
	if (rows.length === 0) return [];
	const counts = await executor
		.select({
			expenseId: expenseAttachment.expenseId,
			count: sql<number>`count(*)::int`
		})
		.from(expenseAttachment)
		.where(
			and(
				eq(expenseAttachment.workspaceId, workspaceId),
				inArray(
					expenseAttachment.expenseId,
					rows.map((row) => row.id)
				),
				isNull(expenseAttachment.deletedAt)
			)
		)
		.groupBy(expenseAttachment.expenseId);
	const countsByExpense = new Map(counts.map((row) => [row.expenseId, Number(row.count)]));
	return rows.map((row) => ({
		...row,
		amountCents: Number(row.amountCents),
		attachmentCount: countsByExpense.get(row.id) ?? 0,
		reviewStatus: toAnalyticalReviewStatus(row.reviewStatus),
		paymentStatus: toAnalyticalPaymentStatus(row.paymentStatus)
	}));
}

function toAnalyticalReviewStatus(value: string): AnalyticalExpenseReportRow['reviewStatus'] {
	return value as AnalyticalExpenseReportRow['reviewStatus'];
}

function toAnalyticalPaymentStatus(value: string): AnalyticalExpenseReportRow['paymentStatus'] {
	return value as AnalyticalExpenseReportRow['paymentStatus'];
}

async function getTotalsByPaymentMethod(workspaceId: number, filters: GroupedReportFilters) {
	const result = await db.execute<{
		label: string;
		total_cents: string | number;
	}>(sql`
		select coalesce(nullif(trim(pm.name), ''), nullif(trim(e.payment_method), ''), 'Unspecified') as label,
			coalesce(sum(e.amount_cents), 0)::bigint as total_cents
		from expense e
		left join payment_method pm on pm.id = e.payment_method_id and pm.workspace_id = e.workspace_id
		where ${baseReportConditionsSql(workspaceId, filters)}
			${groupedReportFilterSql(filters)}
		group by label
		order by total_cents desc, label asc
	`);

	return result.map((row) => ({
		key: row.label,
		label: row.label,
		color: '#2563eb',
		totalCents: Number(row.total_cents)
	}));
}

async function getTotal(workspaceId: number, from: string, to: string) {
	const result = await db.execute<{ total_cents: string | number | null }>(sql`
		select coalesce(sum(e.amount_cents), 0)::bigint as total_cents
		from expense e
		where ${baseReportConditionsSql(workspaceId, { from, to })}
	`);

	return Number(result[0]?.total_cents ?? 0);
}

async function getTotalsByCategory(workspaceId: number, filters: GroupedReportFilters) {
	const result = await db.execute<{
		category_id: number;
		name: string;
		color: string;
		total_cents: string | number;
	}>(sql`
		select c.id as category_id, c.name, c.color, coalesce(sum(e.amount_cents), 0)::bigint as total_cents
		from expense e
		inner join category c on c.id = e.category_id
		where ${baseReportConditionsSql(workspaceId, filters)}
			${groupedReportFilterSql(filters)}
		group by c.id, c.name, c.color
		order by total_cents desc, c.name asc
	`);

	return result.map((row) => ({
		key: String(row.category_id),
		label: row.name,
		color: row.color,
		totalCents: Number(row.total_cents)
	}));
}

async function getTotalsByPeriod(
	workspaceId: number,
	filters: GroupedReportFilters,
	groupBy: 'week' | 'month' | 'year',
	weekStartsOn = 1,
	dateField: 'expenseDate' | 'competencyMonth' = 'expenseDate'
) {
	const dateCol = dateField === 'competencyMonth' ? sql`e.competency_month` : sql`e.expense_date`;
	const bucket =
		groupBy === 'week'
			? sql`(${dateCol} - (((extract(dow from ${dateCol})::int - ${weekStartsOn} + 7) % 7) * interval '1 day'))::date`
			: sql`date_trunc(${groupBy === 'month' ? 'month' : 'year'}, ${dateCol}::timestamp)::date`;
	const nullGuard =
		dateField === 'competencyMonth' ? sql`and e.competency_month is not null` : sql``;
	const result = await db.execute<{ bucket: string; total_cents: string | number }>(sql`
		select ${bucket} as bucket,
			coalesce(sum(e.amount_cents), 0)::bigint as total_cents
		from expense e
		where ${baseReportConditionsSql(workspaceId, filters)}
			${groupedReportFilterSql(filters)}
			${nullGuard}
		group by bucket
		order by bucket asc
	`);

	return result.map((row) => ({
		key: String(row.bucket),
		label: String(row.bucket),
		totalCents: Number(row.total_cents)
	}));
}

async function getTotalsByVendor(workspaceId: number, filters: GroupedReportFilters) {
	const result = await db.execute<{
		label: string;
		total_cents: string | number;
	}>(sql`
		select coalesce(nullif(trim(v.name), ''), nullif(trim(e.vendor), ''), 'Unspecified') as label,
			coalesce(sum(e.amount_cents), 0)::bigint as total_cents
		from expense e
		left join vendor v on v.id = e.vendor_id and v.workspace_id = e.workspace_id
		where ${baseReportConditionsSql(workspaceId, filters)}
			${groupedReportFilterSql(filters)}
		group by label
		order by total_cents desc, label asc
	`);

	return result.map((row) => ({
		key: row.label,
		label: row.label,
		color: '#7c3aed',
		totalCents: Number(row.total_cents)
	}));
}

async function getTotalsByCostCenter(workspaceId: number, filters: GroupedReportFilters) {
	const result = await db.execute<{
		label: string;
		total_cents: string | number;
	}>(sql`
		select coalesce(nullif(trim(cc.name), ''), nullif(trim(e.cost_center), ''), 'Unspecified') as label,
			coalesce(sum(e.amount_cents), 0)::bigint as total_cents
		from expense e
		left join cost_center cc on cc.id = e.cost_center_id and cc.workspace_id = e.workspace_id
		where ${baseReportConditionsSql(workspaceId, filters)}
			${groupedReportFilterSql(filters)}
		group by label
		order by total_cents desc, label asc
	`);

	return result.map((row) => ({
		key: row.label,
		label: row.label,
		color: '#0891b2',
		totalCents: Number(row.total_cents)
	}));
}

/**
 * Shared base WHERE conditions for all grouped report queries. Defaults to
 * approved/posted expenses but honours reviewStatus and paymentStatus overrides
 * when provided, so the same filter context applies to every report view.
 */
function baseReportConditionsSql(
	workspaceId: number,
	filters: { from: string; to: string; reviewStatus?: string; paymentStatus?: string }
) {
	const reviewCond = filters.reviewStatus
		? sql`and e.review_status = ${filters.reviewStatus}`
		: sql`and e.review_status = 'approved'`;
	const paymentCond = filters.paymentStatus
		? sql`and e.payment_status = ${filters.paymentStatus}`
		: sql``;
	return sql`
		e.workspace_id = ${workspaceId}
		and e.deleted_at is null
		and e.status = 'posted'
		${reviewCond}
		${paymentCond}
		and e.expense_date >= ${filters.from}
		and e.expense_date <= ${filters.to}
	`;
}

function groupedReportFilterSql(filters: GroupedReportFilters) {
	return sql`
		${filters.categoryId ? sql`and e.category_id = ${filters.categoryId}` : sql``}
		${filters.vendorId ? sql`and e.vendor_id = ${filters.vendorId}` : sql``}
		${filters.costCenterId ? sql`and e.cost_center_id = ${filters.costCenterId}` : sql``}
		${filters.competencyMonth ? sql`and e.competency_month = ${filters.competencyMonth}` : sql``}
	`;
}
