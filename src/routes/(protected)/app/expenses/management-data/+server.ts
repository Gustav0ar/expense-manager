import { json, type RequestHandler } from '@sveltejs/kit';
import { listCategories } from '$lib/server/services/categories';
import { listExpenseCatalogs } from '$lib/server/services/expense-catalogs';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';

export const GET: RequestHandler = async (event) => {
	const context = await requireWorkspaceContext(event);
	const [categories, catalogs] = await Promise.all([
		listCategories(context, true),
		listExpenseCatalogs(context, true)
	]);
	return json({ categories, catalogs });
};
