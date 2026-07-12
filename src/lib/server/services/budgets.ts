import { error } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { advisoryLockClient, db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import {
	auditEvent,
	budgetAlertDelivery,
	budgetAlertPreference,
	budgetAlertRecipient,
	categoryBudget,
	workspace,
	workspaceMember
} from '$lib/server/db/schema';
import {
	emailDeliveryConcurrency,
	sendBudgetAlertEmail,
	type MailDeliveryReceipt
} from '$lib/server/email';
import { canManageBudgets } from '$lib/server/security/roles';
import { randomToken } from '$lib/server/utils/crypto';
import { mapWithConcurrency } from '$lib/server/utils/concurrency';
import { firstDayOfMonth, startOfMonth } from '$lib/server/utils/date';
import { parseCurrencyToCents } from '$lib/server/utils/money';
import { formatCents } from '$lib/utils/format';
import { assertCategoryInWorkspace } from '$lib/server/utils/category';
import { isSupportedLocale, translate, type SupportedLocale } from '$lib/i18n';
import type { WorkspaceContext } from './workspaces';
import { lockWorkspaceCurrency } from './workspace-currency';
import { insertAuditEvent, writeAuditEvent } from './audit';

export type BudgetInput = {
	categoryId: number;
	periodMonth: string;
	amount: string;
	warningThresholdPct: number;
};

type BudgetAlertSender = (
	...args: Parameters<typeof sendBudgetAlertEmail>
) => Promise<MailDeliveryReceipt | void>;

type BudgetAlertDeliveryOptions = {
	send?: BudgetAlertSender;
	now?: Date;
};

const budgetAlertClaimTtlMs = 10 * 60 * 1000;
export const budgetAlertDeliveryMaxAttempts = 8;
export const budgetAlertDeliveryBatchSize = 100;
const budgetAlertSchedulerLockKey = 7_273_299_172;
const nonRetryableProviderEvents = ['bounce', 'blocked', 'spam', 'unsub'] as const;

type BudgetAlertPreferenceInput = {
	isEnabled: boolean;
	recipientMode: 'all_managers' | 'selected';
	escalateOverBudget: boolean;
	recipientUserIds: string[];
};

type BudgetAlertErrorCategory =
	| 'timeout'
	| 'configuration'
	| 'provider_rejected'
	| 'provider_unavailable'
	| 'network'
	| 'unknown';

export async function getBudgetAlertPreference(context: WorkspaceContext) {
	const [preference] = await db
		.select({
			isEnabled: budgetAlertPreference.isEnabled,
			recipientMode: budgetAlertPreference.recipientMode,
			escalateOverBudget: budgetAlertPreference.escalateOverBudget,
			locale: budgetAlertPreference.locale
		})
		.from(budgetAlertPreference)
		.where(eq(budgetAlertPreference.workspaceId, context.workspaceId))
		.limit(1);

	const selectedRecipients = canManageBudgets(context.role)
		? await db
				.select({ userId: budgetAlertRecipient.userId })
				.from(budgetAlertRecipient)
				.where(eq(budgetAlertRecipient.workspaceId, context.workspaceId))
				.orderBy(asc(budgetAlertRecipient.userId))
		: [];

	return {
		isEnabled: preference?.isEnabled ?? false,
		recipientMode:
			preference?.recipientMode === 'selected' ? ('selected' as const) : ('all_managers' as const),
		escalateOverBudget: preference?.escalateOverBudget ?? false,
		recipientUserIds: selectedRecipients.map((recipient) => recipient.userId),
		locale: isSupportedLocale(preference?.locale) ? preference.locale : context.locale
	};
}

export async function listBudgetAlertEligibleRecipients(context: WorkspaceContext) {
	if (!canManageBudgets(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const selected = new Set(
		(
			await db
				.select({ userId: budgetAlertRecipient.userId })
				.from(budgetAlertRecipient)
				.where(eq(budgetAlertRecipient.workspaceId, context.workspaceId))
		).map((recipient) => recipient.userId)
	);
	const recipients = await eligibleBudgetAlertRecipients(context.workspaceId);
	return recipients.map((recipient) => ({
		...recipient,
		isSelected: selected.has(recipient.userId)
	}));
}

export async function setBudgetAlertPreference(
	context: WorkspaceContext,
	input: boolean | BudgetAlertPreferenceInput
) {
	if (!canManageBudgets(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const current = await getBudgetAlertPreference(context);
	const eligible = await eligibleBudgetAlertRecipients(context.workspaceId);
	const eligibleIds = new Set(eligible.map((recipient) => recipient.userId));
	const preference: BudgetAlertPreferenceInput =
		typeof input === 'boolean'
			? {
					isEnabled: input,
					recipientMode: current.recipientMode,
					escalateOverBudget: current.escalateOverBudget,
					recipientUserIds: current.recipientUserIds.filter((userId) => eligibleIds.has(userId))
				}
			: {
					...input,
					recipientUserIds:
						input.recipientMode === 'selected' ? [...new Set(input.recipientUserIds)] : []
				};
	if (
		typeof input !== 'boolean' &&
		preference.recipientUserIds.some((userId) => !eligibleIds.has(userId))
	) {
		throw error(400, translate(context.locale, 'Select only eligible alert recipients.'));
	}
	if (
		preference.isEnabled &&
		preference.recipientMode === 'selected' &&
		preference.recipientUserIds.length === 0
	) {
		throw error(400, translate(context.locale, 'Select at least one alert recipient.'));
	}

	await db.transaction(async (tx) => {
		await lockBudgetAlertPreference(tx, context.workspaceId);
		const transactionEligible = await eligibleBudgetAlertRecipients(
			context.workspaceId,
			'all_managers',
			tx
		);
		const transactionEligibleIds = new Set(
			transactionEligible.map((recipient) => recipient.userId)
		);
		if (
			preference.recipientUserIds.some((userId) => !transactionEligibleIds.has(userId)) ||
			(preference.isEnabled &&
				preference.recipientMode === 'selected' &&
				preference.recipientUserIds.length === 0)
		) {
			throw error(400, translate(context.locale, 'Select only eligible alert recipients.'));
		}
		await tx
			.insert(budgetAlertPreference)
			.values({
				workspaceId: context.workspaceId,
				isEnabled: preference.isEnabled,
				recipientMode: preference.recipientMode,
				escalateOverBudget: preference.escalateOverBudget,
				locale: context.locale,
				updatedByUserId: context.userId
			})
			.onConflictDoUpdate({
				target: budgetAlertPreference.workspaceId,
				set: {
					isEnabled: preference.isEnabled,
					recipientMode: preference.recipientMode,
					escalateOverBudget: preference.escalateOverBudget,
					locale: context.locale,
					updatedByUserId: context.userId,
					updatedAt: new Date()
				}
			});

		await tx
			.delete(budgetAlertRecipient)
			.where(eq(budgetAlertRecipient.workspaceId, context.workspaceId));
		if (preference.recipientMode === 'selected' && preference.recipientUserIds.length > 0) {
			await tx.insert(budgetAlertRecipient).values(
				preference.recipientUserIds.map((userId) => ({
					workspaceId: context.workspaceId,
					userId,
					createdByUserId: context.userId
				}))
			);
		}

		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: preference.isEnabled ? 'budget.alerts_enabled' : 'budget.alerts_disabled',
			entityType: 'budget_alert_preference',
			entityId: String(context.workspaceId),
			metadata: {
				locale: context.locale,
				recipientMode: preference.recipientMode,
				recipientCount:
					preference.recipientMode === 'selected'
						? preference.recipientUserIds.length
						: transactionEligible.length,
				escalateOverBudget: preference.escalateOverBudget
			}
		});
	});

	return {
		isEnabled: preference.isEnabled,
		recipientMode: preference.recipientMode,
		escalateOverBudget: preference.escalateOverBudget,
		recipientUserIds: preference.recipientUserIds,
		locale: context.locale
	};
}

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
		await lockWorkspaceCurrency(tx, context.workspaceId);
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

	await db.transaction(async (tx) => {
		const [deleted] = await tx
			.delete(categoryBudget)
			.where(and(eq(categoryBudget.id, id), eq(categoryBudget.workspaceId, context.workspaceId)))
			.returning({ id: categoryBudget.id, categoryId: categoryBudget.categoryId });

		if (!deleted) throw error(404, translate(context.locale, 'Budget not found.'));

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'budget.deleted',
			entityType: 'category_budget',
			entityId: id,
			metadata: { categoryId: deleted.categoryId }
		});
	});
}

