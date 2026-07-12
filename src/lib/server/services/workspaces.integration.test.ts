import { randomUUID } from 'node:crypto';
import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { user } from '$lib/server/db/auth.schema';
import {
	category,
	bankTransaction,
	categoryBudget,
	expense,
	auditEvent,
	importPreview,
	recurringExpense,
	workspace,
	workspaceInvitation,
	workspaceMember
} from '$lib/server/db/schema';
import { db } from '$lib/server/db';
import { listAuditEvents, writeAuditEvent } from './audit';
import { createExpense } from './expenses';
import { lockWorkspaceCurrency } from './workspace-currency';
import {
	changeMemberRole,
	createWorkspace,
	getMemberships,
	listInvitations,
	listMembers,
	removeMember,
	inviteMember,
	requireUser,
	requireWorkspaceContext,
	resolveWorkspaceContext,
	setWorkspaceCookie,
	updateWorkspace,
	type WorkspaceContext
} from './workspaces';

const workspaceIds: number[] = [];
const userIds: string[] = [];

describe('workspace service integration', () => {
	afterEach(async () => {
		for (const workspaceId of workspaceIds.splice(0)) {
			await db.delete(workspace).where(eq(workspace.id, workspaceId));
		}
		for (const userId of userIds.splice(0)) {
			await db.delete(user).where(eq(user.id, userId));
		}
	});

	it('fails a currency lock when the workspace no longer exists', async () => {
		await expect(db.transaction((tx) => lockWorkspaceCurrency(tx, 2_147_483_647))).rejects.toThrow(
			'Workspace currency lock target not found.'
		);
	});

	it('requires authentication and redirects users without a workspace', async () => {
		const anonymous = requestEvent();
		await expect(requireUser(anonymous)).rejects.toMatchObject({
			status: 303,
			location: '/login?next=%2Fapp%2Fexpenses%3Fpage%3D2'
		});

		const account = await createUser('no-workspace');
		const authenticated = requestEvent({ user: account });
		expect(await requireUser(authenticated)).toMatchObject({ id: account.id });
		await expect(requireWorkspaceContext(authenticated)).rejects.toMatchObject({
			status: 303,
			location: '/app/onboarding'
		});
	});

	it('creates memberships and resolves the selected workspace with a durable cookie', async () => {
		const account = await createUser('workspace-owner');
		const first = await createTrackedWorkspace(account.id, 'First workspace');
		const second = await createTrackedWorkspace(account.id, 'Second workspace');
		const memberships = await getMemberships(account.id);
		expect(memberships.map((membership) => membership.workspaceId)).toEqual([second.id, first.id]);

		const cookies = cookieJar({ workspace_id: String(first.id) });
		const event = requestEvent({ user: account, cookies });
		const context = await resolveWorkspaceContext(event);
		expect(context).toMatchObject({
			workspaceId: first.id,
			workspaceName: 'First workspace',
			role: 'owner',
			locale: 'en'
		});
		expect(cookies.set).toHaveBeenCalledWith(
			'workspace_id',
			String(first.id),
			expect.objectContaining({ httpOnly: true, sameSite: 'lax' })
		);

		// A resolved context is cached in locals and does not query or rewrite cookies again.
		cookies.set.mockClear();
		expect(await resolveWorkspaceContext(event)).toBe(context);
		expect(cookies.set).not.toHaveBeenCalled();

		const explicitCookies = cookieJar();
		setWorkspaceCookie(explicitCookies, second.id);
		expect(explicitCookies.set).toHaveBeenCalledWith(
			'workspace_id',
			String(second.id),
			expect.objectContaining({ path: '/', maxAge: 31_536_000 })
		);

		const cachedEmpty = requestEvent({ user: account });
		cachedEmpty.locals.workspaceContext = null;
		await expect(resolveWorkspaceContext(cachedEmpty)).resolves.toBeNull();

		const preloaded = requestEvent({ user: account });
		preloaded.locals.workspaceMemberships = memberships;
		await expect(requireWorkspaceContext(preloaded)).resolves.toMatchObject({
			workspaceId: second.id
		});
	});

	it('updates workspace settings while guarding permissions and currency history', async () => {
		const account = await createUser('settings-owner');
		const created = await createTrackedWorkspace(account.id, 'Settings workspace');
		const context = workspaceContext(account.id, created.id, created.name);

		await expect(
			updateWorkspace(
				{ ...context, role: 'member' },
				{ name: 'Denied', weekStartsOn: 0, currency: 'USD' }
			)
		).rejects.toMatchObject({ status: 403 });

		await expect(
			updateWorkspace(context, { name: 'Renamed workspace', weekStartsOn: 1, currency: 'BRL' })
		).resolves.toMatchObject({ id: created.id, name: 'Renamed workspace' });
		await expect(
			updateWorkspace(context, { name: 'Same currency', weekStartsOn: 0, currency: 'USD' })
		).resolves.toMatchObject({ id: created.id, name: 'Same currency' });

		const [categoryRow] = await db
			.insert(category)
			.values({ workspaceId: created.id, name: 'Travel', color: '#123456' })
			.returning({ id: category.id });
		await db.insert(expense).values({
			workspaceId: created.id,
			categoryId: categoryRow.id,
			createdByUserId: account.id,
			description: 'Flight',
			amountCents: 100,
			currency: 'USD',
			expenseDate: '2026-07-01'
		});

		await expect(
			updateWorkspace(
				{ ...context, currency: 'BRL' },
				{ name: 'Blocked currency', weekStartsOn: 1, currency: 'EUR' }
			)
		).rejects.toMatchObject({ status: 422 });
	});

	it('blocks currency changes for every unresolved monetary artifact', async () => {
		const makeFixture = async (prefix: string) => {
			const account = await createUser(prefix);
			const created = await createTrackedWorkspace(account.id, `${prefix} workspace`);
			const [categoryRow] = await db
				.insert(category)
				.values({ workspaceId: created.id, name: `${prefix} category`, color: '#123456' })
				.returning({ id: category.id });
			return {
				account,
				created,
				categoryId: categoryRow.id,
				context: workspaceContext(account.id, created.id, created.name)
			};
		};
		const expectBlocked = async (fixture: Awaited<ReturnType<typeof makeFixture>>) => {
			await expect(
				updateWorkspace(fixture.context, {
					name: fixture.created.name,
					weekStartsOn: 0,
					currency: 'BRL'
				})
			).rejects.toMatchObject({ status: 422 });
		};

		const trash = await makeFixture('currency-trash');
		const deletedAt = new Date();
		await db.insert(expense).values({
			workspaceId: trash.created.id,
			categoryId: trash.categoryId,
			createdByUserId: trash.account.id,
			description: 'Retained expense',
			amountCents: 100,
			currency: 'USD',
			expenseDate: '2026-07-01',
			deletedAt,
			trashExpiresAt: new Date(deletedAt.getTime() + 60_000)
		});
		await expectBlocked(trash);

		const recurrence = await makeFixture('currency-recurrence');
		await db.insert(recurringExpense).values({
			workspaceId: recurrence.created.id,
			categoryId: recurrence.categoryId,
			createdByUserId: recurrence.account.id,
			description: 'Future recurrence',
			amountCents: 200,
			currency: 'USD',
			startDate: '2026-08-01',
			nextRunDate: '2026-08-01'
		});
		await expectBlocked(recurrence);

		const budget = await makeFixture('currency-budget');
		await db.insert(categoryBudget).values({
			workspaceId: budget.created.id,
			categoryId: budget.categoryId,
			periodMonth: '2026-08-01',
			amountCents: 300,
			createdByUserId: budget.account.id
		});
		await expectBlocked(budget);

		const preview = await makeFixture('currency-preview');
		await db.insert(importPreview).values({
			workspaceId: preview.created.id,
			uploadedByUserId: preview.account.id,
			sourceType: 'csv',
			fileName: 'pending.csv',
			sourceChecksum: 'a'.repeat(64),
			rowCount: 0,
			analysis: { rows: [], failedRows: [] },
			expiresAt: new Date(Date.now() + 60_000)
		});
		await expectBlocked(preview);

		const legacyBank = await makeFixture('currency-bank');
		await db.insert(bankTransaction).values({
			workspaceId: legacyBank.created.id,
			uploadedByUserId: legacyBank.account.id,
			sourceAccountFingerprint: 'b'.repeat(64),
			sourceIdentity: 'c'.repeat(64),
			sourceChecksum: 'd'.repeat(64),
			sourceCurrency: null,
			fileName: 'legacy.ofx',
			postedDate: '2026-07-01',
			signedAmountCents: -400,
			description: 'Legacy pending bank transaction'
		});
		await expectBlocked(legacyBank);
	});

	it('serializes expense creation with currency changes in either lock order', async () => {
		const firstAccount = await createUser('currency-create-first');
		const firstWorkspace = await createTrackedWorkspace(firstAccount.id, 'Create first');
		const [firstCategory] = await db
			.insert(category)
			.values({ workspaceId: firstWorkspace.id, name: 'First category', color: '#123456' })
			.returning({ id: category.id });
		const firstContext = workspaceContext(firstAccount.id, firstWorkspace.id, firstWorkspace.name);
		let releaseCreate!: () => void;
		let markCreateLocked!: () => void;
		const createLocked = new Promise<void>((resolve) => (markCreateLocked = resolve));
		const createGate = new Promise<void>((resolve) => (releaseCreate = resolve));
		const creating = createExpense(
			firstContext,
			{
				categoryId: firstCategory.id,
				description: 'Serialized expense',
				amount: '1.00',
				expenseDate: '2026-07-01'
			},
			{
				afterCurrencyLock: async () => {
					markCreateLocked();
					await createGate;
				}
			}
		);
		await createLocked;
		const blockedChange = updateWorkspace(firstContext, {
			name: firstWorkspace.name,
			weekStartsOn: 0,
			currency: 'BRL'
		}).then(
			(value) => ({ status: 'fulfilled' as const, value }),
			(reason: unknown) => ({ status: 'rejected' as const, reason })
		);
		releaseCreate();
		await creating;
		const blockedResult = await blockedChange;
		expect(blockedResult.status).toBe('rejected');
		if (blockedResult.status === 'rejected') {
			expect(blockedResult.reason).toMatchObject({ status: 422 });
		}

		const secondAccount = await createUser('currency-change-first');
		const secondWorkspace = await createTrackedWorkspace(secondAccount.id, 'Change first');
		const [secondCategory] = await db
			.insert(category)
			.values({ workspaceId: secondWorkspace.id, name: 'Second category', color: '#123456' })
			.returning({ id: category.id });
		const staleContext = workspaceContext(
			secondAccount.id,
			secondWorkspace.id,
			secondWorkspace.name
		);
		let releaseChange!: () => void;
		let markChangeLocked!: () => void;
		const changeLocked = new Promise<void>((resolve) => (markChangeLocked = resolve));
		const changeGate = new Promise<void>((resolve) => (releaseChange = resolve));
		const changing = updateWorkspace(
			staleContext,
			{ name: secondWorkspace.name, weekStartsOn: 0, currency: 'BRL' },
			{
				afterCurrencyLock: async () => {
					markChangeLocked();
					await changeGate;
				}
			}
		);
		await changeLocked;
		const createdAfterChange = createExpense(staleContext, {
			categoryId: secondCategory.id,
			description: 'Current currency expense',
			amount: '2.00',
			expenseDate: '2026-07-02'
		});
		releaseChange();
		await changing;
		const created = await createdAfterChange;
		await expect(
			db.select({ currency: expense.currency }).from(expense).where(eq(expense.id, created.id))
		).resolves.toEqual([{ currency: 'BRL' }]);
	});

	it('allows currency changes after previews expire and preserves explicit bank currency', async () => {
		const account = await createUser('currency-finished-state');
		const created = await createTrackedWorkspace(account.id, 'Finished monetary state');
		const context = workspaceContext(account.id, created.id, created.name);
		await db.insert(importPreview).values({
			workspaceId: created.id,
			uploadedByUserId: account.id,
			sourceType: 'csv',
			fileName: 'expired.csv',
			sourceChecksum: 'e'.repeat(64),
			rowCount: 0,
			analysis: { rows: [], failedRows: [] },
			expiresAt: new Date(Date.now() - 60_000)
		});
		await db.insert(bankTransaction).values({
			workspaceId: created.id,
			uploadedByUserId: account.id,
			sourceAccountFingerprint: 'f'.repeat(64),
			sourceIdentity: '1'.repeat(64),
			sourceChecksum: '2'.repeat(64),
			sourceCurrency: 'USD',
			fileName: 'explicit.ofx',
			postedDate: '2026-07-01',
			signedAmountCents: -500,
			description: 'Explicit currency transaction'
		});

		await expect(
			updateWorkspace(context, {
				name: created.name,
				weekStartsOn: 0,
				currency: 'BRL'
			})
		).resolves.toMatchObject({ id: created.id });
		await expect(
			db
				.select({ currency: workspace.currency })
				.from(workspace)
				.where(eq(workspace.id, created.id))
		).resolves.toEqual([{ currency: 'BRL' }]);
		await expect(
			db
				.select({ sourceCurrency: bankTransaction.sourceCurrency })
				.from(bankTransaction)
				.where(eq(bankTransaction.workspaceId, created.id))
		).resolves.toEqual([{ sourceCurrency: 'USD' }]);
	});

	it('lists members and invitations and enforces member-management boundaries', async () => {
		const owner = await createUser('member-owner');
		const member = await createUser('managed-member');
		const outsider = await createUser('outsider');
		const created = await createTrackedWorkspace(owner.id, 'Members workspace');
		const context = workspaceContext(owner.id, created.id, created.name);
		const [memberRow] = await db
			.insert(workspaceMember)
			.values({ workspaceId: created.id, userId: member.id, role: 'member', status: 'active' })
			.returning({ id: workspaceMember.id });
		await expect(
			inviteMember({ ...context, role: 'viewer' }, { email: outsider.email, role: 'member' })
		).rejects.toMatchObject({ status: 403 });
		const [ownerRow] = await db
			.select({ id: workspaceMember.id })
			.from(workspaceMember)
			.where(eq(workspaceMember.userId, owner.id));

		await db.insert(workspaceInvitation).values({
			workspaceId: created.id,
			email: outsider.email,
			role: 'viewer',
			tokenHash: randomUUID().replaceAll('-', ''),
			invitedByUserId: owner.id,
			expiresAt: new Date(Date.now() + 60_000)
		});
		expect(await listMembers(context)).toHaveLength(2);
		expect(await listInvitations(context)).toEqual([
			expect.objectContaining({ email: outsider.email, role: 'viewer', status: 'pending' })
		]);

		await expect(
			changeMemberRole({ ...context, role: 'viewer' }, memberRow.id, 'admin')
		).rejects.toMatchObject({ status: 403 });
		await expect(changeMemberRole(context, memberRow.id, 'admin')).resolves.toBeUndefined();
		expect(await listMembers(context)).toContainEqual(expect.objectContaining({ role: 'admin' }));
		await expect(changeMemberRole(context, ownerRow.id, 'viewer')).rejects.toMatchObject({
			status: 403
		});
		await expect(changeMemberRole(context, 2_147_483_647, 'viewer')).rejects.toMatchObject({
			status: 404
		});

		await expect(removeMember({ ...context, role: 'viewer' }, memberRow.id)).rejects.toMatchObject({
			status: 403
		});
		await expect(removeMember(context, ownerRow.id)).rejects.toMatchObject({ status: 403 });
		await expect(removeMember(context, 2_147_483_647)).rejects.toMatchObject({ status: 404 });
		await expect(removeMember(context, memberRow.id)).resolves.toBeUndefined();
		expect(await listMembers(context)).toHaveLength(1);
	});

	it('rolls back a member role change when its audit event cannot be inserted', async () => {
		const owner = await createUser('atomic-role-owner');
		const member = await createUser('atomic-role-member');
		const created = await createTrackedWorkspace(owner.id, 'Atomic role workspace');
		const context = workspaceContext(owner.id, created.id, created.name);
		const [memberRow] = await db
			.insert(workspaceMember)
			.values({ workspaceId: created.id, userId: member.id, role: 'member', status: 'active' })
			.returning({ id: workspaceMember.id });

		await expect(
			changeMemberRole({ ...context, userId: `missing-${randomUUID()}` }, memberRow.id, 'admin')
		).rejects.toMatchObject({ cause: { code: '23503' } });
		expect(await listMembers(context)).toContainEqual(
			expect.objectContaining({ id: memberRow.id, role: 'member' })
		);

		await changeMemberRole(context, memberRow.id, 'admin');
		const events = await db
			.select({ entityId: auditEvent.entityId })
			.from(auditEvent)
			.where(
				and(
					eq(auditEvent.workspaceId, created.id),
					eq(auditEvent.action, 'workspace_member.role_changed'),
					eq(auditEvent.entityId, String(memberRow.id))
				)
			);
		expect(events).toEqual([{ entityId: String(memberRow.id) }]);
	});

	it('writes and filters a stable, cursor-paginated audit trail', async () => {
		const owner = await createUser('audit-owner');
		const created = await createTrackedWorkspace(owner.id, 'Audit workspace');
		const context = workspaceContext(owner.id, created.id, created.name);
		const action = `coverage.${randomUUID()}`;
		for (let index = 1; index <= 3; index += 1) {
			await writeAuditEvent({
				workspaceId: created.id,
				actorUserId: owner.id,
				action,
				entityType: index === 3 ? 'other' : 'coverage',
				entityId: index,
				metadata: { index }
			});
		}

		const firstPage = await listAuditEvents(context, { action, limit: 2 });
		expect(firstPage.items).toHaveLength(2);
		expect(firstPage.items[0]).toMatchObject({ actorName: owner.name, actorUserId: owner.id });
		expect(firstPage.nextCursor).toEqual(expect.any(String));
		const secondPage = await listAuditEvents(context, {
			action,
			cursor: firstPage.nextCursor!,
			limit: 2
		});
		expect(secondPage.items).toHaveLength(1);
		expect(secondPage.nextCursor).toBeNull();

		expect(
			await listAuditEvents(context, { action, entityType: 'coverage', limit: 500 })
		).toMatchObject({
			items: [
				expect.objectContaining({ entityId: '2' }),
				expect.objectContaining({ entityId: '1' })
			]
		});
		expect(await listAuditEvents(context, { action, cursor: 'not-json', limit: 0 })).toMatchObject({
			items: expect.any(Array)
		});
		expect(
			await listAuditEvents(context, {
				action,
				cursor: Buffer.from(JSON.stringify({ id: -1 })).toString('base64url')
			})
		).toMatchObject({ items: expect.any(Array) });

		const globalAction = `global.${randomUUID()}`;
		await writeAuditEvent({ action: globalAction, entityType: 'system' });
		await expect(
			db
				.select({
					workspaceId: auditEvent.workspaceId,
					actorUserId: auditEvent.actorUserId,
					entityId: auditEvent.entityId,
					metadata: auditEvent.metadata
				})
				.from(auditEvent)
				.where(eq(auditEvent.action, globalAction))
		).resolves.toEqual([{ workspaceId: null, actorUserId: null, entityId: null, metadata: null }]);
		await db.delete(auditEvent).where(eq(auditEvent.action, globalAction));
	});
});

