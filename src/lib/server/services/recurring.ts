import { error } from '@sveltejs/kit';
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	auditEvent,
	category,
	expense,
	paymentMethod,
	recurringExpense
} from '$lib/server/db/schema';
import { canReviewExpenses, canWriteExpenses } from '$lib/server/security/roles';
import { advanceDate, todayIso } from '$lib/server/utils/date';
import { parseCurrencyToCents } from '$lib/server/utils/money';
import { assertCategoryInWorkspace } from '$lib/server/utils/category';
import type { WorkspaceContext } from './workspaces';
import { resolveExpenseCatalogSelection } from './expense-catalogs';

export type RecurringExpenseInput = {
	categoryId: number;
	description: string;
	amount: string;
	frequency: 'weekly' | 'monthly' | 'yearly';
	intervalCount: number;
	startDate: string;
	endDate?: string | null;
	paymentMethodId?: number | null;
	notes?: string | null;
};

export async function listRecurringExpenses(context: WorkspaceContext) {
	return db
		.select({
			id: recurringExpense.id,
			description: recurringExpense.description,
			amountCents: recurringExpense.amountCents,
			frequency: recurringExpense.frequency,
			intervalCount: recurringExpense.intervalCount,
			startDate: recurringExpense.startDate,
			nextRunDate: recurringExpense.nextRunDate,
			endDate: recurringExpense.endDate,
			paymentMethodId: recurringExpense.paymentMethodId,
			paymentMethod: sql<
				string | null
			>`coalesce(${paymentMethod.name}, ${recurringExpense.paymentMethod})`,
			notes: recurringExpense.notes,
			status: recurringExpense.status,
			categoryId: category.id,
			categoryName: category.name,
			categoryColor: category.color,
			categoryIcon: category.icon
		})
		.from(recurringExpense)
		.innerJoin(category, eq(category.id, recurringExpense.categoryId))
		.leftJoin(paymentMethod, eq(paymentMethod.id, recurringExpense.paymentMethodId))
		.where(eq(recurringExpense.workspaceId, context.workspaceId))
		.orderBy(asc(recurringExpense.nextRunDate), asc(recurringExpense.description));
}

export async function createRecurringExpense(
	context: WorkspaceContext,
	input: RecurringExpenseInput
) {
	if (!canWriteExpenses(context.role)) throw error(403, 'Permission denied.');
	await assertCategoryInWorkspace(context.workspaceId, input.categoryId);

	const catalogSelection = await resolveExpenseCatalogSelection(context.workspaceId, input, {
		locale: context.locale
	});
	const amountCents = parseCurrencyToCents(input.amount);

	return db.transaction(async (tx) => {
		const [created] = await tx
			.insert(recurringExpense)
			.values({
				workspaceId: context.workspaceId,
				categoryId: input.categoryId,
				createdByUserId: context.userId,
				description: input.description,
				amountCents,
				currency: context.currency,
				frequency: input.frequency,
				intervalCount: input.intervalCount,
				startDate: input.startDate,
				nextRunDate: input.startDate,
				endDate: input.endDate || null,
				paymentMethodId: catalogSelection.paymentMethodId,
				paymentMethod: catalogSelection.paymentMethodName,
				notes: input.notes || null
			})
			.returning({ id: recurringExpense.id });

		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'recurring_expense.created',
			entityType: 'recurring_expense',
			entityId: String(created.id)
		});

		return created;
	});
}

export async function setRecurringExpenseStatus(
	context: WorkspaceContext,
	id: number,
	status: 'active' | 'paused'
) {
	if (!canWriteExpenses(context.role)) throw error(403, 'Permission denied.');

	const [updated] = await db
		.update(recurringExpense)
		.set({ status })
		.where(and(eq(recurringExpense.id, id), eq(recurringExpense.workspaceId, context.workspaceId)))
		.returning({ id: recurringExpense.id });

	if (!updated) throw error(404, 'Recurring expense not found.');

	await db.insert(auditEvent).values({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: status === 'active' ? 'recurring_expense.resumed' : 'recurring_expense.paused',
		entityType: 'recurring_expense',
		entityId: String(id)
	});
}

