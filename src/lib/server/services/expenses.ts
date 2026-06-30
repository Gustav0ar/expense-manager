import { error } from '@sveltejs/kit';
import {
	and,
	desc,
	eq,
	gte,
	ilike,
	inArray,
	isNull,
	lte,
	lt,
	or,
	sql,
	type SQL
} from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	auditEvent,
	category,
	costCenter,
	expense,
	expenseAttachment,
	paymentMethod,
	vendor
} from '$lib/server/db/schema';
import type { WorkspaceContext } from './workspaces';
import {
	canReconcileExpenses,
	canReviewExpenses,
	canWriteExpenses
} from '$lib/server/security/roles';
import { parseBrlToCents } from '$lib/server/utils/money';
import { assertCategoryInWorkspace } from '$lib/server/utils/category';
import { decodeExpenseCursor, encodeExpenseCursor } from '$lib/server/utils/cursor';
import {
	addMonths,
	firstDayOfMonth,
	lastDayOfMonth,
	previousPeriod,
	startOfMonth
} from '$lib/server/utils/date';
import { writeAuditEvent } from './audit';
import { getBudgetSummary } from './budgets';
import { randomToken } from '$lib/server/utils/crypto';
import { resolveExpenseCatalogSelection } from './expense-catalogs';

export type ExpenseInput = {
	categoryId: number;
	description: string;
	amount: string;
	expenseDate: string;
	paymentMethodId?: number | null;
	vendorId?: number | null;
	costCenterId?: number | null;
	competencyMonth?: string | null;
	notes?: string | null;
	installments?: number;
};

export type ExpenseFilters = {
	from?: string;
	to?: string;
	categoryId?: number;
	reviewStatus?: 'pending' | 'approved' | 'rejected';
	paymentStatus?: 'unpaid' | 'paid' | 'reconciled';
	q?: string;
	cursor?: string;
	limit?: number;
};

