import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	createWorkspace,
	requireWorkspaceContext,
	setWorkspaceCookie,
	updateWorkspace
} from '$lib/server/services/workspaces';
import {
	idSchema,
	parseForm,
	themePreferenceSchema,
	workspaceSchema
} from '$lib/server/validation';
import { setThemePreference } from '$lib/server/theme';

export const load: PageServerLoad = async (event) => {
	await requireWorkspaceContext(event);
	return {};
};

export const actions: Actions = {
	update: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), workspaceSchema);
		if (!parsed.success) return fail(400, { message: 'Confira os dados do workspace.' });

		await updateWorkspace(context, parsed.data);
		throw redirect(303, '/app/settings/workspace');
	},
	updateTheme: async (event) => {
		await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), themePreferenceSchema);
		if (!parsed.success) return fail(400, { message: 'Tema invalido.' });

		setThemePreference(event.cookies, parsed.data.theme);
		throw redirect(303, '/app/settings/workspace');
	},
	create: async (event) => {
		if (!event.locals.user) throw redirect(303, '/login');
		const parsed = parseForm(await event.request.formData(), workspaceSchema);
		if (!parsed.success) return fail(400, { message: 'Confira os dados do workspace.' });

		const created = await createWorkspace(event.locals.user.id, parsed.data);
		setWorkspaceCookie(event.cookies, created.id);
		throw redirect(303, '/app/dashboard');
	},
	switchWorkspace: async (event) => {
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('workspaceId'));
		if (!id.success) return fail(400, { message: 'Workspace invalido.' });

		setWorkspaceCookie(event.cookies, id.data);
		throw redirect(303, '/app/dashboard');
	}
};
