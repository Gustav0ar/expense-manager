import { error, redirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	auditEvent,
	workspace,
	workspaceInvitation,
	workspaceInvitationDelivery,
	workspaceMember,
	user as authUser
} from '$lib/server/db/schema';
import type { Role } from '$lib/server/security/roles';
import { canManageMembers, canManageWorkspace } from '$lib/server/security/roles';
import { randomToken, sha256 } from '$lib/server/utils/crypto';
import { insertAuditEvent } from './audit';
import { env } from '$env/dynamic/private';
import type { SupportedLocale } from '$lib/i18n';
import { translate } from '$lib/i18n';
import { deliverInvitation } from './invitation-delivery';
import {
	decryptInvitationToken,
	encryptInvitationToken,
	InvitationTokenDecryptionError
} from './invitation-token';
import { lockWorkspaceCurrency } from './workspace-currency';

export type WorkspaceContext = {
	userId: string;
	workspaceId: number;
	workspaceName: string;
	currency: string;
	locale: SupportedLocale;
	weekStartsOn: number;
	role: Role;
};

export type WorkspaceMembership = Awaited<ReturnType<typeof getMemberships>>[number];

export async function requireUser(event: RequestEvent) {
	if (!event.locals.user) {
		throw redirect(303, `/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}

	return event.locals.user;
}

export async function getMemberships(userId: string) {
	return db
		.select({
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			currency: workspace.currency,
			weekStartsOn: workspace.weekStartsOn,
			role: workspaceMember.role,
			status: workspaceMember.status
		})
		.from(workspaceMember)
		.innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
		.where(and(eq(workspaceMember.userId, userId), eq(workspaceMember.status, 'active')))
		.orderBy(desc(workspaceMember.createdAt));
}

export async function resolveWorkspaceContext(
	event: RequestEvent
): Promise<WorkspaceContext | null> {
	if ('workspaceContext' in event.locals) return event.locals.workspaceContext ?? null;

	const currentUser = await requireUser(event);
	const memberships = event.locals.workspaceMemberships ?? (await getMemberships(currentUser.id));
	event.locals.workspaceMemberships = memberships;
	if (memberships.length === 0) return null;

	const cookieWorkspaceId = Number.parseInt(event.cookies.get('workspace_id') || '', 10);
	const selected =
		memberships.find((membership) => membership.workspaceId === cookieWorkspaceId) ??
		memberships[0];

	setWorkspaceCookie(event.cookies, selected.workspaceId);

	const context = {
		userId: currentUser.id,
		workspaceId: selected.workspaceId,
		workspaceName: selected.workspaceName,
		currency: selected.currency,
		locale: event.locals.locale,
		weekStartsOn: selected.weekStartsOn,
		role: selected.role as Role
	};

	event.locals.workspaceContext = context;
	return context;
}

export async function requireWorkspaceContext(event: RequestEvent) {
	const context = await resolveWorkspaceContext(event);
	if (!context) throw redirect(303, '/app/onboarding');
	return context;
}

export function setWorkspaceCookie(cookies: Cookies, workspaceId: number) {
	cookies.set('workspace_id', String(workspaceId), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: env.NODE_ENV === 'production',
		maxAge: 60 * 60 * 24 * 365
	});
}

export async function createWorkspace(
	userId: string,
	input: { name: string; weekStartsOn: number; currency: string }
) {
	const created = await db.transaction(async (tx) => {
		const [workspaceRow] = await tx
			.insert(workspace)
			.values({
				name: input.name,
				weekStartsOn: input.weekStartsOn,
				currency: input.currency,
				createdByUserId: userId
			})
			.returning({ id: workspace.id, name: workspace.name });

		await tx.insert(workspaceMember).values({
			workspaceId: workspaceRow.id,
			userId,
			role: 'owner',
			status: 'active'
		});

		await tx.insert(auditEvent).values({
			workspaceId: workspaceRow.id,
			actorUserId: userId,
			action: 'workspace.created',
			entityType: 'workspace',
			entityId: String(workspaceRow.id)
		});

		return workspaceRow;
	});

	return created;
}

export async function updateWorkspace(
	context: WorkspaceContext,
	input: { name: string; weekStartsOn: number; currency: string },
	options: { afterCurrencyLock?: () => Promise<void> } = {}
) {
	if (!canManageWorkspace(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const updated = await db.transaction(async (tx) => {
		const currentCurrency = await lockWorkspaceCurrency(tx, context.workspaceId);
		await options.afterCurrencyLock?.();
		if (input.currency.toUpperCase() !== currentCurrency.toUpperCase()) {
			const [artifacts] = await tx.execute<{
				expense_count: number;
				recurring_count: number;
				budget_count: number;
				preview_count: number;
				legacy_bank_count: number;
			}>(sql`
				select
					(select count(*)::int from expense where workspace_id = ${context.workspaceId}) as expense_count,
					(select count(*)::int from recurring_expense where workspace_id = ${context.workspaceId}) as recurring_count,
					(select count(*)::int from category_budget where workspace_id = ${context.workspaceId}) as budget_count,
					(select count(*)::int from import_preview
						where workspace_id = ${context.workspaceId}
							and status = 'pending' and expires_at > now()) as preview_count,
					(select count(*)::int from bank_transaction
						where workspace_id = ${context.workspaceId}
							and status = 'pending' and source_currency is null) as legacy_bank_count
			`);
			const artifactCount = Object.values(artifacts ?? {}).reduce(
				(total, value) => total + Number(value),
				0
			);
			if (artifactCount > 0) {
				throw error(
					422,
					translate(
						context.locale,
						'Cannot change currency while this workspace has monetary records. Remove or finish them first.'
					)
				);
			}
		}

		const [row] = await tx
			.update(workspace)
			.set({
				name: input.name,
				weekStartsOn: input.weekStartsOn,
				currency: input.currency
			})
			.where(eq(workspace.id, context.workspaceId))
			.returning({ id: workspace.id, name: workspace.name });

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'workspace.updated',
			entityType: 'workspace',
			entityId: context.workspaceId
		});

		return row;
	});

	return updated;
}

export async function listMembers(context: WorkspaceContext) {
	return db
		.select({
			id: workspaceMember.id,
			userId: authUser.id,
			name: authUser.name,
			email: authUser.email,
			role: workspaceMember.role,
			status: workspaceMember.status,
			createdAt: workspaceMember.createdAt
		})
		.from(workspaceMember)
		.innerJoin(authUser, eq(authUser.id, workspaceMember.userId))
		.where(
			and(
				eq(workspaceMember.workspaceId, context.workspaceId),
				eq(workspaceMember.status, 'active')
			)
		)
		.orderBy(workspaceMember.createdAt);
}

export async function listInvitations(context: WorkspaceContext) {
	return db
		.select({
			id: workspaceInvitation.id,
			email: workspaceInvitation.email,
			role: workspaceInvitation.role,
			status: workspaceInvitation.status,
			deliveryStatus: workspaceInvitationDelivery.status,
			deliveryAttemptCount: workspaceInvitationDelivery.attemptCount,
			deliveryErrorCategory: workspaceInvitationDelivery.lastErrorCategory,
			expiresAt: workspaceInvitation.expiresAt,
			createdAt: workspaceInvitation.createdAt
		})
		.from(workspaceInvitation)
		.leftJoin(
			workspaceInvitationDelivery,
			eq(workspaceInvitationDelivery.invitationId, workspaceInvitation.id)
		)
		.where(eq(workspaceInvitation.workspaceId, context.workspaceId))
		.orderBy(desc(workspaceInvitation.createdAt));
}

export async function inviteMember(
	context: WorkspaceContext,
	input: { email: string; role: 'admin' | 'member' | 'viewer' }
) {
	if (!canManageMembers(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const email = input.email.trim().toLowerCase();
	const token = randomToken();
	const tokenHash = sha256(token);
	const encryptedToken = encryptInvitationToken(token, tokenHash);
	const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
	const origin = env.ORIGIN || 'http://localhost:5173';

	const result = await db.transaction(async (tx) => {
		const [existingMembership] = await tx
			.select({
				id: workspaceMember.id,
				role: workspaceMember.role,
				status: workspaceMember.status
			})
			.from(workspaceMember)
			.innerJoin(authUser, eq(authUser.id, workspaceMember.userId))
			.where(
				and(
					eq(workspaceMember.workspaceId, context.workspaceId),
					sql`lower(${authUser.email}) = ${email}`
				)
			)
			.limit(1)
			.for('update');
		if (existingMembership?.status === 'active' || existingMembership?.role === 'owner') {
			throw error(
				409,
				translate(context.locale, 'This user is already an active workspace member.')
			);
		}

		await tx.execute(sql`
			with expired as (
				update "workspace_invitation"
				set "status" = 'expired'
				where "workspace_id" = ${context.workspaceId}
					and lower("email") = ${email}
					and "status" = 'pending'
					and "expires_at" <= now()
				returning "id"
			)
			update "workspace_invitation_delivery" d
			set "status" = 'failed',
				"claim_token" = null,
				"claim_expires_at" = null,
				"last_error_category" = 'expired',
				"updated_at" = now()
			where d."invitation_id" in (select "id" from expired)
		`);

		const [created] = await tx
			.insert(workspaceInvitation)
			.values({
				workspaceId: context.workspaceId,
				email,
				role: input.role,
				tokenHash,
				status: 'pending',
				invitedByUserId: context.userId,
				expiresAt
			})
			.onConflictDoNothing()
			.returning({ id: workspaceInvitation.id });

		if (created) {
			await tx.insert(workspaceInvitationDelivery).values({
				invitationId: created.id,
				encryptedToken,
				locale: context.locale
			});

			await insertAuditEvent(tx, {
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: 'workspace_member.invited',
				entityType: 'workspace_invitation',
				entityId: created.id,
				metadata: { role: input.role, email }
			});

			return { invitationId: created.id, token, created: true };
		}

		const [existing] = await tx
			.select({
				id: workspaceInvitation.id,
				tokenHash: workspaceInvitation.tokenHash,
				encryptedToken: workspaceInvitationDelivery.encryptedToken
			})
			.from(workspaceInvitation)
			.leftJoin(
				workspaceInvitationDelivery,
				eq(workspaceInvitationDelivery.invitationId, workspaceInvitation.id)
			)
			.where(
				and(
					eq(workspaceInvitation.workspaceId, context.workspaceId),
					sql`lower(${workspaceInvitation.email}) = ${email}`,
					eq(workspaceInvitation.status, 'pending')
				)
			)
			.limit(1);

		if (!existing) throw new Error('Invitation conflict could not be resolved.');
		let existingToken: string | null = null;
		if (existing.encryptedToken) {
			try {
				existingToken = decryptInvitationToken(existing.encryptedToken, existing.tokenHash);
			} catch (tokenError) {
				if (!(tokenError instanceof InvitationTokenDecryptionError)) throw tokenError;
			}
		}
		return {
			invitationId: existing.id,
			token: existingToken,
			created: false
		};
	});

	const delivery = result.created ? await deliverInvitation(result.invitationId, { origin }) : null;

	return {
		invitationId: result.invitationId,
		url: result.token ? `${origin.replace(/\/$/, '')}/invite/${result.token}` : null,
		created: result.created,
		deliveryStatus:
			delivery == null
				? 'unchanged'
				: delivery.sent > 0
					? 'sent'
					: delivery.failed > 0
						? 'failed'
						: 'in_progress'
	};
}

export async function resendInvitation(context: WorkspaceContext, invitationId: number) {
	if (!canManageMembers(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const token = randomToken();
	const tokenHash = sha256(token);
	const encryptedToken = encryptInvitationToken(token, tokenHash);
	const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
	const origin = env.ORIGIN || 'http://localhost:5173';

	await db.transaction(async (tx) => {
		const [invitation] = await tx.execute<{ id: number; email: string; role: string }>(sql`
			select "id", "email", "role"
			from "workspace_invitation"
			where "id" = ${invitationId}
				and "workspace_id" = ${context.workspaceId}
				and "status" = 'pending'
				and "expires_at" > now()
			for update
		`);
		if (!invitation)
			throw error(404, translate(context.locale, 'Invitation not found or expired.'));
		const lockedInvitationId = Number(invitation.id);

		await tx
			.update(workspaceInvitation)
			.set({
				tokenHash,
				invitedByUserId: context.userId,
				expiresAt,
				createdAt: new Date()
			})
			.where(eq(workspaceInvitation.id, lockedInvitationId));

		await tx
			.insert(workspaceInvitationDelivery)
			.values({
				invitationId,
				encryptedToken,
				locale: context.locale
			})
			.onConflictDoUpdate({
				target: workspaceInvitationDelivery.invitationId,
				set: {
					encryptedToken,
					locale: context.locale,
					status: 'pending',
					claimToken: null,
					claimExpiresAt: null,
					attemptCount: 0,
					lastErrorCategory: null,
					provider: null,
					providerMessageId: null,
					providerMessageUuid: null,
					sentAt: null,
					updatedAt: new Date()
				}
			});

		await insertAuditEvent(tx, {
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'workspace_invitation.resent',
			entityType: 'workspace_invitation',
			entityId: invitationId,
			metadata: { role: invitation.role, email: invitation.email }
		});
	});

	const delivery = await deliverInvitation(invitationId, { origin });
	return {
		invitationId,
		url: `${origin.replace(/\/$/, '')}/invite/${token}`,
		deliveryStatus: delivery.sent > 0 ? 'sent' : delivery.failed > 0 ? 'failed' : 'in_progress'
	};
}

export async function changeMemberRole(
	context: WorkspaceContext,
	memberId: number,
	role: 'admin' | 'member' | 'viewer'
) {
	if (!canManageMembers(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const member = await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(workspaceMember)
			.set({ role })
			.where(
				and(
					eq(workspaceMember.id, memberId),
					eq(workspaceMember.workspaceId, context.workspaceId),
					ne(workspaceMember.role, 'owner'),
					ne(workspaceMember.userId, context.userId)
				)
			)
			.returning({ id: workspaceMember.id, userId: workspaceMember.userId });

		if (updated) {
			await insertAuditEvent(tx, {
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: 'workspace_member.role_changed',
				entityType: 'workspace_member',
				entityId: updated.id,
				metadata: { role }
			});
		}

		return updated;
	});

	if (!member) {
		// Check whether the update failed because the actor targeted their own
		// membership — that's now blocked by the ne(userId) guard and needs a
		// clearer message than the generic "not found."
		const [self] = await db
			.select({ id: workspaceMember.id })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.id, memberId),
					eq(workspaceMember.workspaceId, context.workspaceId),
					eq(workspaceMember.userId, context.userId)
				)
			)
			.limit(1);
		if (self) throw error(403, translate(context.locale, 'You cannot change your own role.'));
		throw error(404, translate(context.locale, 'Member not found.'));
	}
}

export async function removeMember(context: WorkspaceContext, memberId: number) {
	if (!canManageMembers(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const member = await db.transaction(async (tx) => {
		const [updated] = await tx
			.update(workspaceMember)
			.set({ status: 'disabled' })
			.where(
				and(
					eq(workspaceMember.id, memberId),
					eq(workspaceMember.workspaceId, context.workspaceId),
					ne(workspaceMember.role, 'owner'),
					ne(workspaceMember.userId, context.userId)
				)
			)
			.returning({ id: workspaceMember.id });

		if (updated) {
			await insertAuditEvent(tx, {
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: 'workspace_member.disabled',
				entityType: 'workspace_member',
				entityId: updated.id
			});
		}

		return updated;
	});

	if (!member) {
		const [self] = await db
			.select({ id: workspaceMember.id })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.id, memberId),
					eq(workspaceMember.workspaceId, context.workspaceId),
					eq(workspaceMember.userId, context.userId)
				)
			)
			.limit(1);
		if (self) throw error(403, translate(context.locale, 'You cannot remove yourself.'));
		throw error(404, translate(context.locale, 'Member not found.'));
	}
}
