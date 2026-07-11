import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	changeMemberRole,
	inviteMember,
	listInvitations,
	listMembers,
	removeMember,
	resendInvitation,
	requireWorkspaceContext
} from '$lib/server/services/workspaces';
import { assignableRoleSchema, idSchema, inviteSchema, parseForm } from '$lib/server/validation';
import { translate } from '$lib/i18n';
import { canManageMembers } from '$lib/server/security/roles';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	return {
		members: await listMembers(context),
		invitations: await listInvitations(context),
		canManageInvitations: canManageMembers(context.role)
	};
};

export const actions: Actions = {
	invite: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), inviteSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check email and role.') });

		const result = await inviteMember(context, parsed.data);
		return {
			inviteUrl: result.url,
			inviteDeliveryStatus: result.deliveryStatus,
			notice: result.created
				? result.deliveryStatus === 'sent'
					? translate(event.locals.locale, 'Invitation created and email sent.')
					: translate(
							event.locals.locale,
							'Invitation created. Email delivery will be retried automatically.'
						)
				: translate(
						event.locals.locale,
						'A pending invitation already exists. Its link and role were kept unchanged.'
					)
		};
	},
	resend: async (event) => {
		const context = await requireWorkspaceContext(event);
		const id = idSchema.safeParse((await event.request.formData()).get('id'));
		if (!id.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid invitation.') });

		const result = await resendInvitation(context, id.data);
		return {
			inviteUrl: result.url,
			inviteDeliveryStatus: result.deliveryStatus,
			notice:
				result.deliveryStatus === 'sent'
					? translate(event.locals.locale, 'Invitation link rotated and email sent.')
					: translate(
							event.locals.locale,
							'Invitation link rotated. Email delivery will be retried automatically.'
						)
		};
	},
	changeRole: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		const role = assignableRoleSchema.safeParse(formData.get('role'));
		if (!id.success || !role.success)
			return fail(400, { message: translate(event.locals.locale, 'Check member and role.') });

		await changeMemberRole(context, id.data, role.data);
		throw redirect(303, '/app/settings/users');
	},
	remove: async (event) => {
		const context = await requireWorkspaceContext(event);
		const id = idSchema.safeParse((await event.request.formData()).get('id'));
		if (!id.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid member.') });

		await removeMember(context, id.data);
		throw redirect(303, '/app/settings/users');
	}
};
