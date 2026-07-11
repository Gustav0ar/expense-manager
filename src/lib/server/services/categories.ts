import { error } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { category } from '$lib/server/db/schema';
import type { WorkspaceContext } from './workspaces';
import { canManageCategories } from '$lib/server/security/roles';
import { insertAuditEvent } from './audit';
import { translate } from '$lib/i18n';

type CategoryUsageRow = {
	id: number;
	name: string;
	color: string;
	icon: string | null;
	is_archived: boolean;
	created_at: Date;
	expense_count: number | string;
	recurring_count: number | string;
	budget_count: number | string;
	rule_count: number | string;
	child_count: number | string;
};

export async function listCategories(context: WorkspaceContext, includeArchived = false) {
	const rows = await db.execute<CategoryUsageRow>(sql`
		select c.id,
			c.name,
			c.color,
			c.icon,
			c.is_archived,
			c.created_at,
			count(distinct e.id)::int as expense_count,
			count(distinct re.id)::int as recurring_count,
			count(distinct cb.id)::int as budget_count,
			count(distinct cr.id)::int as rule_count,
			count(distinct child.id)::int as child_count
		from category c
		left join expense e
			on e.workspace_id = c.workspace_id
			and e.category_id = c.id
		left join recurring_expense re
			on re.workspace_id = c.workspace_id
			and re.category_id = c.id
		left join category_budget cb
			on cb.workspace_id = c.workspace_id
			and cb.category_id = c.id
		left join category_rule cr
			on cr.workspace_id = c.workspace_id
			and cr.category_id = c.id
		left join category child
			on child.workspace_id = c.workspace_id
			and child.parent_category_id = c.id
		where c.workspace_id = ${context.workspaceId}
			${includeArchived ? sql`` : sql`and c.is_archived = false`}
		group by c.id, c.name, c.color, c.icon, c.is_archived, c.created_at
		order by c.is_archived asc, c.name asc
	`);

	return rows.map(categoryFromUsageRow);
}

export async function createCategory(
	context: WorkspaceContext,
	input: { name: string; color: string; icon?: string | null }
) {
	if (!canManageCategories(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const created = await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(category)
			.values({
				workspaceId: context.workspaceId,
				name: input.name,
				color: input.color,
				icon: input.icon || null
			})
			.returning({ id: category.id });

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'category.created',
			entityType: 'category',
			entityId: row.id
		});

		return row;
	});

	return created;
}

export async function updateCategory(
	context: WorkspaceContext,
	id: number,
	input: { name: string; color: string; icon?: string | null }
) {
	if (!canManageCategories(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(category)
			.set({ name: input.name, color: input.color, icon: input.icon || null })
			.where(and(eq(category.id, id), eq(category.workspaceId, context.workspaceId)))
			.returning({ id: category.id });

		if (!updated) throw error(404, translate(context.locale, 'Category not found.'));

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'category.updated',
			entityType: 'category',
			entityId: id
		});
	});
}

export async function removeCategory(context: WorkspaceContext, id: number) {
	if (!canManageCategories(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const removed = await db.transaction(async (tx) => {
		const [usage] = await tx.execute<CategoryUsageRow>(categoryUsageSql(context.workspaceId, id));
		if (!usage) throw error(404, translate(context.locale, 'Category not found.'));

		const usageCounts = usageCountsFromRow(usage);
		const associationCount = Object.values(usageCounts).reduce((sum, count) => sum + count, 0);
		const mode = associationCount > 0 ? ('archived' as const) : ('deleted' as const);
		const [item] =
			mode === 'archived'
				? await tx
						.update(category)
						.set({ isArchived: true })
						.where(and(eq(category.id, id), eq(category.workspaceId, context.workspaceId)))
						.returning({ id: category.id, name: category.name, isArchived: category.isArchived })
				: await tx
						.delete(category)
						.where(and(eq(category.id, id), eq(category.workspaceId, context.workspaceId)))
						.returning({ id: category.id, name: category.name, isArchived: category.isArchived });

		if (!item) throw error(404, translate(context.locale, 'Category not found.'));

		const result = {
			mode,
			item: {
				...item,
				...usageCounts,
				associationCount
			}
		};

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: `category.${result.mode}`,
			entityType: 'category',
			entityId: result.item.id,
			metadata: {
				name: result.item.name,
				expenseCount: result.item.expenseCount,
				recurringCount: result.item.recurringCount,
				budgetCount: result.item.budgetCount,
				ruleCount: result.item.ruleCount,
				childCount: result.item.childCount
			}
		});

		return result;
	});

	return removed;
}

export async function unarchiveCategory(context: WorkspaceContext, id: number) {
	if (!canManageCategories(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	try {
		await db.transaction(async (tx) => {
			const [updated] = await tx
				.update(category)
				.set({ isArchived: false })
				.where(and(eq(category.id, id), eq(category.workspaceId, context.workspaceId)))
				.returning({ id: category.id });

			if (!updated) throw error(404, translate(context.locale, 'Category not found.'));

			await insertAuditEvent(tx, {
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: 'category.unarchived',
				entityType: 'category',
				entityId: id
			});
		});
	} catch (categoryError) {
		if (isUniqueViolation(categoryError))
			throw error(409, translate(context.locale, 'Category already exists.'));
		throw categoryError;
	}
}

function categoryUsageSql(workspaceId: number, id: number) {
	return sql`
		select c.id,
			c.name,
			c.color,
			c.icon,
			c.is_archived,
			c.created_at,
			count(distinct e.id)::int as expense_count,
			count(distinct re.id)::int as recurring_count,
			count(distinct cb.id)::int as budget_count,
			count(distinct cr.id)::int as rule_count,
			count(distinct child.id)::int as child_count
		from category c
		left join expense e
			on e.workspace_id = c.workspace_id
			and e.category_id = c.id
		left join recurring_expense re
			on re.workspace_id = c.workspace_id
			and re.category_id = c.id
		left join category_budget cb
			on cb.workspace_id = c.workspace_id
			and cb.category_id = c.id
		left join category_rule cr
			on cr.workspace_id = c.workspace_id
			and cr.category_id = c.id
		left join category child
			on child.workspace_id = c.workspace_id
			and child.parent_category_id = c.id
		where c.workspace_id = ${workspaceId}
			and c.id = ${id}
		group by c.id, c.name, c.color, c.icon, c.is_archived, c.created_at
		limit 1
	`;
}

function categoryFromUsageRow(row: CategoryUsageRow) {
	const usageCounts = usageCountsFromRow(row);
	return {
		id: Number(row.id),
		name: row.name,
		color: row.color,
		icon: row.icon,
		isArchived: Boolean(row.is_archived),
		createdAt: row.created_at,
		...usageCounts,
		associationCount: Object.values(usageCounts).reduce((sum, count) => sum + count, 0)
	};
}

function usageCountsFromRow(row: CategoryUsageRow) {
	return {
		expenseCount: Number(row.expense_count ?? 0),
		recurringCount: Number(row.recurring_count ?? 0),
		budgetCount: Number(row.budget_count ?? 0),
		ruleCount: Number(row.rule_count ?? 0),
		childCount: Number(row.child_count ?? 0)
	};
}

function isUniqueViolation(categoryError: unknown) {
	if (typeof categoryError !== 'object' || categoryError == null) return false;
	const directCode = 'code' in categoryError ? categoryError.code : null;
	const cause =
		'cause' in categoryError &&
		typeof categoryError.cause === 'object' &&
		categoryError.cause != null
			? categoryError.cause
			: null;
	const causeCode = cause && 'code' in cause ? cause.code : null;

	return directCode === '23505' || causeCode === '23505';
}