export async function listExpenses(context: WorkspaceContext, filters: ExpenseFilters = {}) {
	const limit = Math.min(Math.max(filters.limit ?? 25, 1), 100);
	const conditions = buildExpenseConditions(context.workspaceId, filters, true);

	const rows = await db
		.select({
			id: expense.id,
			description: expense.description,
			amountCents: expense.amountCents,
			currency: expense.currency,
			expenseDate: expense.expenseDate,
			paymentMethodId: expense.paymentMethodId,
			vendorId: expense.vendorId,
			costCenterId: expense.costCenterId,
			paymentMethod: sql<string | null>`coalesce(${paymentMethod.name}, ${expense.paymentMethod})`,
			vendor: sql<string | null>`coalesce(${vendor.name}, ${expense.vendor})`,
			costCenter: sql<string | null>`coalesce(${costCenter.name}, ${expense.costCenter})`,
			competencyMonth: expense.competencyMonth,
			notes: expense.notes,
			status: expense.status,
			reviewStatus: expense.reviewStatus,
			reviewedAt: expense.reviewedAt,
			reviewRejectionReason: expense.reviewRejectionReason,
			paymentStatus: expense.paymentStatus,
			paidAt: expense.paidAt,
			reconciledAt: expense.reconciledAt,
			sourceRecurringExpenseId: expense.sourceRecurringExpenseId,
			importBatchId: expense.importBatchId,
			installmentGroupId: expense.installmentGroupId,
			installmentNumber: expense.installmentNumber,
			installmentsTotal: expense.installmentsTotal,
			categoryId: category.id,
			categoryName: category.name,
			categoryColor: category.color,
			categoryIcon: category.icon
		})
		.from(expense)
		.innerJoin(category, eq(category.id, expense.categoryId))
		.leftJoin(paymentMethod, eq(paymentMethod.id, expense.paymentMethodId))
		.leftJoin(vendor, eq(vendor.id, expense.vendorId))
		.leftJoin(costCenter, eq(costCenter.id, expense.costCenterId))
		.where(and(...conditions))
		.orderBy(desc(expense.expenseDate), desc(expense.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const baseItems = hasMore ? rows.slice(0, limit) : rows;
	const attachments =
		baseItems.length === 0
			? []
			: await db
					.select({
						id: expenseAttachment.id,
						expenseId: expenseAttachment.expenseId,
						originalName: expenseAttachment.originalName,
						contentType: expenseAttachment.contentType,
						sizeBytes: expenseAttachment.sizeBytes
					})
					.from(expenseAttachment)
					.where(
						inArray(
							expenseAttachment.expenseId,
							baseItems.map((item) => item.id)
						)
					);
	const attachmentsByExpense = new Map<number, typeof attachments>();
	for (const attachment of attachments) {
		const current = attachmentsByExpense.get(attachment.expenseId) ?? [];
		current.push(attachment);
		attachmentsByExpense.set(attachment.expenseId, current);
	}
	const items = baseItems.map((item) => ({
		...item,
		attachments: attachmentsByExpense.get(item.id) ?? []
	}));
	const last = items.at(-1);

	return {
		items,
		nextCursor:
			hasMore && last ? encodeExpenseCursor({ date: last.expenseDate, id: last.id }) : null
	};
}

export async function getExpenseListSummary(
	context: WorkspaceContext,
	filters: Omit<ExpenseFilters, 'cursor' | 'limit'> = {}
) {
	const [row] = await db
		.select({
			itemCount: sql<number>`count(*)::int`,
			totalCents: sql<number>`coalesce(sum(${expense.amountCents}), 0)::bigint`
		})
		.from(expense)
		.leftJoin(paymentMethod, eq(paymentMethod.id, expense.paymentMethodId))
		.leftJoin(vendor, eq(vendor.id, expense.vendorId))
		.leftJoin(costCenter, eq(costCenter.id, expense.costCenterId))
		.where(and(...buildExpenseConditions(context.workspaceId, filters, false)));

	return {
		itemCount: Number(row?.itemCount ?? 0),
		totalCents: Number(row?.totalCents ?? 0)
	};
}

function buildExpenseConditions(
	workspaceId: number,
	filters: ExpenseFilters,
	includeCursor: boolean
): SQL[] {
	const conditions: SQL[] = [eq(expense.workspaceId, workspaceId), isNull(expense.deletedAt)];

	if (filters.from) conditions.push(gte(expense.expenseDate, filters.from));
	if (filters.to) conditions.push(lte(expense.expenseDate, filters.to));
	if (filters.categoryId) conditions.push(eq(expense.categoryId, filters.categoryId));
	if (filters.reviewStatus) conditions.push(eq(expense.reviewStatus, filters.reviewStatus));
	if (filters.paymentStatus) conditions.push(eq(expense.paymentStatus, filters.paymentStatus));
	if (filters.q) {
		const pattern = `%${filters.q}%`;
		conditions.push(
			or(
				ilike(expense.description, pattern),
				ilike(expense.vendor, pattern),
				ilike(expense.paymentMethod, pattern),
				ilike(expense.costCenter, pattern),
				ilike(vendor.name, pattern),
				ilike(paymentMethod.name, pattern),
				ilike(costCenter.name, pattern)
			)!
		);
	}

	const cursor = includeCursor ? decodeExpenseCursor(filters.cursor) : null;
	if (cursor) {
		conditions.push(
			or(
				lt(expense.expenseDate, cursor.date),
				and(eq(expense.expenseDate, cursor.date), lt(expense.id, cursor.id))
			)!
		);
	}

	return conditions;
}

export async function createExpense(context: WorkspaceContext, input: ExpenseInput) {
	if (!canWriteExpenses(context.role)) throw error(403, 'Permissao insuficiente.');
	await assertCategoryInWorkspace(context.workspaceId, input.categoryId);
	const catalogSelection = await resolveExpenseCatalogSelection(context.workspaceId, input);
	const amountCents = parseBrlToCents(input.amount);
	const installments = input.installments ?? 1;
	const installmentGroupId = installments > 1 ? randomToken(12) : null;
	const reviewStatus = canReviewExpenses(context.role) ? 'approved' : 'pending';
	const reviewedByUserId = reviewStatus === 'approved' ? context.userId : null;
	const reviewedAt = reviewStatus === 'approved' ? new Date() : null;
	const competencyMonth = input.competencyMonth ? startOfMonth(input.competencyMonth) : null;

	const created = await db.transaction(async (tx) => {
		const rows = await tx
			.insert(expense)
			.values(
				Array.from({ length: installments }, (_, index) => ({
					workspaceId: context.workspaceId,
					categoryId: input.categoryId,
					createdByUserId: context.userId,
					description: input.description,
					amountCents,
					expenseDate: addMonths(input.expenseDate, index),
					paymentMethodId: catalogSelection.paymentMethodId,
					paymentMethod: catalogSelection.paymentMethodName,
					vendorId: catalogSelection.vendorId,
					vendor: catalogSelection.vendorName,
					costCenterId: catalogSelection.costCenterId,
					costCenter: catalogSelection.costCenterName,
					competencyMonth: competencyMonth ? addMonths(competencyMonth, index) : null,
					notes: input.notes || null,
					reviewStatus,
					reviewedByUserId,
					reviewedAt,
					installmentGroupId,
					installmentNumber: installments > 1 ? index + 1 : null,
					installmentsTotal: installments > 1 ? installments : null
				}))
			)
			.returning({ id: expense.id });

		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: installments > 1 ? 'expense.installments_created' : 'expense.created',
			entityType: 'expense',
			entityId: String(rows[0].id),
			metadata: { count: rows.length, installments, reviewStatus }
		});

		return rows;
	});

	return { id: created[0].id, ids: created.map((row) => row.id) };
}

