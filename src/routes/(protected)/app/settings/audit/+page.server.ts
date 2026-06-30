import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { listAuditEvents } from '$lib/server/services/audit';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { auditFilterSchema } from '$lib/server/validation';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	const filters = auditFilterSchema.safeParse(Object.fromEntries(event.url.searchParams.entries()));
	if (!filters.success) throw error(400, 'Filtros invalidos.');

	return {
		filters: filters.data,
		audit: await listAuditEvents(context, filters.data)
	};
};
