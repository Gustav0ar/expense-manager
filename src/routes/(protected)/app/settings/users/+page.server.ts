import { fail, redirect } from '@sveltejs/kit';
import { isHttpError } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	changeMemberRole,
	inviteMember,
	listInvitations,
	listMembers,
	removeMember,
	requireWorkspaceContext
} from '$lib/server/services/workspaces';
import { assignableRoleSchema, idSchema, inviteSchema, parseForm } from '$lib/server/validation';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	return {
		members: await listMembers(context),
		invitations: await listInvitations(context)
	};
};

export const actions: Actions = {
	invite: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), inviteSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check email and role.') });

		const result = await inviteMember(context, parsed.data);
		return { inviteUrl: result.url };
	},
	changeRole: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		const role = assignableRoleSchema.safeParse(formData.get('role'));
		if (!id.success || !role.success)
			return fail(400, { message: translate(event.locals.locale, 'Check member and role.') });

		try {
			await changeMemberRole(context, id.data, role.data);
		} catch (err) {
			if (isHttpError(err) && err.status < 500) {
				return fail(err.status, { message: err.body.message });
			}
			throw err;
		}
		throw redirect(303, '/app/settings/users');
	},
	remove: async (event) => {
		const context = await requireWorkspaceContext(event);
		const id = idSchema.safeParse((await event.request.formData()).get('id'));
		if (!id.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid member.') });

		try {
			await removeMember(context, id.data);
		} catch (err) {
			if (isHttpError(err) && err.status < 500) {
				return fail(err.status, { message: err.body.message });
			}
			throw err;
		}
		throw redirect(303, '/app/settings/users');
	}
};
