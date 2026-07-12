import { error } from '@sveltejs/kit';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { translate, type SupportedLocale } from '$lib/i18n';

type CategoryExecutor = {
	execute(query: SQL): PromiseLike<unknown>;
};

export async function assertCategoryInWorkspace(
	workspaceId: number,
	categoryId: number,
	locale: SupportedLocale = 'en',
	executor: CategoryExecutor = db
) {
	const rows = (await executor.execute(sql`
		select id
		from category
		where id = ${categoryId} and workspace_id = ${workspaceId} and is_archived = false
		for key share
	`)) as { id: number }[];
	const row = rows[0];

	if (!row) throw error(400, translate(locale, 'Category is invalid.'));
}