export async function updateExpense(context: WorkspaceContext, id: number, input: ExpenseInput) {
	if (!canWriteExpenses(context.role)) throw error(403, 'Permissao insuficiente.');
	await assertCategoryInWorkspace(context.workspaceId, input.categoryId);
	const [current] = await db
		.select({
			paymentMethodId: expense.paymentMethodId,
			vendorId: expense.vendorId,
			costCenterId: expense.costCenterId
		})
		.from(expense)
		.where(
			and(
				eq(expense.id, id),
				eq(expense.workspaceId, context.workspaceId),
				isNull(expense.deletedAt)
			)
		)
		.limit(1);
	if (!current) throw error(404, 'Despesa não encontrada.');
	const catalogSelection = await resolveExpenseCatalogSelection(context.workspaceId, input, {
		allowedArchivedIds: current
	});

	const [updated] = await db
		.update(expense)
		.set({
			categoryId: input.categoryId,
			description: input.description,
			amountCents: parseBrlToCents(input.amount),
			expenseDate: input.expenseDate,
			paymentMethodId: catalogSelection.paymentMethodId,
			paymentMethod: catalogSelection.paymentMethodName,
			vendorId: catalogSelection.vendorId,
			vendor: catalogSelection.vendorName,
			costCenterId: catalogSelection.costCenterId,
			costCenter: catalogSelection.costCenterName,
			competencyMonth: input.competencyMonth ? startOfMonth(input.competencyMonth) : null,
			notes: input.notes || null
		})
		.where(
			and(
				eq(expense.id, id),
				eq(expense.workspaceId, context.workspaceId),
				isNull(expense.deletedAt)
			)
		)
		.returning({ id: expense.id });

	if (!updated) throw error(404, 'Despesa não encontrada.');

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'expense.updated',
		entityType: 'expense',
		entityId: id
	});
}