async function createUser(prefix: string) {
	const id = `${prefix}-${randomUUID()}`;
	const email = `${id}@example.com`;
	await db.insert(user).values({ id, name: prefix, email, emailVerified: true });
	userIds.push(id);
	return { id, name: prefix, email };
}

async function createTrackedWorkspace(userId: string, name: string) {
	const created = await createWorkspace(userId, { name, weekStartsOn: 0, currency: 'USD' });
	workspaceIds.push(created.id);
	return created;
}

function workspaceContext(
	userId: string,
	workspaceId: number,
	workspaceName: string
): WorkspaceContext {
	return {
		userId,
		workspaceId,
		workspaceName,
		currency: 'USD',
		locale: 'en',
		weekStartsOn: 0,
		role: 'owner'
	};
}

function cookieJar(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		get: vi.fn((name: string) => values.get(name)),
		set: vi.fn((name: string, value: string) => values.set(name, value)),
		delete: vi.fn((name: string) => values.delete(name))
	} as unknown as Cookies & {
		set: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
	};
}

function requestEvent(
	input: { user?: { id: string; name: string; email: string }; cookies?: Cookies } = {}
) {
	return {
		url: new URL('http://localhost/app/expenses?page=2'),
		request: new Request('http://localhost/app/expenses?page=2'),
		cookies: input.cookies ?? cookieJar(),
		locals: { user: input.user ?? null, locale: 'en' }
	} as unknown as RequestEvent;
}
