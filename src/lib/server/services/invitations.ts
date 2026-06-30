import { error } from '@sveltejs/kit';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { auditEvent, workspace, workspaceInvitation, workspaceMember } from '$lib/server/db/schema';
import { safeEqual, sha256 } from '$lib/server/utils/crypto';

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

export async function acceptInvitation(token: string, userId: string, userEmail: string) {
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

		if (!invitation) throw error(404, 'Convite inválido ou expirado.');
		if (!safeEqual(invitation.email.toLowerCase(), userEmail.toLowerCase())) {
			throw error(403, 'Este convite pertence a outro e-mail.');
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

		if (!accepted) throw error(404, 'Convite inválido ou expirado.');

		await tx
			.insert(workspaceMember)
			.values({
				workspaceId: invitation.workspaceId,
				userId,
				role: invitation.role,
				status: 'active'
			})
			.onConflictDoUpdate({
				target: [workspaceMember.workspaceId, workspaceMember.userId],
				set: {
					role: invitation.role,
					status: 'active'
				}
			});

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
