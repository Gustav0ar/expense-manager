import { fail, redirect } from '@sveltejs/kit';
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
		if (!parsed.success) return fail(400, { message: 'Confira email e papel.' });

		const result = await inviteMember(context, parsed.data);
		return { inviteUrl: result.url };
	},
	changeRole: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		const role = assignableRoleSchema.safeParse(formData.get('role'));
		if (!id.success || !role.success) return fail(400, { message: 'Confira membro e papel.' });

		await changeMemberRole(context, id.data, role.data);
		throw redirect(303, '/app/settings/users');
	},
	remove: async (event) => {
		const context = await requireWorkspaceContext(event);
		const id = idSchema.safeParse((await event.request.formData()).get('id'));
		if (!id.success) return fail(400, { message: 'Membro invalido.' });

		await removeMember(context, id.data);
		throw redirect(303, '/app/settings/users');
	}
};
