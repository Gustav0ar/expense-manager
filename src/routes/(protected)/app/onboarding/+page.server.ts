import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { createWorkspace, setWorkspaceCookie } from '$lib/server/services/workspaces';
import { parseForm, workspaceSchema } from '$lib/server/validation';
import { translate } from '$lib/i18n';

export const actions: Actions = {
	default: async (event) => {
		if (!event.locals.user) throw redirect(303, '/login');

		const formData = await event.request.formData();
		const parsed = parseForm(formData, workspaceSchema);

		if (!parsed.success) {
			return fail(400, { message: translate(event.locals.locale, 'Check workspace data.') });
		}

		const created = await createWorkspace(event.locals.user.id, parsed.data);
		setWorkspaceCookie(event.cookies, created.id);
		throw redirect(303, '/app/dashboard');
	}
};