export async function reviewExpense(
	context: WorkspaceContext,
	id: number,
	input: { reviewStatus: 'approved' | 'rejected'; reason?: string | null }
) {
	if (!canReviewExpenses(context.role)) throw error(403, 'Permissao insuficiente.');

	const reviewedAt = new Date();
	const reviewUpdate =
		input.reviewStatus === 'rejected'
			? {
					reviewStatus: input.reviewStatus,
					reviewedByUserId: context.userId,
					reviewedAt,
					reviewRejectionReason: input.reason || null,
					paymentStatus: 'unpaid' as const,
					paidAt: null,
					reconciledAt: null,
					reconciledByUserId: null
				}
			: {
					reviewStatus: input.reviewStatus,
					reviewedByUserId: context.userId,
					reviewedAt,
					reviewRejectionReason: null
				};

	const [updated] = await db
		.update(expense)
		.set(reviewUpdate)
		.where(
			and(
				eq(expense.id, id),
				eq(expense.workspaceId, context.workspaceId),
				isNull(expense.deletedAt)
			)
		)
		.returning({ id: expense.id });

	if (!updated) throw error(404, 'Despesa não encontrada.');

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: `expense.${input.reviewStatus}`,
		entityType: 'expense',
		entityId: id,
		metadata: input.reason ? { reason: input.reason } : undefined
	});
}

export async function updateExpensePaymentStatus(
	context: WorkspaceContext,
	id: number,
	input: { paymentStatus: 'unpaid' | 'paid' | 'reconciled'; paidAt?: string | null }
) {
	if (!canReconcileExpenses(context.role)) throw error(403, 'Permissao insuficiente.');

	const paidAt = input.paymentStatus === 'unpaid' ? null : (input.paidAt ?? todayIsoDate());
	const [updated] = await db
		.update(expense)
		.set({
			paymentStatus: input.paymentStatus,
			paidAt,
			reconciledAt: input.paymentStatus === 'reconciled' ? new Date() : null,
			reconciledByUserId: input.paymentStatus === 'reconciled' ? context.userId : null
		})
		.where(
			and(
				eq(expense.id, id),
				eq(expense.workspaceId, context.workspaceId),
				eq(expense.reviewStatus, 'approved'),
				isNull(expense.deletedAt)
			)
		)
		.returning({ id: expense.id });

	if (!updated) throw error(404, 'Despesa aprovada não encontrada.');

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: `expense.payment_${input.paymentStatus}`,
		entityType: 'expense',
		entityId: id,
		metadata: { paidAt }
	});
}

export async function deleteExpense(context: WorkspaceContext, id: number) {
	if (!canWriteExpenses(context.role)) throw error(403, 'Permissao insuficiente.');

	const [deleted] = await db
		.update(expense)
		.set({ deletedAt: new Date() })
		.where(
			and(
				eq(expense.id, id),
				eq(expense.workspaceId, context.workspaceId),
				isNull(expense.deletedAt)
			)
		)
		.returning({ id: expense.id });

	if (!deleted) throw error(404, 'Despesa não encontrada.');

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'expense.deleted',
		entityType: 'expense',
		entityId: id
	});
}

export async function getDashboard(context: WorkspaceContext, from?: string, to?: string) {
	const today = new Date();
	from ??= firstDayOfMonth(today, context.timezone);
	to ??= lastDayOfMonth(today, context.timezone);
	const previous = previousPeriod(from, to);
	const [currentTotal, previousTotal] = await Promise.all([
		getTotal(context.workspaceId, from, to),
		getTotal(context.workspaceId, previous.from, previous.to)
	]);
	const deltaPct =
		previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : null;

	const [byCategory, byWeek, byMonth, byPaymentMethod, budgetSummary] = await Promise.all([
		getTotalsByCategory(context.workspaceId, from, to),
		getTotalsByPeriod(context.workspaceId, from, to, 'week', undefined, context.weekStartsOn),
		getTotalsByPeriod(context.workspaceId, from, to, 'month', undefined, context.weekStartsOn),
		getTotalsByPaymentMethod(context.workspaceId, from, to),
		getBudgetSummary(context, startOfMonth(from))
	]);

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
	input: {
		from: string;
		to: string;
		groupBy: 'category' | 'week' | 'month' | 'year' | 'payment';
		categoryId?: number;
	}
) {
	if (input.groupBy === 'category') {
		return getTotalsByCategory(context.workspaceId, input.from, input.to, input.categoryId);
	}

	if (input.groupBy === 'payment') {
		return getTotalsByPaymentMethod(context.workspaceId, input.from, input.to, input.categoryId);
	}

	return getTotalsByPeriod(
		context.workspaceId,
		input.from,
		input.to,
		input.groupBy,
		input.categoryId,
		context.weekStartsOn
	);
}

