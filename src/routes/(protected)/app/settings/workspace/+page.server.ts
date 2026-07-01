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
	localePreferenceSchema,
	parseForm,
	themePreferenceSchema,
	workspaceSchema
} from '$lib/server/validation';
import { setThemePreference } from '$lib/server/theme';
import { setLocalePreference } from '$lib/server/i18n';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = async (event) => {
	await requireWorkspaceContext(event);
	return {};
};

export const actions: Actions = {
	update: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), workspaceSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check workspace data.') });

		await updateWorkspace(context, parsed.data);
		throw redirect(303, '/app/settings/workspace');
	},
	updateTheme: async (event) => {
		await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), themePreferenceSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid theme.') });

		setThemePreference(event.cookies, parsed.data.theme);
		throw redirect(303, '/app/settings/workspace');
	},
	updateLocale: async (event) => {
		await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), localePreferenceSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Language is invalid.') });

		setLocalePreference(event.cookies, parsed.data.locale);
		throw redirect(303, '/app/settings/workspace');
	},
	create: async (event) => {
		if (!event.locals.user) throw redirect(303, '/login');
		const parsed = parseForm(await event.request.formData(), workspaceSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check workspace data.') });

		const created = await createWorkspace(event.locals.user.id, parsed.data);
		setWorkspaceCookie(event.cookies, created.id);
		throw redirect(303, '/app/dashboard');
	},
	switchWorkspace: async (event) => {
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('workspaceId'));
		if (!id.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid workspace.') });

		setWorkspaceCookie(event.cookies, id.data);
		throw redirect(303, '/app/dashboard');
	}
};
