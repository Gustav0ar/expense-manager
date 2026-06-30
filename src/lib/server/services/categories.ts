import { error } from '@sveltejs/kit';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { category } from '$lib/server/db/schema';
import type { WorkspaceContext } from './workspaces';
import { canManageCategories } from '$lib/server/security/roles';
import { writeAuditEvent } from './audit';

export async function listCategories(context: WorkspaceContext, includeArchived = false) {
	const conditions = [eq(category.workspaceId, context.workspaceId)];
	if (!includeArchived) conditions.push(eq(category.isArchived, false));

	return db
		.select({
			id: category.id,
			name: category.name,
			color: category.color,
			icon: category.icon,
			isArchived: category.isArchived,
			createdAt: category.createdAt
		})
		.from(category)
		.where(and(...conditions))
		.orderBy(asc(category.name));
}

export async function createCategory(
	context: WorkspaceContext,
	input: { name: string; color: string; icon?: string | null }
) {
	if (!canManageCategories(context.role)) throw error(403, 'Permissao insuficiente.');

	const [created] = await db
		.insert(category)
		.values({
			workspaceId: context.workspaceId,
			name: input.name,
			color: input.color,
			icon: input.icon || null
		})
		.returning({ id: category.id });

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'category.created',
		entityType: 'category',
		entityId: created.id
	});

	return created;
}

export async function updateCategory(
	context: WorkspaceContext,
	id: number,
	input: { name: string; color: string; icon?: string | null }
) {
	if (!canManageCategories(context.role)) throw error(403, 'Permissao insuficiente.');

	const [updated] = await db
		.update(category)
		.set({ name: input.name, color: input.color, icon: input.icon || null })
		.where(and(eq(category.id, id), eq(category.workspaceId, context.workspaceId)))
		.returning({ id: category.id });

	if (!updated) throw error(404, 'Categoria não encontrada.');

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'category.updated',
		entityType: 'category',
		entityId: id
	});
}

export async function archiveCategory(context: WorkspaceContext, id: number) {
	if (!canManageCategories(context.role)) throw error(403, 'Permissao insuficiente.');

	const [updated] = await db
		.update(category)
		.set({ isArchived: true })
		.where(and(eq(category.id, id), eq(category.workspaceId, context.workspaceId)))
		.returning({ id: category.id });

	if (!updated) throw error(404, 'Categoria não encontrada.');

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'category.archived',
		entityType: 'category',
		entityId: id
	});
}
