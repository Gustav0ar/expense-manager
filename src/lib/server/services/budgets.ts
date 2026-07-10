import { error } from '@sveltejs/kit';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import {
	auditEvent,
	budgetAlertDelivery,
	categoryBudget,
	workspaceMember
} from '$lib/server/db/schema';
import { sendBudgetAlertEmail } from '$lib/server/email';
import { canManageBudgets } from '$lib/server/security/roles';
import { randomToken } from '$lib/server/utils/crypto';
import { startOfMonth } from '$lib/server/utils/date';
import { parseCurrencyToCents } from '$lib/server/utils/money';
import { formatCents } from '$lib/utils/format';
import { assertCategoryInWorkspace } from '$lib/server/utils/category';
import { translate } from '$lib/i18n';
import type { WorkspaceContext } from './workspaces';

export type BudgetInput = {
	categoryId: number;
	periodMonth: string;
	amount: string;
	warningThresholdPct: number;
};

type BudgetAlertSender = typeof sendBudgetAlertEmail;

type BudgetAlertDeliveryOptions = {
	send?: BudgetAlertSender;
	now?: Date;
};

const budgetAlertClaimTtlMs = 10 * 60 * 1000;

export async function listBudgetStatus(context: WorkspaceContext, periodMonth: string) {
	const month = startOfMonth(periodMonth);
	const result = await db.execute<{
		category_id: number;
		category_name: string;
		category_color: string;
		category_icon: string | null;
		budget_id: number | null;
		amount_cents: string | number | null;
		warning_threshold_pct: number | null;
		spent_cents: string | number;
	}>(sql`
		select c.id as category_id,
			c.name as category_name,
			c.color as category_color,
			c.icon as category_icon,
			b.id as budget_id,
			b.amount_cents,
			b.warning_threshold_pct,
			coalesce(sum(e.amount_cents), 0)::bigint as spent_cents
		from category c
		left join category_budget b
			on b.category_id = c.id
			and b.period_month = ${month}
		left join expense e
			on e.category_id = c.id
			and e.workspace_id = c.workspace_id
			and e.deleted_at is null
			and e.status = 'posted'
			and e.review_status = 'approved'
			and e.expense_date >= ${month}
			and e.expense_date < (${month}::date + interval '1 month')
		where c.workspace_id = ${context.workspaceId}
			and c.is_archived = false
		group by c.id, c.name, c.color, c.icon, b.id, b.amount_cents, b.warning_threshold_pct
		order by c.name asc
	`);

	return result.map((row) => {
		const amountCents = row.amount_cents == null ? null : Number(row.amount_cents);
		const spentCents = Number(row.spent_cents);
		const usagePct = amountCents ? Math.round((spentCents / amountCents) * 100) : null;
		const warningThresholdPct = row.warning_threshold_pct ?? 80;

		return {
			categoryId: Number(row.category_id),
			categoryName: row.category_name,
			categoryColor: row.category_color,
			categoryIcon: row.category_icon,
			budgetId: row.budget_id == null ? null : Number(row.budget_id),
			amountCents,
			spentCents,
			remainingCents: amountCents == null ? null : amountCents - spentCents,
			usagePct,
			warningThresholdPct,
			status:
				amountCents == null
					? 'unset'
					: spentCents > amountCents
						? 'over'
						: usagePct != null && usagePct >= warningThresholdPct
							? 'warning'
							: 'ok'
		};
	});
}

export async function getBudgetSummary(context: WorkspaceContext, periodMonth: string) {
	const items = await listBudgetStatus(context, periodMonth);
	const budgetedItems = items.filter((item) => item.amountCents != null);
	const totalBudgetCents = budgetedItems.reduce(
		(total, item) => total + (item.amountCents ?? 0),
		0
	);
	const spentCents = budgetedItems.reduce((total, item) => total + item.spentCents, 0);

	return {
		periodMonth: startOfMonth(periodMonth),
		totalBudgetCents,
		spentCents,
		remainingCents: totalBudgetCents - spentCents,
		usagePct: totalBudgetCents > 0 ? Math.round((spentCents / totalBudgetCents) * 100) : null,
		overBudgetCount: budgetedItems.filter((item) => item.status === 'over').length,
		warningCount: budgetedItems.filter((item) => item.status === 'warning').length,
		items: budgetedItems
	};
}

