import type { ServiceIntegrationTestContext } from '../services.integration.test';

export function registerInvitationTests(context: ServiceIntegrationTestContext) {
	const {
		randomUUID,
		expect,
		it,
		vi,
		and,
		eq,
		auditEvent,
		workspaceInvitation,
		workspaceInvitationDelivery,
		workspaceMember,
		client,
		db,
		sha256,
		acceptInvitation,
		getPendingInvitation,
		deliverInvitation,
		invitationDeliveryMaxAttempts,
		invitationDeliverySchedulerLockKey,
		runInvitationDeliveryScheduler,
		inviteMember,
		resendInvitation,
		createWorkspaceFixture,
		createUser
	} = context;

	it('accepts an invitation only once under repeated submission', async () => {
		const fixture = await createWorkspaceFixture();
		const invited = await createUser('invited');
		const token = `invite-${randomUUID()}`;
		const [invitation] = await db
			.insert(workspaceInvitation)
			.values({
				workspaceId: fixture.context.workspaceId,
				email: invited.email,
				role: 'viewer',
				tokenHash: sha256(token),
				invitedByUserId: fixture.context.userId,
				expiresAt: new Date(Date.now() + 60_000)
			})
			.returning({ id: workspaceInvitation.id });

		await expect(getPendingInvitation(token)).resolves.toMatchObject({
			id: invitation.id,
			email: invited.email,
			workspaceId: fixture.context.workspaceId
		});
		await expect(acceptInvitation(token, invited.id, invited.email)).resolves.toBe(
			fixture.context.workspaceId
		);
		await expect(getPendingInvitation(token)).resolves.toBeNull();
		await expect(acceptInvitation(token, invited.id, invited.email)).rejects.toMatchObject({
			status: 404
		});

		const [accepted] = await db
			.select({ status: workspaceInvitation.status })
			.from(workspaceInvitation)
			.where(eq(workspaceInvitation.id, invitation.id));
		expect(accepted.status).toBe('accepted');

		const membership = await db
			.select({ role: workspaceMember.role })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.workspaceId, fixture.context.workspaceId),
					eq(workspaceMember.userId, invited.id)
				)
			);
		expect(membership).toEqual([{ role: 'viewer' }]);

		const auditRows = await db
			.select({ id: auditEvent.id })
			.from(auditEvent)
			.where(
				and(
					eq(auditEvent.workspaceId, fixture.context.workspaceId),
					eq(auditEvent.action, 'workspace_invitation.accepted')
				)
			);
		expect(auditRows).toHaveLength(1);
	});

	it('rejects active-member invitations and never overwrites a legacy owner membership', async () => {
		const fixture = await createWorkspaceFixture();
		await expect(
			inviteMember(fixture.context, { email: fixture.owner.email, role: 'viewer' })
		).rejects.toMatchObject({ status: 409 });
		await db
			.update(workspaceMember)
			.set({ status: 'disabled' })
			.where(
				and(
					eq(workspaceMember.workspaceId, fixture.context.workspaceId),
					eq(workspaceMember.userId, fixture.owner.id)
				)
			);
		await expect(
			inviteMember(fixture.context, { email: fixture.owner.email, role: 'viewer' })
		).rejects.toMatchObject({ status: 409 });

		const token = `owner-invite-${randomUUID()}`;
		await db.insert(workspaceInvitation).values({
			workspaceId: fixture.context.workspaceId,
			email: fixture.owner.email,
			role: 'viewer',
			tokenHash: sha256(token),
			invitedByUserId: fixture.context.userId,
			expiresAt: new Date(Date.now() + 60_000)
		});
		await expect(
			acceptInvitation(token, fixture.owner.id, fixture.owner.email)
		).rejects.toMatchObject({ status: 409 });

		await expect(
			db
				.select({ role: workspaceMember.role, status: workspaceMember.status })
				.from(workspaceMember)
				.where(
					and(
						eq(workspaceMember.workspaceId, fixture.context.workspaceId),
						eq(workspaceMember.userId, fixture.owner.id)
					)
				)
		).resolves.toEqual([{ role: 'owner', status: 'disabled' }]);
		await expect(getPendingInvitation(token)).resolves.toMatchObject({ role: 'viewer' });
	});

	it('reactivates only a disabled non-owner membership once under concurrent acceptance', async () => {
		const fixture = await createWorkspaceFixture();
		const returningMember = await createUser('returning-member');
		await db.insert(workspaceMember).values({
			workspaceId: fixture.context.workspaceId,
			userId: returningMember.id,
			role: 'member',
			status: 'disabled'
		});
		const token = `returning-invite-${randomUUID()}`;
		await db.insert(workspaceInvitation).values({
			workspaceId: fixture.context.workspaceId,
			email: returningMember.email,
			role: 'viewer',
			tokenHash: sha256(token),
			invitedByUserId: fixture.context.userId,
			expiresAt: new Date(Date.now() + 60_000)
		});

		const results = await Promise.allSettled([
			acceptInvitation(token, returningMember.id, returningMember.email),
			acceptInvitation(token, returningMember.id, returningMember.email)
		]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
		await expect(
			db
				.select({ role: workspaceMember.role, status: workspaceMember.status })
				.from(workspaceMember)
				.where(
					and(
						eq(workspaceMember.workspaceId, fixture.context.workspaceId),
						eq(workspaceMember.userId, returningMember.id)
					)
				)
		).resolves.toEqual([{ role: 'viewer', status: 'active' }]);
		await expect(getPendingInvitation(token)).resolves.toBeNull();
	});

	it('rejects invitation acceptance when the authenticated email differs', async () => {
		const fixture = await createWorkspaceFixture();
		const invited = await createUser('invited');
		const token = `invite-${randomUUID()}`;
		await db.insert(workspaceInvitation).values({
			workspaceId: fixture.context.workspaceId,
			email: invited.email,
			role: 'viewer',
			tokenHash: sha256(token),
			invitedByUserId: fixture.context.userId,
			expiresAt: new Date(Date.now() + 60_000)
		});

		await expect(acceptInvitation(token, invited.id, 'other@example.com')).rejects.toMatchObject({
			status: 403
		});
	});

	it('keeps an existing pending invitation stable instead of silently rotating it', async () => {
		const previousDeliveryMode = process.env.EMAIL_DELIVERY;
		process.env.EMAIL_DELIVERY = 'log';
		const emailLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		const fixture = await createWorkspaceFixture();
		const email = `invite-${randomUUID()}@example.com`;

		try {
			const first = await inviteMember(fixture.context, { email, role: 'viewer' });
			const second = await inviteMember(fixture.context, { email, role: 'member' });

			expect(second.invitationId).toBe(first.invitationId);
			expect(second.url).toBe(first.url);
			expect(second.created).toBe(false);
			expect(emailLog).toHaveBeenCalledTimes(1);

			const invitations = await db
				.select({
					id: workspaceInvitation.id,
					role: workspaceInvitation.role,
					status: workspaceInvitation.status,
					tokenHash: workspaceInvitation.tokenHash,
					encryptedToken: workspaceInvitationDelivery.encryptedToken,
					deliveryStatus: workspaceInvitationDelivery.status,
					attemptCount: workspaceInvitationDelivery.attemptCount
				})
				.from(workspaceInvitation)
				.innerJoin(
					workspaceInvitationDelivery,
					eq(workspaceInvitationDelivery.invitationId, workspaceInvitation.id)
				)
				.where(
					and(
						eq(workspaceInvitation.workspaceId, fixture.context.workspaceId),
						eq(workspaceInvitation.email, email),
						eq(workspaceInvitation.status, 'pending')
					)
				);

			expect(invitations).toHaveLength(1);
			expect(invitations[0]).toMatchObject({
				id: first.invitationId,
				role: 'viewer',
				status: 'pending',
				deliveryStatus: 'sent',
				attemptCount: 1
			});
			expect(first.url).toBeTruthy();
			expect(invitations[0].tokenHash).toBe(
				sha256(new URL(first.url!).pathname.split('/').at(-1)!)
			);
			expect(invitations[0].encryptedToken).not.toContain(
				new URL(first.url!).pathname.split('/').at(-1)!
			);

			await db
				.update(workspaceInvitationDelivery)
				.set({ encryptedToken: 'v1.invalid.invalid.invalid' })
				.where(eq(workspaceInvitationDelivery.invitationId, first.invitationId));
			await expect(inviteMember(fixture.context, { email, role: 'admin' })).resolves.toMatchObject({
				invitationId: first.invitationId,
				created: false,
				url: null,
				deliveryStatus: 'unchanged'
			});
			expect(emailLog).toHaveBeenCalledTimes(1);
		} finally {
			if (previousDeliveryMode === undefined) {
				delete process.env.EMAIL_DELIVERY;
			} else {
				process.env.EMAIL_DELIVERY = previousDeliveryMode;
			}
			emailLog.mockRestore();
		}
	});

	it('retries an accepted timeout with the same invitation link and redacted error state', async () => {
		const previousDeliveryMode = process.env.EMAIL_DELIVERY;
		process.env.EMAIL_DELIVERY = 'log';
		const emailLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fixture = await createWorkspaceFixture();
		try {
			const invitation = await inviteMember(fixture.context, {
				email: `invite-timeout-${randomUUID()}@example.com`,
				role: 'viewer'
			});
			await db
				.update(workspaceInvitationDelivery)
				.set({ status: 'pending', attemptCount: 0, sentAt: null })
				.where(eq(workspaceInvitationDelivery.invitationId, invitation.invitationId));

			const observedUrls: string[] = [];
			const timeout = new Error('provider accepted request then timed out');
			timeout.name = 'TimeoutError';
			const uncertainSend = vi.fn(async (_to, _workspace, url: string) => {
				observedUrls.push(url);
				throw timeout;
			});
			await expect(
				deliverInvitation(invitation.invitationId, {
					send: uncertainSend,
					origin: 'https://app.example/'
				})
			).resolves.toMatchObject({ processed: 1, sent: 0, failed: 1 });
			const successfulRetry = vi.fn(async (_to, _workspace, url: string) => {
				observedUrls.push(url);
			});
			await expect(
				deliverInvitation(invitation.invitationId, {
					send: successfulRetry,
					origin: 'https://app.example/'
				})
			).resolves.toMatchObject({ processed: 1, sent: 1, failed: 0 });

			expect(observedUrls).toHaveLength(2);
			expect(observedUrls[1]).toBe(observedUrls[0]);
			expect(new URL(observedUrls[0]).origin).toBe('https://app.example');
			expect(new URL(observedUrls[0]).pathname).toBe(new URL(invitation.url!).pathname);
			const [delivery] = await db
				.select({
					status: workspaceInvitationDelivery.status,
					attemptCount: workspaceInvitationDelivery.attemptCount,
					lastErrorCategory: workspaceInvitationDelivery.lastErrorCategory
				})
				.from(workspaceInvitationDelivery)
				.where(eq(workspaceInvitationDelivery.invitationId, invitation.invitationId));
			expect(delivery).toEqual({ status: 'sent', attemptCount: 2, lastErrorCategory: null });
			expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('"errorCategory":"timeout"'));
			expect(errorLog).not.toHaveBeenCalledWith(expect.stringContaining(invitation.url!));
		} finally {
			if (previousDeliveryMode === undefined) delete process.env.EMAIL_DELIVERY;
			else process.env.EMAIL_DELIVERY = previousDeliveryMode;
			emailLog.mockRestore();
			errorLog.mockRestore();
		}
	});

	it('claims an invitation once across concurrent delivery attempts and honors the retry limit', async () => {
		const previousDeliveryMode = process.env.EMAIL_DELIVERY;
		process.env.EMAIL_DELIVERY = 'log';
		const emailLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		const fixture = await createWorkspaceFixture();
		try {
			const invitation = await inviteMember(fixture.context, {
				email: `invite-claim-${randomUUID()}@example.com`,
				role: 'member'
			});
			await db
				.update(workspaceInvitationDelivery)
				.set({ status: 'pending', attemptCount: 0, sentAt: null })
				.where(eq(workspaceInvitationDelivery.invitationId, invitation.invitationId));
			const send = vi.fn().mockResolvedValue(undefined);

			const results = await Promise.all([
				deliverInvitation(invitation.invitationId, { send }),
				deliverInvitation(invitation.invitationId, { send })
			]);
			expect(results.reduce((total, result) => total + result.processed, 0)).toBe(1);
			expect(send).toHaveBeenCalledOnce();

			await db
				.update(workspaceInvitationDelivery)
				.set({ status: 'failed', attemptCount: invitationDeliveryMaxAttempts, sentAt: null })
				.where(eq(workspaceInvitationDelivery.invitationId, invitation.invitationId));
			await expect(deliverInvitation(invitation.invitationId, { send })).resolves.toMatchObject({
				processed: 0,
				sent: 0,
				failed: 0
			});
			expect(send).toHaveBeenCalledOnce();
		} finally {
			if (previousDeliveryMode === undefined) delete process.env.EMAIL_DELIVERY;
			else process.env.EMAIL_DELIVERY = previousDeliveryMode;
			emailLog.mockRestore();
		}
	});

	it('records authenticated-decryption failure without calling the email provider', async () => {
		const previousDeliveryMode = process.env.EMAIL_DELIVERY;
		process.env.EMAIL_DELIVERY = 'log';
		const emailLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fixture = await createWorkspaceFixture();
		try {
			const invitation = await inviteMember(fixture.context, {
				email: `invite-corrupt-${randomUUID()}@example.com`,
				role: 'viewer'
			});
			await db
				.update(workspaceInvitationDelivery)
				.set({ encryptedToken: 'v1.invalid.invalid.invalid', status: 'pending' })
				.where(eq(workspaceInvitationDelivery.invitationId, invitation.invitationId));
			const send = vi.fn().mockResolvedValue(undefined);

			await expect(deliverInvitation(invitation.invitationId, { send })).resolves.toMatchObject({
				processed: 1,
				sent: 0,
				failed: 1
			});
			expect(send).not.toHaveBeenCalled();
			const [delivery] = await db
				.select({ lastErrorCategory: workspaceInvitationDelivery.lastErrorCategory })
				.from(workspaceInvitationDelivery)
				.where(eq(workspaceInvitationDelivery.invitationId, invitation.invitationId));
			expect(delivery.lastErrorCategory).toBe('encryption');
		} finally {
			if (previousDeliveryMode === undefined) delete process.env.EMAIL_DELIVERY;
			else process.env.EMAIL_DELIVERY = previousDeliveryMode;
			emailLog.mockRestore();
			errorLog.mockRestore();
		}
	});

	it('runs a bounded invitation scheduler cycle while holding its advisory lock', async () => {
		const previousDeliveryMode = process.env.EMAIL_DELIVERY;
		process.env.EMAIL_DELIVERY = 'log';
		const emailLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		const fixture = await createWorkspaceFixture();
		try {
			const invitation = await inviteMember(fixture.context, {
				email: `invite-cycle-${randomUUID()}@example.com`,
				role: 'viewer'
			});
			await db
				.update(workspaceInvitationDelivery)
				.set({ status: 'pending', attemptCount: 0, sentAt: null })
				.where(eq(workspaceInvitationDelivery.invitationId, invitation.invitationId));
			const send = vi.fn().mockResolvedValue(undefined);

			await expect(runInvitationDeliveryScheduler({ send })).resolves.toEqual({
				processed: 1,
				sent: 1,
				failed: 0
			});
			expect(send).toHaveBeenCalledOnce();
		} finally {
			if (previousDeliveryMode === undefined) delete process.env.EMAIL_DELIVERY;
			else process.env.EMAIL_DELIVERY = previousDeliveryMode;
			emailLog.mockRestore();
		}
	});

	it('holds one advisory-locked invitation retry cycle across application instances', async () => {
		const reserved = await client.reserve();
		try {
			await reserved`SELECT pg_advisory_lock(${invitationDeliverySchedulerLockKey})`;
			await expect(runInvitationDeliveryScheduler()).resolves.toEqual({
				processed: 0,
				sent: 0,
				failed: 0,
				skipped: true
			});
		} finally {
			await reserved`SELECT pg_advisory_unlock(${invitationDeliverySchedulerLockKey})`;
			reserved.release();
		}
	});

	it('rotates only an explicitly resent invitation and records the audit event', async () => {
		const previousDeliveryMode = process.env.EMAIL_DELIVERY;
		process.env.EMAIL_DELIVERY = 'log';
		const emailLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		const fixture = await createWorkspaceFixture();
		try {
			const first = await inviteMember(fixture.context, {
				email: `invite-resend-${randomUUID()}@example.com`,
				role: 'admin'
			});
			await expect(
				resendInvitation({ ...fixture.context, role: 'viewer' }, first.invitationId)
			).rejects.toMatchObject({ status: 403 });
			await expect(resendInvitation(fixture.context, 2_147_483_647)).rejects.toMatchObject({
				status: 404
			});
			const resent = await resendInvitation(fixture.context, first.invitationId);
			const firstToken = new URL(first.url!).pathname.split('/').at(-1)!;
			const resentToken = new URL(resent.url).pathname.split('/').at(-1)!;

			expect(resent.url).not.toBe(first.url);
			await expect(getPendingInvitation(firstToken)).resolves.toBeNull();
			await expect(getPendingInvitation(resentToken)).resolves.toMatchObject({
				email: expect.stringContaining('invite-resend-'),
				role: 'admin'
			});
			const [audit] = await db
				.select({ action: auditEvent.action, entityId: auditEvent.entityId })
				.from(auditEvent)
				.where(
					and(
						eq(auditEvent.workspaceId, fixture.context.workspaceId),
						eq(auditEvent.action, 'workspace_invitation.resent')
					)
				);
			expect(audit).toEqual({
				action: 'workspace_invitation.resent',
				entityId: String(first.invitationId)
			});
		} finally {
			if (previousDeliveryMode === undefined) delete process.env.EMAIL_DELIVERY;
			else process.env.EMAIL_DELIVERY = previousDeliveryMode;
			emailLog.mockRestore();
		}
	});
}
