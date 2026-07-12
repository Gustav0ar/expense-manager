import { error } from '@sveltejs/kit';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { auditEvent, workspace, workspaceInvitation, workspaceMember } from '$lib/server/db/schema';
import { safeEqual, sha256 } from '$lib/server/utils/crypto';
import { translate } from '$lib/i18n';
import type { SupportedLocale } from '$lib/i18n';

export async function getPendingInvitation(token: string) {
	const tokenHash = sha256(token);
	const [invitation] = await db
		.select({
			id: workspaceInvitation.id,
			email: workspaceInvitation.email,
			role: workspaceInvitation.role,
			status: workspaceInvitation.status,
			expiresAt: workspaceInvitation.expiresAt,
			workspaceId: workspaceInvitation.workspaceId,
			workspaceName: workspace.name
		})
		.from(workspaceInvitation)
		.innerJoin(workspace, eq(workspace.id, workspaceInvitation.workspaceId))
		.where(
			and(
				eq(workspaceInvitation.tokenHash, tokenHash),
				eq(workspaceInvitation.status, 'pending'),
				gt(workspaceInvitation.expiresAt, new Date())
			)
		);

	return invitation ?? null;
}

export async function acceptInvitation(
	token: string,
	userId: string,
	userEmail: string,
	locale: SupportedLocale = 'en'
) {
	const tokenHash = sha256(token);

	const workspaceId = await db.transaction(async (tx) => {
		const [invitation] = await tx
			.select({
				id: workspaceInvitation.id,
				email: workspaceInvitation.email,
				role: workspaceInvitation.role,
				workspaceId: workspaceInvitation.workspaceId
			})
			.from(workspaceInvitation)
			.where(
				and(
					eq(workspaceInvitation.tokenHash, tokenHash),
					eq(workspaceInvitation.status, 'pending'),
					gt(workspaceInvitation.expiresAt, new Date())
				)
			)
			.limit(1);

		if (!invitation) throw error(404, translate(locale, 'Invalid invite or expired.'));
		if (!safeEqual(invitation.email.toLowerCase(), userEmail.toLowerCase())) {
			throw error(403, translate(locale, 'This invite belongs to another email.'));
		}
		const [membership] = await tx
			.select({ role: workspaceMember.role, status: workspaceMember.status })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.workspaceId, invitation.workspaceId),
					eq(workspaceMember.userId, userId)
				)
			)
			.limit(1)
			.for('update');
		if (membership?.status === 'active' || membership?.role === 'owner') {
			throw error(
				409,
				translate(locale, 'This membership cannot be changed through an invitation.')
			);
		}

		const [accepted] = await tx
			.update(workspaceInvitation)
			.set({ status: 'accepted', acceptedAt: new Date() })
			.where(
				and(
					eq(workspaceInvitation.id, invitation.id),
					eq(workspaceInvitation.status, 'pending'),
					gt(workspaceInvitation.expiresAt, new Date())
				)
			)
			.returning({ id: workspaceInvitation.id });

		if (!accepted) throw error(404, translate(locale, 'Invalid invite or expired.'));

		if (membership) {
			const [reactivated] = await tx
				.update(workspaceMember)
				.set({ role: invitation.role, status: 'active' })
				.where(
					and(
						eq(workspaceMember.workspaceId, invitation.workspaceId),
						eq(workspaceMember.userId, userId),
						eq(workspaceMember.status, 'disabled'),
						eq(workspaceMember.role, membership.role)
					)
				)
				.returning({ id: workspaceMember.id });
			if (!reactivated) {
				throw error(
					409,
					translate(locale, 'This membership cannot be changed through an invitation.')
				);
			}
		} else {
			const [created] = await tx
				.insert(workspaceMember)
				.values({
					workspaceId: invitation.workspaceId,
					userId,
					role: invitation.role,
					status: 'active'
				})
				.onConflictDoNothing()
				.returning({ id: workspaceMember.id });
			if (!created) {
				throw error(
					409,
					translate(locale, 'This membership cannot be changed through an invitation.')
				);
			}
		}

		await tx.insert(auditEvent).values({
			workspaceId: invitation.workspaceId,
			actorUserId: userId,
			action: 'workspace_invitation.accepted',
			entityType: 'workspace_invitation',
			entityId: String(invitation.id)
		});

		return invitation.workspaceId;
	});

	return workspaceId;
}
