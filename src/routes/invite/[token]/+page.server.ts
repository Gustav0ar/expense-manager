import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { acceptInvitation, getPendingInvitation } from '$lib/server/services/invitations';
import { setWorkspaceCookie } from '$lib/server/services/workspaces';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = async (event) => {
	const token = event.params.token;
	const invitation = await getPendingInvitation(token);
	if (!invitation) {
		return { token, invitation: null, user: event.locals.user ?? null };
	}

	return {
		token,
		invitation,
		user: event.locals.user
			? {
					name: event.locals.user.name,
					email: event.locals.user.email
				}
			: null
	};
};

export const actions: Actions = {
	accept: async (event) => {
		if (!event.locals.user) {
			throw redirect(303, `/login?next=${encodeURIComponent(event.url.pathname)}`);
		}

		const invitation = await getPendingInvitation(event.params.token);
		if (!invitation)
			return fail(404, { message: translate(event.locals.locale, 'Invalid invite or expired.') });

		const workspaceId = await acceptInvitation(
			event.params.token,
			event.locals.user.id,
			event.locals.user.email
		);
		setWorkspaceCookie(event.cookies, workspaceId);
		throw redirect(303, '/app/dashboard');
	}
};
