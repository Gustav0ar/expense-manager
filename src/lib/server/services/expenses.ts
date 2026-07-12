import { error } from '@sveltejs/kit';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	auditEvent,
	attachmentDeletion,
	category,
	costCenter,
	expense,
	expenseAttachment,
	paymentMethod,
	vendor
} from '$lib/server/db/schema';
import type { WorkspaceContext } from './workspaces';
import { buildExpenseConditions } from './expense-conditions';
import { lockWorkspaceCurrency } from './workspace-currency';
import {
	canReconcileExpenses,
	canReviewExpenses,
	canWriteExpenses
} from '$lib/server/security/roles';
import { parseCurrencyToCents } from '$lib/server/utils/money';
import { assertCategoryInWorkspace } from '$lib/server/utils/category';
import { encodeExpenseCursor } from '$lib/server/utils/cursor';
import { addMonths, startOfMonth, todayIso } from '$lib/server/utils/date';
import { insertAuditEvent } from './audit';
import { randomToken } from '$lib/server/utils/crypto';
import { resolveExpenseCatalogSelection } from './expense-catalogs';
import { translate } from '$lib/i18n';
import { attachmentDeletionGraceMs, buildAttachmentDeletionRows } from './attachment-deletion';
import { expenseTrashDates } from './expense-trash';
import {
	isLinkedReconciliationCompatible,
	lockLinkedBankTransaction,
	reverseLinkedBankTransaction
} from './reconciliation-integrity';

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
	vendorId?: number;
	costCenterId?: number;
	competencyMonth?: string;
	reviewStatus?: 'pending' | 'approved' | 'rejected';
	paymentStatus?: 'unpaid' | 'paid' | 'reconciled';
	q?: string;
	cursor?: string;
	limit?: number;
};

export type GroupedReportGroupBy =
	'category' | 'week' | 'month' | 'year' | 'payment' | 'vendor' | 'costCenter';
export type ReportGroupBy = GroupedReportGroupBy | 'expense';

export type AnalyticalExpenseReportFilters = Omit<ExpenseFilters, 'cursor' | 'limit'> & {
	from: string;
	to: string;
};

export type GroupedReportFilters = Pick<
	AnalyticalExpenseReportFilters,
	| 'from'
	| 'to'
	| 'categoryId'
	| 'vendorId'
	| 'costCenterId'
	| 'competencyMonth'
	| 'reviewStatus'
	| 'paymentStatus'
>;

export type AnalyticalExpenseReportRow = {
	id: number;
	expenseDate: string;
	competencyMonth: string | null;
	description: string;
	categoryName: string;
	categoryColor: string;
	categoryIcon: string | null;
	amountCents: number;
	currency: string;
	paymentMethod: string | null;
	vendor: string | null;
	costCenter: string | null;
	reviewStatus: 'pending' | 'approved' | 'rejected';
	paymentStatus: 'unpaid' | 'paid' | 'reconciled';
	paidAt: string | null;
	installmentNumber: number | null;
	installmentsTotal: number | null;
	notes: string | null;
	attachmentCount: number;
	createdAt: Date;
};

