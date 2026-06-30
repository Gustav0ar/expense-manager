import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { category } from '$lib/server/db/schema';

export async function assertCategoryInWorkspace(workspaceId: number, categoryId: number) {
	const [row] = await db
		.select({ id: category.id })
		.from(category)
		.where(
			and(
				eq(category.id, categoryId),
				eq(category.workspaceId, workspaceId),
				eq(category.isArchived, false)
			)
		)
		.limit(1);

	if (!row) throw error(400, 'Categoria inválida.');
}