export async function materializeDueRecurringExpenses(
	context: WorkspaceContext,
	asOf = todayIso()
) {
	if (!canWriteExpenses(context.role)) throw error(403, 'Permission denied.');

	// Pause schedules whose endDate has already passed nextRunDate but were
	// never selected by the main query (because they aren't due). Without this,
	// they remain status='active' indefinitely.
	await db
		.update(recurringExpense)
		.set({ status: 'paused' })
		.where(
			and(
				eq(recurringExpense.workspaceId, context.workspaceId),
				eq(recurringExpense.status, 'active'),
				lt(recurringExpense.endDate, recurringExpense.nextRunDate)
			)
		);

	const schedules = await db
		.select()
		.from(recurringExpense)
		.where(
			and(
				eq(recurringExpense.workspaceId, context.workspaceId),
				eq(recurringExpense.status, 'active'),
				lte(recurringExpense.nextRunDate, asOf),
				or(
					sql`${recurringExpense.endDate} is null`,
					gte(recurringExpense.endDate, recurringExpense.nextRunDate)
				)
			)
		)
		.orderBy(asc(recurringExpense.nextRunDate), asc(recurringExpense.id))
		.limit(50);

	if (schedules.length === 0) return { createdCount: 0 };

	let createdCount = 0;
	const reviewStatus = canReviewExpenses(context.role) ? 'approved' : 'pending';
	const reviewedByUserId = reviewStatus === 'approved' ? context.userId : null;
	const reviewedAt = reviewStatus === 'approved' ? new Date() : null;

	await db.transaction(async (tx) => {
		for (const schedule of schedules) {
			const dates: string[] = [];
			let nextRunDate = schedule.nextRunDate;

			while (nextRunDate <= asOf && dates.length < 120) {
				if (schedule.endDate && nextRunDate > schedule.endDate) break;
				dates.push(nextRunDate);
				nextRunDate = advanceDate(
					nextRunDate,
					schedule.frequency as 'weekly' | 'monthly' | 'yearly',
					schedule.intervalCount
				);
			}

			if (dates.length > 0) {
				// Filter out dates that already have a non-deleted materialized expense
				// for this schedule. The unique index is partial on deleted_at IS NULL,
				// so onConflictDoNothing cannot detect a soft-deleted duplicate. We
				// handle this explicitly to prevent accidental re-insertion when
				// nextRunDate is reset, while still allowing intentional re-creation
				// after a user deletes a specific occurrence.
				const existing = await tx
					.select({ expenseDate: expense.expenseDate })
					.from(expense)
					.where(
						and(
							eq(expense.sourceRecurringExpenseId, schedule.id),
							inArray(expense.expenseDate, dates),
							isNull(expense.deletedAt)
						)
					);
				const existingDates = new Set(existing.map((r) => r.expenseDate));
				const datesToInsert = dates.filter((d) => !existingDates.has(d));

				if (datesToInsert.length > 0) {
					const inserted = await tx
						.insert(expense)
						.values(
							datesToInsert.map((expenseDate) => ({
								workspaceId: schedule.workspaceId,
								categoryId: schedule.categoryId,
								createdByUserId: schedule.createdByUserId,
								description: schedule.description,
								amountCents: schedule.amountCents,
								currency: schedule.currency,
								expenseDate,
								paymentMethodId: schedule.paymentMethodId,
								paymentMethod: schedule.paymentMethod,
								notes: schedule.notes,
								sourceRecurringExpenseId: schedule.id,
								reviewStatus,
								reviewedByUserId,
								reviewedAt
							}))
						)
						.onConflictDoNothing()
						.returning({ id: expense.id });

					createdCount += inserted.length;
				}
			}

			const shouldPause = schedule.endDate != null && nextRunDate > schedule.endDate;
			await tx
				.update(recurringExpense)
				.set({
					nextRunDate,
					status: shouldPause ? 'paused' : schedule.status
				})
				.where(eq(recurringExpense.id, schedule.id));
		}

		if (createdCount > 0) {
			await tx.insert(auditEvent).values({
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: 'recurring_expense.materialized',
				entityType: 'recurring_expense',
				entityId: null,
				metadata: { createdCount, asOf, reviewStatus }
			});
		}
	});

	return { createdCount };
}