export type AnalyticalExpenseReport = {
	items: AnalyticalExpenseReportRow[];
	summary: {
		itemCount: number;
		totalCents: number;
		approvedCents: number;
		pendingCents: number;
		rejectedCents: number;
		paidCents: number;
		unpaidCents: number;
		reconciledCents: number;
	};
	limit: number;
	truncated: boolean;
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
						and(
							inArray(
								expenseAttachment.expenseId,
								baseItems.map((item) => item.id)
							),
							isNull(expenseAttachment.deletedAt)
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
		// innerJoin category to match the listExpenses behaviour: orphaned expenses
		// (whose categoryId no longer resolves) are excluded from both count and list.
		.innerJoin(category, eq(category.id, expense.categoryId))
		.leftJoin(paymentMethod, eq(paymentMethod.id, expense.paymentMethodId))
		.leftJoin(vendor, eq(vendor.id, expense.vendorId))
		.leftJoin(costCenter, eq(costCenter.id, expense.costCenterId))
		.where(and(...buildExpenseConditions(context.workspaceId, filters, false)));

	return {
		itemCount: Number(row?.itemCount ?? 0),
		totalCents: Number(row?.totalCents ?? 0)
	};
}

export async function createExpense(
	context: WorkspaceContext,
	input: ExpenseInput,
	options: { afterCurrencyLock?: () => Promise<void> } = {}
) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	await assertCategoryInWorkspace(context.workspaceId, input.categoryId, context.locale);
	const catalogSelection = await resolveExpenseCatalogSelection(context.workspaceId, input, {
		locale: context.locale
	});
	const amountCents = parseCurrencyToCents(input.amount);
	const installments = input.installments ?? 1;
	const installmentGroupId = installments > 1 ? randomToken(12) : null;
	const reviewStatus = canReviewExpenses(context.role) ? 'approved' : 'pending';
	const reviewedByUserId = reviewStatus === 'approved' ? context.userId : null;
	const reviewedAt = reviewStatus === 'approved' ? new Date() : null;
	const competencyMonth = input.competencyMonth ? startOfMonth(input.competencyMonth) : null;

	const created = await db.transaction(async (tx) => {
		const currentCurrency = await lockWorkspaceCurrency(tx, context.workspaceId);
		await options.afterCurrencyLock?.();
		const rows = await tx
			.insert(expense)
			.values(
				Array.from({ length: installments }, (_, index) => ({
					workspaceId: context.workspaceId,
					categoryId: input.categoryId,
					createdByUserId: context.userId,
					description: input.description,
					amountCents,
					currency: currentCurrency,
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
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	await assertCategoryInWorkspace(context.workspaceId, input.categoryId, context.locale);
	const [snapshot] = await db
		.select({
			paymentMethodId: expense.paymentMethodId,
			vendorId: expense.vendorId,
			costCenterId: expense.costCenterId,
			reviewStatus: expense.reviewStatus,
			paymentStatus: expense.paymentStatus
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
	if (!snapshot) throw error(404, translate(context.locale, 'Expense not found.'));
	if (snapshot.paymentStatus !== 'unpaid' && !canReconcileExpenses(context.role)) {
		throw error(403, translate(context.locale, 'Permission denied.'));
	}

	const catalogSelection = await resolveExpenseCatalogSelection(context.workspaceId, input, {
		allowedArchivedIds: snapshot,
		locale: context.locale
	});
	const shouldResetReview = !canReviewExpenses(context.role);
	const amountCents = parseCurrencyToCents(input.amount);
	const competencyMonth = input.competencyMonth ? startOfMonth(input.competencyMonth) : null;

	await db.transaction(async (tx) => {
		const currentCurrency = await lockWorkspaceCurrency(tx, context.workspaceId);
		let linked = await lockLinkedBankTransaction(tx, context.workspaceId, id);
		const [current] = await tx
			.select()
			.from(expense)
			.where(
				and(
					eq(expense.id, id),
					eq(expense.workspaceId, context.workspaceId),
					isNull(expense.deletedAt)
				)
			)
			.limit(1)
			.for('update');
		if (!current) throw error(404, translate(context.locale, 'Expense not found.'));
		if (current.paymentStatus !== 'unpaid' && !canReconcileExpenses(context.role))
			throw error(403, translate(context.locale, 'Permission denied.'));
		// A match may have committed while this transaction waited for the expense row.
		linked ??= await lockLinkedBankTransaction(tx, context.workspaceId, id);
		const nextState = {
			...current,
			amountCents,
			currency: currentCurrency,
			expenseDate: input.expenseDate,
			reviewStatus: shouldResetReview ? 'pending' : current.reviewStatus,
			paymentStatus: shouldResetReview ? 'unpaid' : current.paymentStatus
		};
		const reversesReconciliation =
			linked !== null && !isLinkedReconciliationCompatible(linked, nextState);
		if (reversesReconciliation) {
			await reverseLinkedBankTransaction(tx, {
				actorUserId: context.userId,
				expenseId: id,
				linked,
				reason: 'expense_edited',
				workspaceId: context.workspaceId
			});
		}
		const [updated] = await tx
			.update(expense)
			.set({
				categoryId: input.categoryId,
				description: input.description,
				amountCents,
				currency: currentCurrency,
				expenseDate: input.expenseDate,
				paymentMethodId: catalogSelection.paymentMethodId,
				paymentMethod: catalogSelection.paymentMethodName,
				vendorId: catalogSelection.vendorId,
				vendor: catalogSelection.vendorName,
				costCenterId: catalogSelection.costCenterId,
				costCenter: catalogSelection.costCenterName,
				competencyMonth,
				notes: input.notes || null,
				...(shouldResetReview
					? {
							reviewStatus: 'pending' as const,
							reviewedByUserId: null,
							reviewedAt: null,
							reviewRejectionReason: null,
							paymentStatus: 'unpaid' as const,
							paidAt: null,
							reconciledAt: null,
							reconciledByUserId: null
						}
					: reversesReconciliation
						? {
								paymentStatus: 'paid' as const,
								reconciledAt: null,
								reconciledByUserId: null
							}
						: {})
			})
			.where(
				and(
					eq(expense.id, id),
					eq(expense.workspaceId, context.workspaceId),
					isNull(expense.deletedAt)
				)
			)
			.returning({ id: expense.id });

		if (!updated)
			throw error(409, translate(context.locale, 'Expense was modified. Reload and try again.'));

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'expense.updated',
			entityType: 'expense',
			entityId: id,
			metadata:
				shouldResetReview || reversesReconciliation
					? {
							...(shouldResetReview ? { reviewStatus: 'pending' } : {}),
							...(reversesReconciliation ? { reconciliationReversed: true } : {})
						}
					: undefined
		});
	});
}

export async function reviewExpense(
	context: WorkspaceContext,
	id: number,
	input: { reviewStatus: 'approved' | 'rejected'; reason?: string | null }
) {
	if (!canReviewExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	if (input.reviewStatus === 'rejected' && !input.reason?.trim()) {
		throw error(400, translate(context.locale, 'Check review data.'));
	}

	const reviewedAt = new Date();
	await db.transaction(async (tx) => {
		let linked = await lockLinkedBankTransaction(tx, context.workspaceId, id);
		const [current] = await tx
			.select()
			.from(expense)
			.where(
				and(
					eq(expense.id, id),
					eq(expense.workspaceId, context.workspaceId),
					isNull(expense.deletedAt)
				)
			)
			.limit(1)
			.for('update');
		if (!current) throw error(404, translate(context.locale, 'Expense not found.'));
		if (
			input.reviewStatus === 'rejected' &&
			current.paymentStatus !== 'unpaid' &&
			!canReconcileExpenses(context.role)
		)
			throw error(403, translate(context.locale, 'Cannot reject a paid or reconciled expense.'));
		linked ??= await lockLinkedBankTransaction(tx, context.workspaceId, id);
		if (input.reviewStatus === 'rejected' && linked) {
			await reverseLinkedBankTransaction(tx, {
				actorUserId: context.userId,
				expenseId: id,
				linked,
				reason: 'expense_rejected',
				workspaceId: context.workspaceId
			});
		}
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
		const [updated] = await tx
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

		if (!updated)
			throw error(
				409,
				translate(context.locale, 'Review status has changed. Reload and try again.')
			);

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: `expense.${input.reviewStatus}`,
			entityType: 'expense',
			entityId: id,
			metadata: input.reason ? { reason: input.reason } : undefined
		});
	});
}

export async function updateExpensePaymentStatus(
	context: WorkspaceContext,
	id: number,
	input: { paymentStatus: 'unpaid' | 'paid' | 'reconciled'; paidAt?: string | null }
) {
	if (!canReconcileExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	await db.transaction(async (tx) => {
		let linked = await lockLinkedBankTransaction(tx, context.workspaceId, id);
		const [current] = await tx
			.select()
			.from(expense)
			.where(
				and(
					eq(expense.id, id),
					eq(expense.workspaceId, context.workspaceId),
					eq(expense.reviewStatus, 'approved'),
					isNull(expense.deletedAt)
				)
			)
			.limit(1)
			.for('update');
		if (!current) throw error(404, translate(context.locale, 'Approved expense not found.'));
		if (input.paymentStatus === 'paid' && current.paymentStatus === 'reconciled')
			throw error(
				400,
				translate(context.locale, 'Cannot change payment status of a reconciled expense.')
			);
		linked ??= await lockLinkedBankTransaction(tx, context.workspaceId, id);
		if (linked && input.paymentStatus !== 'reconciled') {
			await reverseLinkedBankTransaction(tx, {
				actorUserId: context.userId,
				expenseId: id,
				linked,
				reason: 'payment_status_changed',
				workspaceId: context.workspaceId
			});
		}
		// When reconciling an already-paid expense, preserve the original paidAt
		// unless the caller explicitly supplies a new value.
		const paidAt =
			input.paymentStatus === 'unpaid' ? null : (input.paidAt ?? current.paidAt ?? todayIso());
		const [updated] = await tx
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

		if (!updated)
			throw error(409, translate(context.locale, 'Expense was modified. Reload and try again.'));

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: `expense.payment_${input.paymentStatus}`,
			entityType: 'expense',
			entityId: id,
			metadata: { paidAt }
		});
	});
}

export async function deleteExpense(context: WorkspaceContext, id: number) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const { deletedAt, trashExpiresAt } = expenseTrashDates();
	await db.transaction(async (tx) => {
		let linked = await lockLinkedBankTransaction(tx, context.workspaceId, id);
		const [current] = await tx
			.select()
			.from(expense)
			.where(
				and(
					eq(expense.id, id),
					eq(expense.workspaceId, context.workspaceId),
					isNull(expense.deletedAt)
				)
			)
			.limit(1)
			.for('update');
		if (!current) throw error(404, translate(context.locale, 'Expense not found.'));
		if (current.reviewStatus !== 'pending' && !canReviewExpenses(context.role))
			throw error(403, translate(context.locale, 'Permission denied.'));
		if (current.paymentStatus !== 'unpaid' && !canReconcileExpenses(context.role))
			throw error(403, translate(context.locale, 'Permission denied.'));
		linked ??= await lockLinkedBankTransaction(tx, context.workspaceId, id);
		if (linked) {
			await reverseLinkedBankTransaction(tx, {
				actorUserId: context.userId,
				expenseId: id,
				linked,
				reason: 'expense_trashed',
				workspaceId: context.workspaceId
			});
		}
		const [deleted] = await tx
			.update(expense)
			.set({
				deletedAt,
				trashExpiresAt,
				...(linked
					? {
							paymentStatus: 'paid' as const,
							reconciledAt: null,
							reconciledByUserId: null
						}
					: {})
			})
			.where(
				and(
					eq(expense.id, id),
					eq(expense.workspaceId, context.workspaceId),
					isNull(expense.deletedAt)
				)
			)
			.returning({ id: expense.id });

		if (!deleted)
			throw error(409, translate(context.locale, 'Expense was modified. Reload and try again.'));

		const rows = await tx
			.update(expenseAttachment)
			.set({ deletedAt })
			.where(and(eq(expenseAttachment.expenseId, id), isNull(expenseAttachment.deletedAt)))
			.returning({
				id: expenseAttachment.id,
				workspaceId: expenseAttachment.workspaceId,
				expenseId: expenseAttachment.expenseId,
				storageKey: expenseAttachment.storageKey,
				sizeBytes: expenseAttachment.sizeBytes,
				sha256: expenseAttachment.sha256
			});

		if (rows.length > 0) {
			await tx.insert(attachmentDeletion).values(
				buildAttachmentDeletionRows(rows, deletedAt, {
					reason: 'expense_trash',
					notBefore: new Date(trashExpiresAt.getTime() + attachmentDeletionGraceMs)
				})
			);

			await tx.insert(auditEvent).values(
				rows.map((att) => ({
					workspaceId: context.workspaceId,
					actorUserId: context.userId,
					action: 'expense_attachment.deleted' as const,
					entityType: 'expense_attachment',
					entityId: String(att.id),
					metadata: { expenseId: id, reason: 'expense_deleted' }
				}))
			);
		}

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'expense.deleted',
			entityType: 'expense',
			entityId: id,
			metadata: linked ? { reconciliationReversed: true } : undefined
		});
	});
}

export async function bulkReviewExpenses(
	context: WorkspaceContext,
	ids: number[],
	decision: 'approved' | 'rejected'
) {
	if (!canReviewExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	if (ids.length === 0) throw error(400, translate(context.locale, 'No expenses selected.'));

	const reviewedAt = new Date();

	// Bulk rejection never resets financial state. A paid/reconciled row should
	// not normally be pending, but the database permits that legacy/inconsistent
	// combination, so skip it defensively regardless of the actor's permissions.
	const paymentGuard = decision === 'rejected' ? eq(expense.paymentStatus, 'unpaid') : sql`true`;

	const updated = await db.transaction(async (tx) => {
		const rows = await tx
			.update(expense)
			.set({
				reviewStatus: decision,
				reviewedByUserId: context.userId,
				reviewedAt,
				reviewRejectionReason: null,
				...(decision === 'rejected'
					? {
							paymentStatus: 'unpaid' as const,
							paidAt: null,
							reconciledAt: null,
							reconciledByUserId: null
						}
					: {})
			})
			.where(
				and(
					inArray(expense.id, ids),
					eq(expense.workspaceId, context.workspaceId),
					eq(expense.status, 'posted'),
					eq(expense.reviewStatus, 'pending'),
					paymentGuard,
					isNull(expense.deletedAt)
				)
			)
			.returning({ id: expense.id });

		if (rows.length > 0) {
			await insertAuditEvent(tx, {
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: `expense.bulk_${decision}`,
				entityType: 'expense',
				entityId: rows[0].id,
				metadata: { ids: rows.map((row) => row.id), count: rows.length, decision }
			});
		}

		return rows;
	});

	return { count: updated.length };
}

export {
	analyticalReportExportBatchSize,
	analyticalReportUiLimit,
	getAnalyticalExpenseReport,
	getDashboard,
	getReport,
	streamAnalyticalExpenseReport
} from './expense-reports';
