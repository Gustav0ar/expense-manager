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
	const rows = await db.execute<CategoryUsageRow>(
		categoryUsageSql(context.workspaceId, { includeArchived })
	);

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
		const [usage] = await tx.execute<CategoryUsageRow>(
			categoryUsageSql(context.workspaceId, { id })
		);
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

function categoryUsageSql(
	workspaceId: number,
	options: { id?: number; includeArchived?: boolean } = {}
) {
	const categoryIdFilter = options.id == null ? sql`` : sql`and category_id = ${options.id}`;
	const parentCategoryIdFilter =
		options.id == null ? sql`` : sql`and parent_category_id = ${options.id}`;

	return sql`
		with expense_usage as (
			select category_id, count(*)::int as expense_count
			from expense
			where workspace_id = ${workspaceId}
				${categoryIdFilter}
			group by category_id
		), recurring_usage as (
			select category_id, count(*)::int as recurring_count
			from recurring_expense
			where workspace_id = ${workspaceId}
				${categoryIdFilter}
			group by category_id
		), budget_usage as (
			select category_id, count(*)::int as budget_count
			from category_budget
			where workspace_id = ${workspaceId}
				${categoryIdFilter}
			group by category_id
		), rule_usage as (
			select category_id, count(*)::int as rule_count
			from category_rule
			where workspace_id = ${workspaceId}
				${categoryIdFilter}
			group by category_id
		), child_usage as (
			select parent_category_id, count(*)::int as child_count
			from category
			where workspace_id = ${workspaceId}
				and parent_category_id is not null
				${parentCategoryIdFilter}
			group by parent_category_id
		)
		select c.id,
			c.name,
			c.color,
			c.icon,
			c.is_archived,
			c.created_at,
			coalesce(eu.expense_count, 0)::int as expense_count,
			coalesce(ru.recurring_count, 0)::int as recurring_count,
			coalesce(bu.budget_count, 0)::int as budget_count,
			coalesce(cu.rule_count, 0)::int as rule_count,
			coalesce(chu.child_count, 0)::int as child_count
		from category c
		left join expense_usage eu on eu.category_id = c.id
		left join recurring_usage ru on ru.category_id = c.id
		left join budget_usage bu on bu.category_id = c.id
		left join rule_usage cu on cu.category_id = c.id
		left join child_usage chu on chu.parent_category_id = c.id
		where c.workspace_id = ${workspaceId}
			${options.id == null ? sql`` : sql`and c.id = ${options.id}`}
			${options.id != null || options.includeArchived ? sql`` : sql`and c.is_archived = false`}
		${options.id == null ? sql`order by c.is_archived asc, c.name asc` : sql`limit 1`}
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