export async function runAutomaticBudgetAlertScheduler(
	options: BudgetAlertDeliveryOptions = {}
): Promise<{
	processed: number;
	sent: number;
	failed: number;
	errors: number;
	skipped?: boolean;
}> {
	const reserved = await advisoryLockClient.reserve();
	try {
		const lockResult = await reserved<{ acquired: boolean }[]>`
			SELECT pg_try_advisory_lock(${budgetAlertSchedulerLockKey}) AS acquired
		`;
		if (!lockResult[0]?.acquired) {
			return { processed: 0, sent: 0, failed: 0, errors: 0, skipped: true };
		}

		try {
			return await runAutomaticBudgetAlertsWithLock(options);
		} finally {
			await reserved`SELECT pg_advisory_unlock(${budgetAlertSchedulerLockKey})`;
		}
	} finally {
		reserved.release();
	}
}

async function runAutomaticBudgetAlertsWithLock(options: BudgetAlertDeliveryOptions) {
	const now = options.now ?? new Date();
	const periodMonth = firstDayOfMonth(now);
	const preferences = await db
		.select({
			workspaceId: budgetAlertPreference.workspaceId,
			locale: budgetAlertPreference.locale,
			workspaceName: workspace.name,
			currency: workspace.currency,
			weekStartsOn: workspace.weekStartsOn,
			userId: workspace.createdByUserId
		})
		.from(budgetAlertPreference)
		.innerJoin(workspace, eq(workspace.id, budgetAlertPreference.workspaceId))
		.where(eq(budgetAlertPreference.isEnabled, true))
		.orderBy(asc(budgetAlertPreference.workspaceId));

	let sent = 0;
	let failed = 0;
	let errors = 0;

	for (const preference of preferences) {
		const locale: SupportedLocale = isSupportedLocale(preference.locale) ? preference.locale : 'en';
		const context: WorkspaceContext = {
			userId: preference.userId,
			workspaceId: preference.workspaceId,
			workspaceName: preference.workspaceName,
			currency: preference.currency,
			locale,
			weekStartsOn: preference.weekStartsOn,
			role: 'owner'
		};

		try {
			const result = await sendBudgetAlerts(context, periodMonth, {
				now,
				send: options.send
			});
			sent += result.sentCount;
			failed += result.failedCount;
		} catch (schedulerError) {
			errors++;
			console.error(
				JSON.stringify({
					level: 'error',
					message: 'budget_alert_scheduler: failed to process workspace',
					workspaceId: preference.workspaceId,
					error: schedulerError instanceof Error ? schedulerError.message : String(schedulerError)
				})
			);
		}
	}

	console.info(
		JSON.stringify({
			level: 'info',
			message: 'budget_alert_scheduler: run complete',
			processed: preferences.length,
			sent,
			failed,
			errors,
			periodMonth
		})
	);

	return { processed: preferences.length, sent, failed, errors };
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

	// Rows written before 0021 contained a combined, recipient-level digest. Keep
	// retrying that ledger in place, but never infer category transitions or add
	// recipients to it. Fully-sent legacy months remain closed.
	const legacyDeliveries = await db
		.select({ id: budgetAlertDelivery.id, status: budgetAlertDelivery.status })
		.from(budgetAlertDelivery)
		.where(
			and(
				eq(budgetAlertDelivery.workspaceId, context.workspaceId),
				eq(budgetAlertDelivery.periodMonth, month),
				isNull(budgetAlertDelivery.categoryId),
				isNull(budgetAlertDelivery.recipientUserId),
				isNull(budgetAlertDelivery.level),
				isNull(budgetAlertDelivery.stage)
			)
		)
		.orderBy(asc(budgetAlertDelivery.id));
	if (legacyDeliveries.length > 0) {
		if (legacyDeliveries.every((delivery) => delivery.status === 'sent')) {
			return {
				sentCount: 0,
				failedCount: 0,
				alertCount: 0,
				alreadySent: true,
				inProgress: false
			};
		}
		return retryLegacyBudgetAlertDeliveries(
			context,
			month,
			legacyDeliveries.map((delivery) => delivery.id),
			now,
			send
		);
	}
	if (await hasLegacyBudgetAlertMarker(context.workspaceId, month)) {
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

	const preference = await getBudgetAlertPreference(context);
	const recipients = await eligibleBudgetAlertRecipients(
		context.workspaceId,
		preference.recipientMode
	);

	if (recipients.length === 0) {
		return {
			sentCount: 0,
			failedCount: 0,
			alertCount: alertItems.length,
			alreadySent: false,
			inProgress: false
		};
	}

	const categoryIds = alertItems.map((item) => item.categoryId);
	const recipientUserIds = recipients.map((recipient) => recipient.userId);
	const existing = await db
		.select({
			id: budgetAlertDelivery.id,
			categoryId: budgetAlertDelivery.categoryId,
			recipientUserId: budgetAlertDelivery.recipientUserId,
			level: budgetAlertDelivery.level,
			stage: budgetAlertDelivery.stage,
			status: budgetAlertDelivery.status
		})
		.from(budgetAlertDelivery)
		.where(
			and(
				eq(budgetAlertDelivery.workspaceId, context.workspaceId),
				eq(budgetAlertDelivery.periodMonth, month),
				inArray(budgetAlertDelivery.categoryId, categoryIds),
				inArray(budgetAlertDelivery.recipientUserId, recipientUserIds)
			)
		);
	const desired = desiredBudgetAlertTransitions(
		alertItems,
		recipients,
		existing,
		preference.escalateOverBudget
	);

	if (desired.length === 0) {
		return {
			sentCount: 0,
			failedCount: 0,
			alertCount: alertItems.length,
			alreadySent: true,
			inProgress: false
		};
	}

	const desiredRows = await db.transaction(async (tx) => {
		await lockBudgetAlertPreference(tx, context.workspaceId);
		await tx
			.insert(budgetAlertDelivery)
			.values(
				desired.map((candidate) => ({
					workspaceId: context.workspaceId,
					periodMonth: month,
					recipientEmail: candidate.recipientEmail,
					recipientUserId: candidate.recipientUserId,
					recipientLabelSnapshot: candidate.recipientLabel,
					categoryId: candidate.categoryId,
					categoryNameSnapshot: candidate.categoryName,
					level: candidate.level,
					stage: candidate.stage
				}))
			)
			.onConflictDoNothing();

		return tx
			.select({
				id: budgetAlertDelivery.id,
				categoryId: budgetAlertDelivery.categoryId,
				recipientUserId: budgetAlertDelivery.recipientUserId,
				level: budgetAlertDelivery.level,
				stage: budgetAlertDelivery.stage
			})
			.from(budgetAlertDelivery)
			.where(
				and(
					eq(budgetAlertDelivery.workspaceId, context.workspaceId),
					eq(budgetAlertDelivery.periodMonth, month),
					inArray(budgetAlertDelivery.categoryId, categoryIds),
					inArray(budgetAlertDelivery.recipientUserId, recipientUserIds)
				)
			);
	});
	const desiredKeys = new Set(desired.map(budgetAlertTransitionKey));
	const candidateRows = desiredRows.filter((row) =>
		desiredKeys.has(
			budgetAlertTransitionKey({
				categoryId: row.categoryId!,
				recipientUserId: row.recipientUserId!,
				level: row.level as 'warning' | 'over',
				stage: row.stage as 'initial' | 'escalation'
			})
		)
	);
	const claimToken = randomToken(18);
	const claimed = await claimBudgetAlertDeliveries(
		context.workspaceId,
		candidateRows.map((row) => row.id),
		claimToken,
		now,
		desired
	);

	if (claimed.length === 0) {
		const currentRows = await currentBudgetAlertDeliveryStatuses(
			candidateRows.map((row) => row.id)
		);
		return {
			sentCount: 0,
			failedCount: 0,
			alertCount: alertItems.length,
			alreadySent: currentRows.length > 0 && currentRows.every((row) => row.status === 'sent'),
			inProgress: currentRows.some((row) => row.status === 'sending')
		};
	}

	const result = await deliverClaimedBudgetAlerts(context, claimed, claimToken, now, send, month);
	const completedRows = await currentBudgetAlertDeliveryStatuses(
		candidateRows.map((row) => row.id)
	);
	if (
		result.sentCount > 0 &&
		completedRows.length === candidateRows.length &&
		completedRows.every((row) => row.status === 'sent') &&
		!(await hasCurrentBudgetAlertMarker(context.workspaceId, month))
	) {
		// Email delivery is an external side effect and cannot share a database
		// transaction with this summary event. Plan 009 owns that delivery boundary.
		await writeAuditEvent({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'budget.alerts_sent',
			entityType: 'budget',
			entityId: context.workspaceId,
			metadata: {
				periodMonth: month,
				alertCount: alertItems.length,
				recipientCount: recipients.length,
				deliveryModel: 'category-v2'
			}
		});
	}

	return {
		...result,
		alertCount: alertItems.length,
		alreadySent: false,
		inProgress: false
	};
}

export async function listBudgetAlertDeliveryHistory(
	context: WorkspaceContext,
	filters: { cursor?: string; limit?: number } = {}
) {
	if (!canManageBudgets(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	const limit = Math.min(Math.max(filters.limit ?? 20, 1), 50);
	const cursor = decodeBudgetAlertHistoryCursor(filters.cursor);
	const eligibleRecipientIds = new Set(
		(await eligibleBudgetAlertRecipientsForCurrentPreference(context.workspaceId)).map(
			(recipient) => recipient.userId
		)
	);
	const conditions = [eq(budgetAlertDelivery.workspaceId, context.workspaceId)];
	if (cursor) conditions.push(lt(budgetAlertDelivery.id, cursor.id));

	const rows = await db
		.select({
			id: budgetAlertDelivery.id,
			categoryId: budgetAlertDelivery.categoryId,
			recipientUserId: budgetAlertDelivery.recipientUserId,
			periodMonth: budgetAlertDelivery.periodMonth,
			categoryName: budgetAlertDelivery.categoryNameSnapshot,
			recipientLabel: budgetAlertDelivery.recipientLabelSnapshot,
			recipientEmail: budgetAlertDelivery.recipientEmail,
			level: budgetAlertDelivery.level,
			stage: budgetAlertDelivery.stage,
			status: budgetAlertDelivery.status,
			attemptCount: budgetAlertDelivery.attemptCount,
			sentAt: budgetAlertDelivery.sentAt,
			updatedAt: budgetAlertDelivery.updatedAt,
			lastProviderEvent: budgetAlertDelivery.lastProviderEvent,
			lastProviderEventAt: budgetAlertDelivery.lastProviderEventAt,
			lastErrorCategory: budgetAlertDelivery.lastErrorCategory
		})
		.from(budgetAlertDelivery)
		.where(and(...conditions))
		.orderBy(desc(budgetAlertDelivery.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;
	const items = page.map((row) => ({
		id: row.id,
		periodMonth: row.periodMonth,
		categoryName: row.categoryName ?? translate(context.locale, 'Legacy monthly alert'),
		recipientLabel: row.recipientLabel ?? row.recipientEmail,
		level: row.level,
		stage: row.stage,
		status: row.status,
		attemptCount: row.attemptCount,
		sentAt: row.sentAt,
		updatedAt: row.updatedAt,
		lastProviderEvent: row.lastProviderEvent,
		lastProviderEventAt: row.lastProviderEventAt,
		lastErrorCategory: row.lastErrorCategory,
		retryable:
			row.status === 'failed' &&
			row.attemptCount < budgetAlertDeliveryMaxAttempts &&
			!isNonRetryableProviderEvent(row.lastProviderEvent) &&
			row.level != null &&
			row.stage != null &&
			row.categoryId != null &&
			row.recipientUserId != null &&
			eligibleRecipientIds.has(row.recipientUserId)
	}));
	const last = items.at(-1);
	return {
		items,
		nextCursor: hasMore && last ? encodeBudgetAlertHistoryCursor(last.id) : null
	};
}

export async function retryBudgetAlertDelivery(
	context: WorkspaceContext,
	deliveryId: number,
	options: BudgetAlertDeliveryOptions = {}
) {
	if (!canManageBudgets(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	const [delivery] = await db
		.select({
			id: budgetAlertDelivery.id,
			periodMonth: budgetAlertDelivery.periodMonth,
			recipientUserId: budgetAlertDelivery.recipientUserId,
			categoryId: budgetAlertDelivery.categoryId,
			level: budgetAlertDelivery.level,
			stage: budgetAlertDelivery.stage,
			status: budgetAlertDelivery.status,
			attemptCount: budgetAlertDelivery.attemptCount,
			lastProviderEvent: budgetAlertDelivery.lastProviderEvent
		})
		.from(budgetAlertDelivery)
		.where(
			and(
				eq(budgetAlertDelivery.id, deliveryId),
				eq(budgetAlertDelivery.workspaceId, context.workspaceId)
			)
		)
		.limit(1);
	if (!delivery) throw error(404, translate(context.locale, 'Budget alert delivery not found.'));
	if (
		delivery.status !== 'failed' ||
		delivery.attemptCount >= budgetAlertDeliveryMaxAttempts ||
		isNonRetryableProviderEvent(delivery.lastProviderEvent) ||
		delivery.categoryId == null ||
		delivery.recipientUserId == null ||
		(delivery.level !== 'warning' && delivery.level !== 'over') ||
		(delivery.stage !== 'initial' && delivery.stage !== 'escalation')
	) {
		throw error(409, translate(context.locale, 'This delivery cannot be retried.'));
	}
	const item = (await listBudgetStatus(context, delivery.periodMonth)).find(
		(budget) => budget.categoryId === delivery.categoryId
	);
	if (!item || (item.status !== 'warning' && item.status !== 'over')) {
		throw error(409, translate(context.locale, 'This budget alert is no longer active.'));
	}
	const recipients = await eligibleBudgetAlertRecipientsForCurrentPreference(context.workspaceId);
	const recipient = recipients.find((value) => value.userId === delivery.recipientUserId);
	if (!recipient) {
		throw error(409, translate(context.locale, 'This recipient is no longer eligible.'));
	}
	const candidate: BudgetAlertTransition = {
		categoryId: item.categoryId,
		categoryName: item.categoryName,
		usagePct: item.usagePct,
		spentCents: item.spentCents,
		amountCents: item.amountCents ?? 0,
		status: item.status,
		recipientUserId: recipient.userId,
		recipientEmail: recipient.email,
		recipientLabel: recipient.name,
		level: delivery.level,
		stage: delivery.stage
	};
	const now = options.now ?? new Date();
	const claimToken = randomToken(18);
	const claimed = await claimBudgetAlertDeliveries(
		context.workspaceId,
		[delivery.id],
		claimToken,
		now,
		[candidate]
	);
	if (claimed.length === 0)
		throw error(409, translate(context.locale, 'This delivery cannot be retried.'));
	const result = await deliverClaimedBudgetAlerts(
		context,
		claimed,
		claimToken,
		now,
		options.send ?? sendBudgetAlertEmail,
		delivery.periodMonth
	);
	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'budget.alert_delivery_retried',
		entityType: 'budget_alert_delivery',
		entityId: delivery.id,
		metadata: { sent: result.sentCount === 1 }
	});
	return result;
}

type BudgetAlertRecipientRow = {
	userId: string;
	name: string;
	email: string;
};

type BudgetStatusItem = Awaited<ReturnType<typeof listBudgetStatus>>[number];

type BudgetAlertTransition = {
	categoryId: number;
	categoryName: string;
	usagePct: number | null;
	spentCents: number;
	amountCents: number;
	status: 'warning' | 'over';
	recipientUserId: string;
	recipientEmail: string;
	recipientLabel: string;
	level: 'warning' | 'over';
	stage: 'initial' | 'escalation';
};

type ClaimedBudgetAlert = BudgetAlertTransition & {
	id: number;
	providerReference: string;
	recipientEmail: string;
};

type ClaimedLegacyBudgetAlert = {
	id: number;
	providerReference: string;
	recipientEmail: string;
};

async function retryLegacyBudgetAlertDeliveries(
	context: WorkspaceContext,
	periodMonth: string,
	legacyDeliveryIds: number[],
	now: Date,
	send: BudgetAlertSender
) {
	const summary = await getBudgetSummary(context, periodMonth);
	const alertItems = summary.items.filter(
		(item) => item.status === 'warning' || item.status === 'over'
	);
	if (alertItems.length === 0) {
		return {
			sentCount: 0,
			failedCount: 0,
			alertCount: 0,
			alreadySent: false,
			inProgress: false
		};
	}

	const claimToken = randomToken(18);
	const claimed = await claimLegacyBudgetAlertDeliveries(
		context.workspaceId,
		periodMonth,
		claimToken,
		now
	);
	if (claimed.length === 0) {
		const currentRows = await currentLegacyBudgetAlertDeliveryStatuses(legacyDeliveryIds);
		return {
			sentCount: 0,
			failedCount: 0,
			alertCount: alertItems.length,
			alreadySent:
				currentRows.length === legacyDeliveryIds.length &&
				currentRows.every((row) => row.status === 'sent'),
			inProgress: currentRows.some(
				(row) =>
					row.status === 'sending' &&
					row.claimExpiresAt != null &&
					row.claimExpiresAt.getTime() >= now.getTime()
			)
		};
	}

	const emailItems = alertItems.map((item) => ({
		categoryName: item.categoryName,
		usagePct: item.usagePct,
		spentLabel: formatCents(item.spentCents, context.currency, context.locale),
		budgetLabel: formatCents(item.amountCents ?? 0, context.currency, context.locale),
		status: item.status
	}));
	const result = await deliverClaimedLegacyBudgetAlerts(
		context,
		claimed,
		claimToken,
		now,
		send,
		periodMonth,
		emailItems
	);
	const completedRows = await currentLegacyBudgetAlertDeliveryStatuses(legacyDeliveryIds);
	if (
		result.sentCount > 0 &&
		completedRows.length === legacyDeliveryIds.length &&
		completedRows.every((row) => row.status === 'sent') &&
		!(await hasLegacyBudgetAlertMarker(context.workspaceId, periodMonth))
	) {
		await writeAuditEvent({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'budget.alerts_sent',
			entityType: 'budget',
			entityId: context.workspaceId,
			metadata: {
				periodMonth,
				alertCount: alertItems.length,
				recipientCount: legacyDeliveryIds.length
			}
		});
	}

	return {
		...result,
		alertCount: alertItems.length,
		alreadySent: false,
		inProgress: false
	};
}

async function claimLegacyBudgetAlertDeliveries(
	workspaceId: number,
	periodMonth: string,
	claimToken: string,
	now: Date
): Promise<ClaimedLegacyBudgetAlert[]> {
	return db.transaction(async (tx) => {
		await lockBudgetAlertPreference(tx, workspaceId);
		const eligible = await eligibleBudgetAlertRecipientsForCurrentPreference(workspaceId, tx);
		const eligibleByEmail = new Map(
			eligible.map((recipient) => [recipient.email.toLowerCase(), recipient])
		);
		if (eligibleByEmail.size === 0) return [];
		const eligibleEmails = [...eligibleByEmail.keys()];

		const candidates = await tx
			.select({
				id: budgetAlertDelivery.id,
				recipientEmail: budgetAlertDelivery.recipientEmail
			})
			.from(budgetAlertDelivery)
			.where(
				and(
					eq(budgetAlertDelivery.workspaceId, workspaceId),
					eq(budgetAlertDelivery.periodMonth, periodMonth),
					isNull(budgetAlertDelivery.categoryId),
					isNull(budgetAlertDelivery.recipientUserId),
					isNull(budgetAlertDelivery.level),
					isNull(budgetAlertDelivery.stage),
					inArray(sql`lower(${budgetAlertDelivery.recipientEmail})`, eligibleEmails),
					sql`${budgetAlertDelivery.attemptCount} < ${budgetAlertDeliveryMaxAttempts}`,
					or(
						inArray(budgetAlertDelivery.status, ['pending', 'failed']),
						and(
							eq(budgetAlertDelivery.status, 'sending'),
							lt(budgetAlertDelivery.claimExpiresAt, now)
						)
					),
					or(
						isNull(budgetAlertDelivery.lastProviderEvent),
						sql`${budgetAlertDelivery.lastProviderEvent} not in ('bounce', 'blocked', 'spam', 'unsub')`
					)
				)
			)
			.orderBy(asc(budgetAlertDelivery.id))
			.limit(budgetAlertDeliveryBatchSize);
		const eligibleIds = candidates.map((row) => row.id);
		if (eligibleIds.length === 0) return [];

		const claimExpiresAt = new Date(now.getTime() + budgetAlertClaimTtlMs);
		const claimed = await tx
			.update(budgetAlertDelivery)
			.set({
				status: 'sending',
				claimToken,
				claimExpiresAt,
				attemptCount: sql`${budgetAlertDelivery.attemptCount} + 1`,
				lastErrorCategory: null,
				updatedAt: now
			})
			.where(
				and(
					inArray(budgetAlertDelivery.id, eligibleIds),
					sql`${budgetAlertDelivery.attemptCount} < ${budgetAlertDeliveryMaxAttempts}`,
					or(
						inArray(budgetAlertDelivery.status, ['pending', 'failed']),
						and(
							eq(budgetAlertDelivery.status, 'sending'),
							lt(budgetAlertDelivery.claimExpiresAt, now)
						)
					),
					or(
						isNull(budgetAlertDelivery.lastProviderEvent),
						sql`${budgetAlertDelivery.lastProviderEvent} not in ('bounce', 'blocked', 'spam', 'unsub')`
					)
				)
			)
			.returning({
				id: budgetAlertDelivery.id,
				recipientEmail: budgetAlertDelivery.recipientEmail,
				providerReference: budgetAlertDelivery.providerReference
			});

		return claimed.flatMap((row) => {
			const recipient = eligibleByEmail.get(row.recipientEmail.toLowerCase());
			return recipient ? [{ ...row, recipientEmail: recipient.email }] : [];
		});
	});
}

async function deliverClaimedLegacyBudgetAlerts(
	context: WorkspaceContext,
	claimed: ClaimedLegacyBudgetAlert[],
	claimToken: string,
	now: Date,
	send: BudgetAlertSender,
	periodMonth: string,
	emailItems: Parameters<BudgetAlertSender>[3]
) {
	let sentCount = 0;
	let failedCount = 0;
	await mapWithConcurrency(claimed, emailDeliveryConcurrency(), async (delivery) => {
		try {
			const receipt = await send(
				delivery.recipientEmail,
				context.workspaceName,
				periodMonth,
				emailItems,
				context.locale,
				`budget-alert:${delivery.providerReference}`
			);
			const updated = await db
				.update(budgetAlertDelivery)
				.set({
					status: 'sent',
					sentAt: now,
					claimToken: null,
					claimExpiresAt: null,
					lastErrorCategory: null,
					provider: receipt?.provider ?? null,
					providerMessageId: receipt?.messageId ?? null,
					providerMessageUuid: receipt?.messageUuid ?? null,
					updatedAt: now
				})
				.where(
					and(
						eq(budgetAlertDelivery.id, delivery.id),
						eq(budgetAlertDelivery.claimToken, claimToken)
					)
				)
				.returning({ id: budgetAlertDelivery.id });
			sentCount += updated.length;
		} catch (sendError) {
			const errorCategory = classifyBudgetAlertDeliveryError(sendError);
			console.error(
				JSON.stringify({
					level: 'error',
					message: 'budget_alert_delivery: legacy provider send failed',
					deliveryId: delivery.id,
					errorCategory
				})
			);
			const updated = await db
				.update(budgetAlertDelivery)
				.set({
					status: 'failed',
					claimToken: null,
					claimExpiresAt: null,
					lastErrorCategory: errorCategory,
					updatedAt: now
				})
				.where(
					and(
						eq(budgetAlertDelivery.id, delivery.id),
						eq(budgetAlertDelivery.claimToken, claimToken)
					)
				)
				.returning({ id: budgetAlertDelivery.id });
			failedCount += updated.length;
		}
	});
	return { sentCount, failedCount };
}

async function eligibleBudgetAlertRecipients(
	workspaceId: number,
	mode: 'all_managers' | 'selected' = 'all_managers',
	executor: Pick<typeof db, 'select'> = db
): Promise<BudgetAlertRecipientRow[]> {
	const conditions = [
		eq(workspaceMember.workspaceId, workspaceId),
		eq(workspaceMember.status, 'active'),
		inArray(workspaceMember.role, ['owner', 'admin']),
		eq(user.emailVerified, true)
	];
	if (mode === 'selected') {
		const selected = await executor
			.select({ userId: budgetAlertRecipient.userId })
			.from(budgetAlertRecipient)
			.where(eq(budgetAlertRecipient.workspaceId, workspaceId));
		if (selected.length === 0) return [];
		conditions.push(
			inArray(
				workspaceMember.userId,
				selected.map((row) => row.userId)
			)
		);
	}
	return executor
		.select({ userId: user.id, name: user.name, email: user.email })
		.from(workspaceMember)
		.innerJoin(user, eq(user.id, workspaceMember.userId))
		.where(and(...conditions))
		.orderBy(asc(user.name), asc(user.id));
}

async function eligibleBudgetAlertRecipientsForCurrentPreference(
	workspaceId: number,
	executor: Pick<typeof db, 'select'> = db
) {
	const [preference] = await executor
		.select({ recipientMode: budgetAlertPreference.recipientMode })
		.from(budgetAlertPreference)
		.where(eq(budgetAlertPreference.workspaceId, workspaceId))
		.limit(1);
	return eligibleBudgetAlertRecipients(
		workspaceId,
		preference?.recipientMode === 'selected' ? 'selected' : 'all_managers',
		executor
	);
}

function desiredBudgetAlertTransitions(
	alertItems: BudgetStatusItem[],
	recipients: BudgetAlertRecipientRow[],
	existing: Array<{
		categoryId: number | null;
		recipientUserId: string | null;
		level: string | null;
		stage: string | null;
	}>,
	escalateOverBudget: boolean
) {
	const existingByIdentity = new Map<string, typeof existing>();
	for (const row of existing) {
		if (row.categoryId == null || row.recipientUserId == null) continue;
		const identity = `${row.categoryId}:${row.recipientUserId}`;
		const rows = existingByIdentity.get(identity) ?? [];
		rows.push(row);
		existingByIdentity.set(identity, rows);
	}
	const desired: BudgetAlertTransition[] = [];
	for (const item of alertItems) {
		if (item.status !== 'warning' && item.status !== 'over') continue;
		for (const recipient of recipients) {
			const rows = existingByIdentity.get(`${item.categoryId}:${recipient.userId}`) ?? [];
			let level: 'warning' | 'over' | null = null;
			let stage: 'initial' | 'escalation' | null = null;
			if (item.status === 'warning') {
				if (
					rows.length === 0 ||
					rows.some((row) => row.level === 'warning' && row.stage === 'initial')
				) {
					level = 'warning';
					stage = 'initial';
				}
			} else {
				const initialOver = rows.some((row) => row.level === 'over' && row.stage === 'initial');
				const warning = rows.some((row) => row.level === 'warning' && row.stage === 'initial');
				const escalation = rows.some((row) => row.level === 'over' && row.stage === 'escalation');
				if (initialOver || rows.length === 0) {
					level = 'over';
					stage = 'initial';
				} else if (warning && escalateOverBudget && (escalation || !initialOver)) {
					level = 'over';
					stage = 'escalation';
				}
			}
			if (!level || !stage) continue;
			desired.push({
				categoryId: item.categoryId,
				categoryName: item.categoryName,
				usagePct: item.usagePct,
				spentCents: item.spentCents,
				amountCents: item.amountCents ?? 0,
				status: item.status,
				recipientUserId: recipient.userId,
				recipientEmail: recipient.email,
				recipientLabel: recipient.name,
				level,
				stage
			});
		}
	}
	return desired;
}

function budgetAlertTransitionKey(
	value: Pick<BudgetAlertTransition, 'categoryId' | 'recipientUserId' | 'level' | 'stage'>
) {
	return `${value.categoryId}:${value.recipientUserId}:${value.level}:${value.stage}`;
}

async function claimBudgetAlertDeliveries(
	workspaceId: number,
	deliveryIds: number[],
	claimToken: string,
	now: Date,
	details: BudgetAlertTransition[] = []
): Promise<ClaimedBudgetAlert[]> {
	if (deliveryIds.length === 0) return [];
	const boundedDeliveryIds = deliveryIds.slice(0, budgetAlertDeliveryBatchSize);
	return db.transaction(async (tx) => {
		await lockBudgetAlertPreference(tx, workspaceId);
		const eligible = await eligibleBudgetAlertRecipientsForCurrentPreference(workspaceId, tx);
		const eligibleById = new Map(eligible.map((recipient) => [recipient.userId, recipient]));
		const candidates = await tx
			.select({
				id: budgetAlertDelivery.id,
				recipientUserId: budgetAlertDelivery.recipientUserId,
				categoryId: budgetAlertDelivery.categoryId,
				level: budgetAlertDelivery.level,
				stage: budgetAlertDelivery.stage
			})
			.from(budgetAlertDelivery)
			.where(
				and(
					eq(budgetAlertDelivery.workspaceId, workspaceId),
					inArray(budgetAlertDelivery.id, boundedDeliveryIds)
				)
			);
		const eligibleIds = candidates
			.filter((row) => row.recipientUserId && eligibleById.has(row.recipientUserId))
			.map((row) => row.id);
		if (eligibleIds.length === 0) return [];
		const claimExpiresAt = new Date(now.getTime() + budgetAlertClaimTtlMs);
		const claimed = await tx
			.update(budgetAlertDelivery)
			.set({
				status: 'sending',
				claimToken,
				claimExpiresAt,
				attemptCount: sql`${budgetAlertDelivery.attemptCount} + 1`,
				lastErrorCategory: null,
				updatedAt: now
			})
			.where(
				and(
					inArray(budgetAlertDelivery.id, eligibleIds),
					sql`${budgetAlertDelivery.attemptCount} < ${budgetAlertDeliveryMaxAttempts}`,
					or(
						inArray(budgetAlertDelivery.status, ['pending', 'failed']),
						and(
							eq(budgetAlertDelivery.status, 'sending'),
							lt(budgetAlertDelivery.claimExpiresAt, now)
						)
					),
					or(
						isNull(budgetAlertDelivery.lastProviderEvent),
						sql`${budgetAlertDelivery.lastProviderEvent} not in ('bounce', 'blocked', 'spam', 'unsub')`
					)
				)
			)
			.returning({
				id: budgetAlertDelivery.id,
				recipientUserId: budgetAlertDelivery.recipientUserId,
				categoryId: budgetAlertDelivery.categoryId,
				level: budgetAlertDelivery.level,
				stage: budgetAlertDelivery.stage,
				providerReference: budgetAlertDelivery.providerReference
			});
		if (claimed.length === 0) return [];
		const claimedIds = claimed.map((row) => row.id);
		await tx.execute(sql`
			update "budget_alert_delivery" d
			set "recipient_email" = u."email",
				"recipient_label_snapshot" = u."name",
				"updated_at" = ${now.toISOString()}::timestamptz
			from "user" u
			where d."recipient_user_id" = u."id"
				and d."id" in (${sql.join(
					claimedIds.map((id) => sql`${id}`),
					sql`, `
				)})
		`);
		const detailByKey = new Map(
			details.map((detail) => [budgetAlertTransitionKey(detail), detail])
		);
		return claimed.flatMap((row) => {
			if (
				row.recipientUserId == null ||
				row.categoryId == null ||
				(row.level !== 'warning' && row.level !== 'over') ||
				(row.stage !== 'initial' && row.stage !== 'escalation')
			)
				return [];
			const detail = detailByKey.get(
				budgetAlertTransitionKey({
					categoryId: row.categoryId,
					recipientUserId: row.recipientUserId,
					level: row.level,
					stage: row.stage
				})
			);
			const recipient = eligibleById.get(row.recipientUserId);
			if (!detail || !recipient) return [];
			return [{ ...row, ...detail, recipientEmail: recipient.email }];
		});
	});
}

async function deliverClaimedBudgetAlerts(
	context: WorkspaceContext,
	claimed: ClaimedBudgetAlert[],
	claimToken: string,
	now: Date,
	send: BudgetAlertSender,
	periodMonth: string
) {
	let sentCount = 0;
	let failedCount = 0;
	await mapWithConcurrency(claimed, emailDeliveryConcurrency(), async (delivery) => {
		try {
			const receipt = await send(
				delivery.recipientEmail,
				context.workspaceName,
				periodMonth,
				[
					{
						categoryName: delivery.categoryName,
						usagePct: delivery.usagePct,
						spentLabel: formatCents(delivery.spentCents, context.currency, context.locale),
						budgetLabel: formatCents(delivery.amountCents, context.currency, context.locale),
						status: delivery.status
					}
				],
				context.locale,
				`budget-alert:${delivery.providerReference}`
			);
			const updated = await db
				.update(budgetAlertDelivery)
				.set({
					status: 'sent',
					sentAt: now,
					claimToken: null,
					claimExpiresAt: null,
					lastErrorCategory: null,
					provider: receipt?.provider ?? null,
					providerMessageId: receipt?.messageId ?? null,
					providerMessageUuid: receipt?.messageUuid ?? null,
					updatedAt: now
				})
				.where(
					and(
						eq(budgetAlertDelivery.id, delivery.id),
						eq(budgetAlertDelivery.claimToken, claimToken)
					)
				)
				.returning({ id: budgetAlertDelivery.id });
			sentCount += updated.length;
		} catch (sendError) {
			failedCount++;
			const errorCategory = classifyBudgetAlertDeliveryError(sendError);
			console.error(
				JSON.stringify({
					level: 'error',
					message: 'budget_alert_delivery: provider send failed',
					deliveryId: delivery.id,
					errorCategory
				})
			);
			await db
				.update(budgetAlertDelivery)
				.set({
					status: 'failed',
					claimToken: null,
					claimExpiresAt: null,
					lastErrorCategory: errorCategory,
					updatedAt: now
				})
				.where(
					and(
						eq(budgetAlertDelivery.id, delivery.id),
						eq(budgetAlertDelivery.claimToken, claimToken)
					)
				);
		}
	});
	return { sentCount, failedCount };
}

export function classifyBudgetAlertDeliveryError(errorValue: unknown): BudgetAlertErrorCategory {
	if (!(errorValue instanceof Error)) return 'unknown';
	const value = `${errorValue.name} ${errorValue.message}`.toLowerCase();
	if (/timeout|timed out|abort/.test(value)) return 'timeout';
	if (/not configured|configuration|credential|api key|secret/.test(value)) return 'configuration';
	if (/http 4\d\d/.test(value)) return 'provider_rejected';
	if (/http 5\d\d|service unavailable|bad gateway/.test(value)) return 'provider_unavailable';
	if (/network|fetch failed|econn|enotfound|socket/.test(value)) return 'network';
	return 'unknown';
}

function isNonRetryableProviderEvent(value: string | null) {
	return nonRetryableProviderEvents.includes(value as (typeof nonRetryableProviderEvents)[number]);
}

function encodeBudgetAlertHistoryCursor(id: number) {
	return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

function decodeBudgetAlertHistoryCursor(value?: string) {
	if (!value) return null;
	try {
		const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
			id?: unknown;
		};
		return typeof parsed.id === 'number' && Number.isSafeInteger(parsed.id) && parsed.id > 0
			? { id: parsed.id }
			: null;
	} catch {
		return null;
	}
}

function lockBudgetAlertPreference(executor: Pick<typeof db, 'execute'>, workspaceId: number) {
	return executor.execute(sql`
		select pg_advisory_xact_lock(
			hashtextextended(${'expense-manager:budget-alert-preference:' + workspaceId}, 0)
		)
	`);
}

async function hasLegacyBudgetAlertMarker(workspaceId: number, month: string) {
	const [alreadySent] = await db
		.select({ id: auditEvent.id })
		.from(auditEvent)
		.where(
			and(
				eq(auditEvent.workspaceId, workspaceId),
				eq(auditEvent.action, 'budget.alerts_sent'),
				sql`${auditEvent.metadata}->>'periodMonth' = ${month}`,
				sql`${auditEvent.metadata}->>'deliveryModel' is null`
			)
		)
		.limit(1);
	return Boolean(alreadySent);
}

async function hasCurrentBudgetAlertMarker(workspaceId: number, month: string) {
	const [alreadySent] = await db
		.select({ id: auditEvent.id })
		.from(auditEvent)
		.where(
			and(
				eq(auditEvent.workspaceId, workspaceId),
				eq(auditEvent.action, 'budget.alerts_sent'),
				sql`${auditEvent.metadata}->>'periodMonth' = ${month}`,
				sql`${auditEvent.metadata}->>'deliveryModel' = 'category-v2'`
			)
		)
		.limit(1);
	return Boolean(alreadySent);
}

function currentBudgetAlertDeliveryStatuses(ids: number[]) {
	if (ids.length === 0) return Promise.resolve([]);
	return db
		.select({ status: budgetAlertDelivery.status })
		.from(budgetAlertDelivery)
		.where(inArray(budgetAlertDelivery.id, ids));
}

function currentLegacyBudgetAlertDeliveryStatuses(ids: number[]) {
	if (ids.length === 0) return Promise.resolve([]);
	return db
		.select({
			status: budgetAlertDelivery.status,
			claimExpiresAt: budgetAlertDelivery.claimExpiresAt
		})
		.from(budgetAlertDelivery)
		.where(inArray(budgetAlertDelivery.id, ids));
}
