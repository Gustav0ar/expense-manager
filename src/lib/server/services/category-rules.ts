import { error } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { category, categoryRule } from '$lib/server/db/schema';
import { canManageCategories } from '$lib/server/security/roles';
import { assertCategoryInWorkspace } from '$lib/server/utils/category';
import type { WorkspaceContext } from './workspaces';
import { translate } from '$lib/i18n';
import { insertAuditEvent } from './audit';

export type CategoryRuleInput = {
	name: string;
	categoryId: number;
	matchTarget: 'description' | 'vendor' | 'payment';
	pattern: string;
	priority: number;
};

export type CategoryRuleMatchInput = {
	description?: string | null;
	vendor?: string | null;
	paymentMethod?: string | null;
};

export async function listCategoryRules(context: WorkspaceContext) {
	return db
		.select({
			id: categoryRule.id,
			name: categoryRule.name,
			categoryId: categoryRule.categoryId,
			categoryName: category.name,
			categoryIcon: category.icon,
			matchTarget: categoryRule.matchTarget,
			pattern: categoryRule.pattern,
			priority: categoryRule.priority,
			isActive: categoryRule.isActive,
			createdAt: categoryRule.createdAt
		})
		.from(categoryRule)
		.innerJoin(category, eq(category.id, categoryRule.categoryId))
		.where(eq(categoryRule.workspaceId, context.workspaceId))
		.orderBy(asc(categoryRule.priority), asc(categoryRule.id));
}

export async function createCategoryRule(context: WorkspaceContext, input: CategoryRuleInput) {
	if (!canManageCategories(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const created = await db.transaction(async (tx) => {
		await assertCategoryInWorkspace(context.workspaceId, input.categoryId, context.locale, tx);
		const [row] = await tx
			.insert(categoryRule)
			.values({
				workspaceId: context.workspaceId,
				categoryId: input.categoryId,
				createdByUserId: context.userId,
				name: input.name,
				matchTarget: input.matchTarget,
				pattern: input.pattern,
				priority: input.priority
			})
			.returning({ id: categoryRule.id });

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'category_rule.created',
			entityType: 'category_rule',
			entityId: row.id,
			metadata: { categoryId: input.categoryId, matchTarget: input.matchTarget }
		});

		return row;
	});

	return created;
}

export async function archiveCategoryRule(context: WorkspaceContext, id: number) {
	if (!canManageCategories(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(categoryRule)
			.set({ isActive: false })
			.where(and(eq(categoryRule.id, id), eq(categoryRule.workspaceId, context.workspaceId)))
			.returning({ id: categoryRule.id });

		if (!updated) throw error(404, translate(context.locale, 'Rule not found.'));

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'category_rule.archived',
			entityType: 'category_rule',
			entityId: id
		});
	});
}

export async function matchCategoryRule(context: WorkspaceContext, input: CategoryRuleMatchInput) {
	const rules = await getActiveRules(context.workspaceId);
	return matchCategoryRuleFromRules(rules, input);
}

export function matchCategoryRuleFromRules(
	rules: Awaited<ReturnType<typeof getActiveRules>>,
	input: CategoryRuleMatchInput
) {
	for (const rule of rules) {
		const candidate = valueForRule(rule.matchTarget, input);
		if (candidate && candidate.includes(rule.patternNormalized)) return rule.categoryId;
	}

	return null;
}

export async function getActiveRules(workspaceId: number) {
	const rules = await db
		.select({
			categoryId: categoryRule.categoryId,
			matchTarget: categoryRule.matchTarget,
			pattern: categoryRule.pattern
		})
		.from(categoryRule)
		.innerJoin(category, eq(category.id, categoryRule.categoryId))
		.where(
			and(
				eq(categoryRule.workspaceId, workspaceId),
				eq(categoryRule.isActive, true),
				eq(category.isArchived, false)
			)
		)
		.orderBy(asc(categoryRule.priority), asc(categoryRule.id));

	return rules.map((rule) => ({
		...rule,
		matchTarget: rule.matchTarget as CategoryRuleInput['matchTarget'],
		patternNormalized: normalizeRuleText(rule.pattern)
	}));
}

function valueForRule(
	matchTarget: CategoryRuleInput['matchTarget'],
	input: CategoryRuleMatchInput
) {
	if (matchTarget === 'vendor') return normalizeRuleText(input.vendor ?? '');
	if (matchTarget === 'payment') return normalizeRuleText(input.paymentMethod ?? '');
	return normalizeRuleText(input.description ?? '');
}

function normalizeRuleText(input: string) {
	return input
		.trim()
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{Diacritic}/gu, '');
}
