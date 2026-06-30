import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getMemberships, resolveWorkspaceContext } from '$lib/server/services/workspaces';
import { getThemePreference } from '$lib/server/theme';

export const load: LayoutServerLoad = async (event) => {
	if (!event.locals.user) {
		throw redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}

	const memberships =
		event.locals.workspaceMemberships ?? (await getMemberships(event.locals.user.id));
	event.locals.workspaceMemberships = memberships;
	const context = await resolveWorkspaceContext(event);

	if (!context && event.route.id !== '/(protected)/app/onboarding') {
		throw redirect(303, '/app/onboarding');
	}

	if (context && event.route.id === '/(protected)/app/onboarding') {
		throw redirect(303, '/app/dashboard');
	}

	return {
		user: {
			id: event.locals.user.id,
			name: event.locals.user.name,
			email: event.locals.user.email
		},
		themePreference: getThemePreference(event.cookies),
		memberships,
		currentWorkspace: context
	};
};