async function getTotalsByPaymentMethod(
	workspaceId: number,
	from: string,
	to: string,
	categoryId?: number
) {
	const result = await db.execute<{
		label: string;
		total_cents: string | number;
	}>(sql`
		select coalesce(nullif(trim(pm.name), ''), nullif(trim(e.payment_method), ''), 'Nao informado') as label,
			coalesce(sum(e.amount_cents), 0)::bigint as total_cents
		from expense e
		left join payment_method pm on pm.id = e.payment_method_id and pm.workspace_id = e.workspace_id
		where e.workspace_id = ${workspaceId}
			and e.deleted_at is null
			and e.status = 'posted'
			and e.review_status = 'approved'
			and e.expense_date >= ${from}
			and e.expense_date <= ${to}
			${categoryId ? sql`and e.category_id = ${categoryId}` : sql``}
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
		select coalesce(sum(amount_cents), 0)::bigint as total_cents
		from expense
		where workspace_id = ${workspaceId}
			and deleted_at is null
			and status = 'posted'
			and review_status = 'approved'
			and expense_date >= ${from}
			and expense_date <= ${to}
	`);

	return Number(result[0]?.total_cents ?? 0);
}

async function getTotalsByCategory(
	workspaceId: number,
	from: string,
	to: string,
	categoryId?: number
) {
	const result = await db.execute<{
		category_id: number;
		name: string;
		color: string;
		total_cents: string | number;
	}>(sql`
		select c.id as category_id, c.name, c.color, coalesce(sum(e.amount_cents), 0)::bigint as total_cents
		from expense e
		inner join category c on c.id = e.category_id
		where e.workspace_id = ${workspaceId}
			and e.deleted_at is null
			and e.status = 'posted'
			and e.review_status = 'approved'
			and e.expense_date >= ${from}
			and e.expense_date <= ${to}
			${categoryId ? sql`and e.category_id = ${categoryId}` : sql``}
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
	from: string,
	to: string,
	groupBy: 'week' | 'month' | 'year',
	categoryId?: number,
	weekStartsOn = 1
) {
	const bucket =
		groupBy === 'week'
			? sql`(e.expense_date - (((extract(dow from e.expense_date)::int - ${weekStartsOn} + 7) % 7) * interval '1 day'))::date`
			: sql`date_trunc(${groupBy === 'month' ? 'month' : 'year'}, e.expense_date::timestamp)::date`;
	const result = await db.execute<{ bucket: string; total_cents: string | number }>(sql`
		select ${bucket} as bucket,
			coalesce(sum(e.amount_cents), 0)::bigint as total_cents
		from expense e
		where e.workspace_id = ${workspaceId}
			and e.deleted_at is null
			and e.status = 'posted'
			and e.review_status = 'approved'
			and e.expense_date >= ${from}
			and e.expense_date <= ${to}
			${categoryId ? sql`and e.category_id = ${categoryId}` : sql``}
		group by bucket
		order by bucket asc
	`);

	return result.map((row) => ({
		key: String(row.bucket),
		label: String(row.bucket),
		totalCents: Number(row.total_cents)
	}));
}

function todayIsoDate() {
	return new Date().toISOString().slice(0, 10);
}
