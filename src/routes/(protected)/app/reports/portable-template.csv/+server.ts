import type { RequestHandler } from './$types';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { serializePortableExpenseCsv } from '$lib/server/utils/import';

export const GET: RequestHandler = async (event) => {
	await requireWorkspaceContext(event);
	return new Response(serializePortableExpenseCsv([]), {
		headers: {
			'cache-control': 'private, no-store',
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': 'attachment; filename="expense-manager-portable-template-v1.csv"'
		}
	});
};
