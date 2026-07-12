import type { ServiceIntegrationTestContext } from '../services.integration.test';

export function registerVerificationTests(context: ServiceIntegrationTestContext) {
	const {
		randomUUID,
		expect,
		it,
		vi,
		eq,
		emailVerificationThrottle,
		workspace,
		client,
		db,
		pruneExpiredUnverifiedRegistrations,
		requestVerificationEmail,
		workspaceIds,
		createUser,
		findUserById,
		findWorkspaceById
	} = context;

	it('throttles verification email resends for unverified accounts', async () => {
		const unverifiedUser = await createUser('verify-cooldown', { emailVerified: false });
		const send = vi.fn().mockResolvedValue(undefined);
		const now = new Date('2026-06-01T12:00:00.000Z');

		await expect(
			requestVerificationEmail({ email: unverifiedUser.email, send, now })
		).resolves.toMatchObject({ status: 'sent', sentCount: 1 });
		await expect(
			requestVerificationEmail({
				email: unverifiedUser.email,
				send,
				now: new Date(now.getTime() + 60_000)
			})
		).resolves.toMatchObject({
			status: 'cooldown',
			retryAt: new Date('2026-06-01T12:02:00.000Z')
		});
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('caps verification emails at five attempts and expires stale unverified accounts', async () => {
		const unverifiedUser = await createUser('verify-limit', { emailVerified: false });
		const send = vi.fn().mockResolvedValue(undefined);
		const now = new Date('2026-06-01T12:00:00.000Z');

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await expect(
				requestVerificationEmail({
					email: unverifiedUser.email,
					send,
					now: new Date(now.getTime() + attempt * 121_000)
				})
			).resolves.toMatchObject({ status: 'sent', sentCount: attempt + 1 });
		}

		const [throttle] = await db
			.select()
			.from(emailVerificationThrottle)
			.where(eq(emailVerificationThrottle.userId, unverifiedUser.id));
		expect(throttle).toMatchObject({
			sentCount: 5,
			limitReachedAt: new Date('2026-06-01T12:08:04.000Z'),
			deleteAfter: new Date('2026-06-01T13:08:04.000Z')
		});

		await expect(
			requestVerificationEmail({
				email: unverifiedUser.email,
				send,
				now: new Date('2026-06-01T12:11:00.000Z')
			})
		).resolves.toMatchObject({
			status: 'limit',
			deleteAfter: new Date('2026-06-01T13:08:04.000Z')
		});
		expect(send).toHaveBeenCalledTimes(5);

		await expect(
			pruneExpiredUnverifiedRegistrations(new Date('2026-06-01T13:08:05.000Z'))
		).resolves.toEqual({ deletedUsers: 1 });
		await expect(findUserById(unverifiedUser.id)).resolves.toBeNull();
	});

	it('removes workspaces owned by expired unverified users', async () => {
		const unverifiedUser = await createUser('verify-expired-workspace', { emailVerified: false });
		const [workspaceRow] = await db
			.insert(workspace)
			.values({
				name: `Expired ${randomUUID()}`,
				createdByUserId: unverifiedUser.id,
				currency: 'USD'
			})
			.returning({ id: workspace.id });
		workspaceIds.push(workspaceRow.id);
		await db.insert(emailVerificationThrottle).values({
			userId: unverifiedUser.id,
			email: unverifiedUser.email,
			sentCount: 5,
			lastSentAt: new Date('2026-06-01T12:00:00.000Z'),
			limitReachedAt: new Date('2026-06-01T12:00:00.000Z'),
			deleteAfter: new Date('2026-06-01T13:00:00.000Z')
		});

		await expect(
			pruneExpiredUnverifiedRegistrations(new Date('2026-06-01T13:00:01.000Z'))
		).resolves.toEqual({ deletedUsers: 1 });
		await expect(findWorkspaceById(workspaceRow.id)).resolves.toBeNull();
		await expect(findUserById(unverifiedUser.id)).resolves.toBeNull();
	});

	it('skips verification cleanup while another instance owns the advisory lock', async () => {
		const reserved = await client.reserve();
		try {
			await reserved`
				SELECT pg_advisory_lock(
					hashtextextended('expense-manager:email-verification-cleanup:v1', 0)
				)
			`;
			await expect(pruneExpiredUnverifiedRegistrations()).resolves.toEqual({
				deletedUsers: 0,
				skipped: true
			});
		} finally {
			await reserved`
				SELECT pg_advisory_unlock(
					hashtextextended('expense-manager:email-verification-cleanup:v1', 0)
				)
			`;
			reserved.release();
		}
	});
}
