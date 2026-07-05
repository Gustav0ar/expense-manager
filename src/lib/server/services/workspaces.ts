import { error, redirect, type Cookies, type RequestEvent } from '@sveltejs/kit';
import { and, count, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	auditEvent,
	expense,
	workspace,
	workspaceInvitation,
	workspaceMember,
	user as authUser
} from '$lib/server/db/schema';
import type { Role } from '$lib/server/security/roles';
import { canManageMembers, canManageWorkspace } from '$lib/server/security/roles';
import { randomToken, sha256 } from '$lib/server/utils/crypto';
import { sendInvitationEmail } from '$lib/server/email';
import { writeAuditEvent } from './audit';
import { env } from '$env/dynamic/private';
import type { SupportedLocale } from '$lib/i18n';
import { translate } from '$lib/i18n';

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
	input: { name: string; weekStartsOn: number; currency: string }
) {
	if (!canManageWorkspace(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	if (input.currency && input.currency.toUpperCase() !== context.currency.toUpperCase()) {
		const [{ value: expenseCount }] = await db
			.select({ value: count() })
			.from(expense)
			.where(and(eq(expense.workspaceId, context.workspaceId), isNull(expense.deletedAt)));

		if (expenseCount > 0) {
			throw error(
				422,
				translate(
					context.locale,
					'Cannot change currency: this workspace has {count} expense(s). Delete all expenses first.',
					{ count: expenseCount }
				)
			);
		}
	}

	const [updated] = await db
		.update(workspace)
		.set({
			name: input.name,
			weekStartsOn: input.weekStartsOn,
			currency: input.currency
		})
		.where(eq(workspace.id, context.workspaceId))
		.returning({ id: workspace.id, name: workspace.name });

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'workspace.updated',
		entityType: 'workspace',
		entityId: context.workspaceId
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
			expiresAt: workspaceInvitation.expiresAt,
			createdAt: workspaceInvitation.createdAt
		})
		.from(workspaceInvitation)
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
	const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
	const expiresAtIso = expiresAt.toISOString();
	const origin = env.ORIGIN || 'http://localhost:5173';
	const url = `${origin}/invite/${token}`;

	const result = await db.transaction(async (tx) => {
		const [invitation] = await tx.execute<{ id: number }>(sql`
			insert into "workspace_invitation" (
				"workspace_id",
				"email",
				"role",
				"token_hash",
				"status",
				"invited_by_user_id",
				"expires_at",
				"created_at"
			)
			values (
				${context.workspaceId},
				${email},
				${input.role},
				${tokenHash},
				'pending',
				${context.userId},
				${expiresAtIso}::timestamptz,
				now()
			)
			on conflict ("workspace_id", lower("email")) where "status" = 'pending'
			do update set
				"role" = excluded."role",
				"token_hash" = excluded."token_hash",
				"invited_by_user_id" = excluded."invited_by_user_id",
				"expires_at" = excluded."expires_at",
				"created_at" = now()
			returning "id"
		`);

		const invitationId = Number(invitation.id);

		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'workspace_member.invited',
			entityType: 'workspace_invitation',
			entityId: String(invitationId),
			metadata: { role: input.role, email }
		});

		return { invitationId, url };
	});

	// Send the email after the transaction commits so a failed email
	// cannot roll back the invitation row, and a rolled-back transaction
	// does not send an email for a non-existent record.
	await sendInvitationEmail(email, context.workspaceName, url, context.locale);

	return result;
}

export async function changeMemberRole(
	context: WorkspaceContext,
	memberId: number,
	role: 'admin' | 'member' | 'viewer'
) {
	if (!canManageMembers(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const [member] = await db
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

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'workspace_member.role_changed',
		entityType: 'workspace_member',
		entityId: member.id,
		metadata: { role }
	});
}

export async function removeMember(context: WorkspaceContext, memberId: number) {
	if (!canManageMembers(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const [member] = await db
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

	await writeAuditEvent({
		workspaceId: context.workspaceId,
		actorUserId: context.userId,
		action: 'workspace_member.disabled',
		entityType: 'workspace_member',
		entityId: member.id
	});
}
