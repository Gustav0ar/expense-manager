import { error } from '@sveltejs/kit';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import { auditEvent, categoryBudget, workspaceMember } from '$lib/server/db/schema';
import { sendBudgetAlertEmail } from '$lib/server/email';
import { canManageBudgets } from '$lib/server/security/roles';
import { startOfMonth } from '$lib/server/utils/date';
import { parseCurrencyToCents } from '$lib/server/utils/money';
import { formatCents } from '$lib/utils/format';
import { assertCategoryInWorkspace } from '$lib/server/utils/category';
import type { WorkspaceContext } from './workspaces';

export type BudgetInput = {
	categoryId: number;
	periodMonth: string;
	amount: string;
	warningThresholdPct: number;
};

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
	if (!canManageBudgets(context.role)) throw error(403, 'Permission denied.');
	await assertCategoryInWorkspace(context.workspaceId, input.categoryId);

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
	if (!canManageBudgets(context.role)) throw error(403, 'Permission denied.');

	const [deleted] = await db
		.delete(categoryBudget)
		.where(and(eq(categoryBudget.id, id), eq(categoryBudget.workspaceId, context.workspaceId)))
		.returning({ id: categoryBudget.id, categoryId: categoryBudget.categoryId });

	if (!deleted) throw error(404, 'Budget not found.');

	await db.insert(auditEvent).values({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'budget.deleted',
		entityType: 'category_budget',
		entityId: String(id),
		metadata: { categoryId: deleted.categoryId }
	});
}

export async function sendBudgetAlerts(context: WorkspaceContext, periodMonth: string) {
	if (!canManageBudgets(context.role)) throw error(403, 'Permission denied.');

	const month = startOfMonth(periodMonth);
	const summary = await getBudgetSummary(context, month);
	const alertItems = summary.items.filter(
		(item) => item.status === 'warning' || item.status === 'over'
	);
	if (alertItems.length === 0) return { sentCount: 0, alertCount: 0 };

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

	for (const recipient of recipients) {
		await sendBudgetAlertEmail(
			recipient.email,
			context.workspaceName,
			month,
			emailItems,
			context.locale
		);
	}

	await db.insert(auditEvent).values({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'budget.alerts_sent',
		entityType: 'category_budget',
		metadata: {
			periodMonth: month,
			alertCount: alertItems.length,
			recipientCount: recipients.length
		}
	});

	return { sentCount: recipients.length, alertCount: alertItems.length };
}
