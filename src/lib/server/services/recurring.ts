import { error } from '@sveltejs/kit';
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { advisoryLockClient, db } from '$lib/server/db';
import {
	auditEvent,
	category,
	expense,
	paymentMethod,
	recurringExpense,
	workspace,
	workspaceMember
} from '$lib/server/db/schema';
import { canReviewExpenses, canWriteExpenses } from '$lib/server/security/roles';
import { advanceDate, todayIso } from '$lib/server/utils/date';
import { parseCurrencyToCents } from '$lib/server/utils/money';
import { assertCategoryInWorkspace } from '$lib/server/utils/category';
import { translate } from '$lib/i18n';
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
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
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
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const [updated] = await db
		.update(recurringExpense)
		.set({ status })
		.where(and(eq(recurringExpense.id, id), eq(recurringExpense.workspaceId, context.workspaceId)))
		.returning({ id: recurringExpense.id });

	if (!updated) throw error(404, translate(context.locale, 'Recurring expense not found.'));

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
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

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

/**
 * System-wide scheduler that materializes due recurring expenses across all
 * workspaces. Runs without user authentication context — uses the workspace
 * owner as the actor (for audit attribution) but synthesises a 'member' role
 * so all generated expenses start as 'pending' and require explicit review.
 * This is the safe policy for unattended background jobs.
 *
 * Uses a Postgres session-level advisory lock (pg_try_advisory_lock) so that
 * only one instance runs the scheduler at a time in a multi-node deployment.
 * The lock is explicitly released on the same dedicated connection. If a
 * second instance tries to acquire it while the first is still running, it
 * skips this scheduler cycle and returns early.
 */
// Constant advisory-lock key shared across all instances and deployments.
// pg_advisory_lock keys are per-database, so any stable value works as long as
// it does not collide with another advisory lock in this application. Kept within
// JS safe-integer range so it can be passed as a plain number parameter.
const SCHEDULER_LOCK_KEY = 7_273_299_171;

export async function runRecurringExpenseScheduler(): Promise<{
	processed: number;
	created: number;
	errors: number;
}> {
	// pg_try_advisory_lock is session-bound, so acquire and release it on one
	// reserved connection. This uses a dedicated one-connection client rather
	// than the application pool; otherwise DB_POOL_MAX=1 would deadlock as soon
	// as runSchedulerWithLock() issued a query through `db`.
	const reserved = await advisoryLockClient.reserve();
	try {
		const lockResult = await reserved<{ acquired: boolean }[]>`
			SELECT pg_try_advisory_lock(${SCHEDULER_LOCK_KEY}) AS acquired
		`;

		if (!lockResult[0]?.acquired) {
			// Another instance is already running the scheduler — skip this cycle.
			return { processed: 0, created: 0, errors: 0 };
		}

		try {
			return await runSchedulerWithLock();
		} finally {
			await reserved`SELECT pg_advisory_unlock(${SCHEDULER_LOCK_KEY})`;
		}
	} finally {
		// Return the pinned connection to the pool.
		reserved.release();
	}
}

async function runSchedulerWithLock(): Promise<{
	processed: number;
	created: number;
	errors: number;
}> {
	const asOf = todayIso();

	// Find all workspace IDs that have at least one active recurring expense due.
	// This leverages the recurring_expense_workspace_next_run_idx partial index.
	const dueRows = await db
		.selectDistinct({ workspaceId: recurringExpense.workspaceId })
		.from(recurringExpense)
		.where(and(eq(recurringExpense.status, 'active'), lte(recurringExpense.nextRunDate, asOf)));

	if (dueRows.length === 0) {
		return { processed: 0, created: 0, errors: 0 };
	}

	let totalCreated = 0;
	let errorCount = 0;

	for (const { workspaceId } of dueRows) {
		try {
			// Load workspace currency and its owner's user ID in a single query.
			const [row] = await db
				.select({
					currency: workspace.currency,
					workspaceName: workspace.name,
					weekStartsOn: workspace.weekStartsOn,
					userId: workspaceMember.userId
				})
				.from(workspace)
				.innerJoin(
					workspaceMember,
					and(
						eq(workspaceMember.workspaceId, workspace.id),
						eq(workspaceMember.role, 'owner'),
						eq(workspaceMember.status, 'active')
					)
				)
				.where(eq(workspace.id, workspaceId))
				.orderBy(asc(workspaceMember.createdAt))
				.limit(1);

			if (!row) {
				// No active owner found — skip this workspace gracefully.
				console.warn(
					JSON.stringify({
						level: 'warn',
						message: 'recurring_scheduler: no active owner for workspace, skipping',
						workspaceId
					})
				);
				continue;
			}

			const context: WorkspaceContext = {
				userId: row.userId,
				workspaceId,
				workspaceName: row.workspaceName,
				currency: row.currency,
				locale: 'en',
				weekStartsOn: row.weekStartsOn,
				// Use 'member' so the scheduler never auto-approves: only
				// canWriteExpenses passes (rank 2 >= 2), while canReviewExpenses
				// requires admin/owner (rank >= 3). All scheduler-generated expenses
				// therefore start as 'pending' and require an explicit human review.
				role: 'member'
			};

			const { createdCount } = await materializeDueRecurringExpenses(context, asOf);
			totalCreated += createdCount;
		} catch (err) {
			errorCount++;
			console.error(
				JSON.stringify({
					level: 'error',
					message: 'recurring_scheduler: failed to process workspace',
					workspaceId,
					error: err instanceof Error ? err.message : String(err)
				})
			);
		}
	}

	console.info(
		JSON.stringify({
			level: 'info',
			message: 'recurring_scheduler: run complete',
			processed: dueRows.length,
			created: totalCreated,
			errors: errorCount,
			asOf
		})
	);

	return { processed: dueRows.length, created: totalCreated, errors: errorCount };
}