export async function upsertBudget(context: WorkspaceContext, input: BudgetInput) {
	if (!canManageBudgets(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	await assertCategoryInWorkspace(context.workspaceId, input.categoryId, context.locale);

	const periodMonth = startOfMonth(input.periodMonth);
	const amountCents = parseCurrencyToCents(input.amount);

	return db.transaction(async (tx) => {
		const [saved] = await tx
			.insert(categoryBudget)
			.values({
				workspaceId: context.workspaceId,
				categoryId: input.categoryId,
				periodMonth,
				amountCents,
				warningThresholdPct: input.warningThresholdPct,
				createdByUserId: context.userId
			})
			.onConflictDoUpdate({
				target: [categoryBudget.workspaceId, categoryBudget.categoryId, categoryBudget.periodMonth],
				set: {
					amountCents,
					warningThresholdPct: input.warningThresholdPct,
					updatedAt: new Date()
				}
			})
			.returning({ id: categoryBudget.id });

		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'budget.upserted',
			entityType: 'category_budget',
			entityId: String(saved.id),
			metadata: { categoryId: input.categoryId, periodMonth }
		});

		return saved;
	});
}

export async function deleteBudget(context: WorkspaceContext, id: number) {
	if (!canManageBudgets(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const [deleted] = await db
		.delete(categoryBudget)
		.where(and(eq(categoryBudget.id, id), eq(categoryBudget.workspaceId, context.workspaceId)))
		.returning({ id: categoryBudget.id, categoryId: categoryBudget.categoryId });

	if (!deleted) throw error(404, translate(context.locale, 'Budget not found.'));

	await db.insert(auditEvent).values({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'budget.deleted',
		entityType: 'category_budget',
		entityId: String(id),
		metadata: { categoryId: deleted.categoryId }
	});
}

export async function sendBudgetAlerts(
	context: WorkspaceContext,
	periodMonth: string,
	options: BudgetAlertDeliveryOptions = {}
) {
	if (!canManageBudgets(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const month = startOfMonth(periodMonth);
	const now = options.now ?? new Date();
	const send = options.send ?? sendBudgetAlertEmail;

	// Preserve the pre-ledger behavior for months that were already marked sent
	// before this table existed. Once a delivery row exists, it is the source of
	// truth and a failed recipient remains independently retryable.
	const [existingDelivery] = await db
		.select({ id: budgetAlertDelivery.id })
		.from(budgetAlertDelivery)
		.where(
			and(
				eq(budgetAlertDelivery.workspaceId, context.workspaceId),
				eq(budgetAlertDelivery.periodMonth, month)
			)
		)
		.limit(1);
	if (!existingDelivery && (await hasLegacyBudgetAlertMarker(context.workspaceId, month))) {
		return {
			sentCount: 0,
			failedCount: 0,
			alertCount: 0,
			alreadySent: true,
			inProgress: false
		};
	}

	const summary = await getBudgetSummary(context, month);
	const alertItems = summary.items.filter(
		(item) => item.status === 'warning' || item.status === 'over'
	);
	if (alertItems.length === 0)
		return {
			sentCount: 0,
			failedCount: 0,
			alertCount: 0,
			alreadySent: false,
			inProgress: false
		};

	const recipients = await db
		.select({ email: user.email })
		.from(workspaceMember)
		.innerJoin(user, eq(user.id, workspaceMember.userId))
		.where(
			and(
				eq(workspaceMember.workspaceId, context.workspaceId),
				eq(workspaceMember.status, 'active'),
				inArray(workspaceMember.role, ['owner', 'admin'])
			)
		);

	const emailItems = alertItems.map((item) => ({
		categoryName: item.categoryName,
		usagePct: item.usagePct,
		spentLabel: formatCents(item.spentCents, context.currency, context.locale),
		budgetLabel: formatCents(item.amountCents ?? 0, context.currency, context.locale),
		status: item.status
	}));

	if (recipients.length === 0) {
		return {
			sentCount: 0,
			failedCount: 0,
			alertCount: alertItems.length,
			alreadySent: false,
			inProgress: false
		};
	}

	const claimToken = randomToken(18);
	const claimExpiresAt = new Date(now.getTime() + budgetAlertClaimTtlMs);
	const recipientEmails = recipients.map((recipient) => recipient.email);
	const claimed = await db.transaction(async (tx) => {
		await tx
			.insert(budgetAlertDelivery)
			.values(
				recipientEmails.map((recipientEmail) => ({
					workspaceId: context.workspaceId,
					periodMonth: month,
					recipientEmail
				}))
			)
			.onConflictDoNothing();

		return tx
			.update(budgetAlertDelivery)
			.set({
				status: 'sending',
				claimToken,
				claimExpiresAt,
				attemptCount: sql`${budgetAlertDelivery.attemptCount} + 1`,
				updatedAt: now
			})
			.where(
				and(
					eq(budgetAlertDelivery.workspaceId, context.workspaceId),
					eq(budgetAlertDelivery.periodMonth, month),
					inArray(budgetAlertDelivery.recipientEmail, recipientEmails),
					or(
						inArray(budgetAlertDelivery.status, ['pending', 'failed']),
						and(
							eq(budgetAlertDelivery.status, 'sending'),
							lt(budgetAlertDelivery.claimExpiresAt, now)
						)
					)
				)
			)
			.returning({
				id: budgetAlertDelivery.id,
				recipientEmail: budgetAlertDelivery.recipientEmail
			});
	});

	if (claimed.length === 0) {
		const statuses = await currentBudgetAlertDeliveryStatuses(
			context.workspaceId,
			month,
			recipientEmails
		);
		return {
			sentCount: 0,
			failedCount: 0,
			alertCount: alertItems.length,
			alreadySent:
				statuses.length === recipientEmails.length &&
				statuses.every((row) => row.status === 'sent'),
			inProgress: statuses.some((row) => row.status === 'sending')
		};
	}

	const attempts = await Promise.allSettled(
		claimed.map((delivery) =>
			send(delivery.recipientEmail, context.workspaceName, month, emailItems, context.locale)
		)
	);

	let sentCount = 0;
	let failedCount = 0;
	await Promise.all(
		attempts.map(async (attempt, index) => {
			const delivery = claimed[index];
			if (attempt.status === 'fulfilled') {
				sentCount++;
				await db
					.update(budgetAlertDelivery)
					.set({
						status: 'sent',
						sentAt: now,
						claimToken: null,
						claimExpiresAt: null,
						updatedAt: now
					})
					.where(
						and(
							eq(budgetAlertDelivery.id, delivery.id),
							eq(budgetAlertDelivery.claimToken, claimToken)
						)
					);
				return;
			}

			failedCount++;
			console.error(
				JSON.stringify({
					level: 'error',
					message: 'budget_alert_delivery: provider send failed',
					deliveryId: delivery.id,
					error: attempt.reason instanceof Error ? attempt.reason.message : String(attempt.reason)
				})
			);
			await db
				.update(budgetAlertDelivery)
				.set({
					status: 'failed',
					claimToken: null,
					claimExpiresAt: null,
					updatedAt: now
				})
				.where(
					and(
						eq(budgetAlertDelivery.id, delivery.id),
						eq(budgetAlertDelivery.claimToken, claimToken)
					)
				);
		})
	);

	const statuses = await currentBudgetAlertDeliveryStatuses(
		context.workspaceId,
		month,
		recipientEmails
	);
	if (
		sentCount > 0 &&
		statuses.length === recipientEmails.length &&
		statuses.every((row) => row.status === 'sent')
	) {
		await db.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'budget.alerts_sent',
			entityType: 'budget',
			entityId: String(context.workspaceId),
			metadata: {
				periodMonth: month,
				alertCount: alertItems.length,
				recipientCount: recipients.length
			}
		});
	}

	return {
		sentCount,
		failedCount,
		alertCount: alertItems.length,
		alreadySent: false,
		inProgress: false
	};
}

async function hasLegacyBudgetAlertMarker(workspaceId: number, month: string) {
	const [alreadySent] = await db
		.select({ id: auditEvent.id })
		.from(auditEvent)
		.where(
			and(
				eq(auditEvent.workspaceId, workspaceId),
				eq(auditEvent.action, 'budget.alerts_sent'),
				sql`${auditEvent.metadata}->>'periodMonth' = ${month}`
			)
		)
		.limit(1);
	return Boolean(alreadySent);
}

function currentBudgetAlertDeliveryStatuses(
	workspaceId: number,
	month: string,
	recipientEmails: string[]
) {
	return db
		.select({ status: budgetAlertDelivery.status })
		.from(budgetAlertDelivery)
		.where(
			and(
				eq(budgetAlertDelivery.workspaceId, workspaceId),
				eq(budgetAlertDelivery.periodMonth, month),
				inArray(budgetAlertDelivery.recipientEmail, recipientEmails)
			)
		);
}
