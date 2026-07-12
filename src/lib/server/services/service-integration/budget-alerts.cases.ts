import type { ServiceIntegrationTestContext } from '../services.integration.test';
import type { sendBudgetAlertEmail } from '$lib/server/email';

export function registerBudgetAlertTests(context: ServiceIntegrationTestContext) {
	const {
		randomUUID,
		expect,
		it,
		vi,
		and,
		eq,
		inArray,
		user,
		auditEvent,
		budgetAlertDelivery,
		budgetAlertPreference,
		budgetAlertRecipient,
		category,
		categoryBudget,
		emailDeliveryEvent,
		expense,
		workspaceMember,
		client,
		db,
		formatCents,
		deleteBudget,
		getBudgetAlertPreference,
		getBudgetSummary,
		listBudgetAlertDeliveryHistory,
		listBudgetAlertEligibleRecipients,
		listBudgetStatus,
		retryBudgetAlertDelivery,
		runAutomaticBudgetAlertScheduler,
		sendBudgetAlerts,
		setBudgetAlertPreference,
		upsertBudget,
		createExpense,
		parseMailjetWebhookPayload,
		pruneEmailDeliveryEvents,
		recordMailjetDeliveryEvents,
		createWorkspaceFixture,
		createMemberContext,
		seedWarningBudget,
		createUser
	} = context;

	it('sends budget alerts from approved spending only', async () => {
		const previousDeliveryMode = process.env.EMAIL_DELIVERY;
		process.env.EMAIL_DELIVERY = 'log';
		const emailLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');

		try {
			const [unsetCategory] = await db
				.insert(category)
				.values({
					workspaceId: fixture.context.workspaceId,
					name: 'Sem meta',
					color: '#64748b',
					icon: '🧾'
				})
				.returning({ id: category.id });
			expect(unsetCategory.id).toBeGreaterThan(0);
			await expect(
				upsertBudget(memberContext, {
					categoryId: fixture.categoryId,
					periodMonth: '2026-06',
					amount: '100,00',
					warningThresholdPct: 80
				})
			).rejects.toMatchObject({ status: 403 });
			await expect(deleteBudget(memberContext, 1)).rejects.toMatchObject({ status: 403 });
			await expect(sendBudgetAlerts(memberContext, '2026-06')).rejects.toMatchObject({
				status: 403
			});
			await expect(
				upsertBudget(
					{ ...fixture.context, locale: 'pt-BR' },
					{
						categoryId: fixture.categoryId + 999_999,
						periodMonth: '2026-06',
						amount: '100,00',
						warningThresholdPct: 80
					}
				)
			).rejects.toMatchObject({
				status: 400,
				body: { message: 'Categoria inválida.' }
			});

			await upsertBudget(fixture.context, {
				categoryId: fixture.categoryId,
				periodMonth: '2026-06',
				amount: '100,00',
				warningThresholdPct: 80
			});
			const [budgetRow] = await db
				.select({ id: categoryBudget.id, periodMonth: categoryBudget.periodMonth })
				.from(categoryBudget)
				.where(eq(categoryBudget.workspaceId, fixture.context.workspaceId));
			expect(budgetRow.periodMonth).toBe('2026-06-01');
			await expect(sendBudgetAlerts(fixture.context, '2026-06')).resolves.toEqual(
				expect.objectContaining({ sentCount: 0, alertCount: 0 })
			);
			let budgetStatuses = await listBudgetStatus(fixture.context, '2026-06');
			expect(budgetStatuses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ categoryId: fixture.categoryId, status: 'ok', usagePct: 0 }),
					expect.objectContaining({ categoryId: unsetCategory.id, status: 'unset', usagePct: null })
				])
			);

			await createExpense(fixture.context, {
				categoryId: fixture.categoryId,
				description: 'Gasto aprovado',
				amount: '90,00',
				expenseDate: '2026-06-15'
			});
			await createExpense(memberContext, {
				categoryId: fixture.categoryId,
				description: 'Gasto pendente',
				amount: '1.000,00',
				expenseDate: '2026-06-16'
			});
			budgetStatuses = await listBudgetStatus(fixture.context, '2026-06');
			expect(budgetStatuses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						categoryId: fixture.categoryId,
						status: 'warning',
						usagePct: 90
					})
				])
			);

			const result = await sendBudgetAlerts(fixture.context, '2026-06');

			expect(result).toEqual(expect.objectContaining({ sentCount: 1, alertCount: 1 }));
			expect(emailLog).toHaveBeenCalledWith(
				'[email:dev]',
				expect.objectContaining({
					to: expect.stringContaining('@example.com'),
					text: expect.stringContaining(`${formatCents(9000)} of ${formatCents(10000)}`)
				})
			);
			expect(emailLog).not.toHaveBeenCalledWith(
				'[email:dev]',
				expect.objectContaining({
					text: expect.stringContaining(formatCents(109000))
				})
			);

			await createExpense(fixture.context, {
				categoryId: fixture.categoryId,
				description: 'Gasto acima',
				amount: '20,00',
				expenseDate: '2026-06-17'
			});
			budgetStatuses = await listBudgetStatus(fixture.context, '2026-06');
			expect(budgetStatuses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ categoryId: fixture.categoryId, status: 'over', usagePct: 110 })
				])
			);
			await expect(getBudgetSummary(fixture.context, '2026-06')).resolves.toMatchObject({
				totalBudgetCents: 10_000,
				spentCents: 11_000,
				remainingCents: -1_000,
				usagePct: 110,
				overBudgetCount: 1,
				warningCount: 0
			});

			await deleteBudget(fixture.context, budgetRow.id);
			await expect(deleteBudget(fixture.context, budgetRow.id)).rejects.toMatchObject({
				status: 404
			});
			const remainingBudgets = await db
				.select({ id: categoryBudget.id })
				.from(categoryBudget)
				.where(eq(categoryBudget.workspaceId, fixture.context.workspaceId));
			expect(remainingBudgets).toEqual([]);
		} finally {
			if (previousDeliveryMode === undefined) {
				delete process.env.EMAIL_DELIVERY;
			} else {
				process.env.EMAIL_DELIVERY = previousDeliveryMode;
			}
			emailLog.mockRestore();
		}
	});

	it('retries only failed budget-alert recipients after partial provider failure', async () => {
		const fixture = await createWorkspaceFixture();
		const adminContext = await createMemberContext(fixture, 'admin');
		await seedWarningBudget(fixture);
		const [owner, admin] = await Promise.all([
			db.select({ email: user.email }).from(user).where(eq(user.id, fixture.context.userId)),
			db.select({ email: user.email }).from(user).where(eq(user.id, adminContext.userId))
		]);
		const ownerEmail = owner[0].email;
		const adminEmail = admin[0].email;
		const providerError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const firstSend = vi.fn(async (to: string) => {
			if (to === adminEmail) throw new Error('temporary provider failure');
		});

		try {
			await expect(
				sendBudgetAlerts(fixture.context, '2026-06', { send: firstSend })
			).resolves.toMatchObject({ sentCount: 1, failedCount: 1, alreadySent: false });
			expect(firstSend).toHaveBeenCalledTimes(2);

			const retrySend = vi.fn(async () => {});
			await expect(
				sendBudgetAlerts(fixture.context, '2026-06', { send: retrySend })
			).resolves.toMatchObject({ sentCount: 1, failedCount: 0, alreadySent: false });
			expect(retrySend).toHaveBeenCalledTimes(1);
			expect(retrySend).toHaveBeenCalledWith(
				adminEmail,
				expect.any(String),
				'2026-06-01',
				expect.any(Array),
				'en',
				expect.stringMatching(
					/^budget-alert:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
				)
			);
			expect(retrySend).not.toHaveBeenCalledWith(
				ownerEmail,
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything()
			);

			const deliveries = await db
				.select({
					recipientEmail: budgetAlertDelivery.recipientEmail,
					status: budgetAlertDelivery.status,
					attemptCount: budgetAlertDelivery.attemptCount
				})
				.from(budgetAlertDelivery)
				.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));
			expect(deliveries).toEqual(
				expect.arrayContaining([
					{ recipientEmail: ownerEmail, status: 'sent', attemptCount: 1 },
					{ recipientEmail: adminEmail, status: 'sent', attemptCount: 2 }
				])
			);

			const completionEvents = await db
				.select({ id: auditEvent.id })
				.from(auditEvent)
				.where(
					and(
						eq(auditEvent.workspaceId, fixture.context.workspaceId),
						eq(auditEvent.action, 'budget.alerts_sent')
					)
				);
			expect(completionEvents).toHaveLength(1);
		} finally {
			providerError.mockRestore();
		}
	});

	it('reconciles replay-safe Mailjet feedback to the exact budget-alert delivery', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		const [owner] = await db
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, fixture.context.userId));
		let customId = '';
		const send = vi.fn(async (...args: Parameters<typeof sendBudgetAlertEmail>) => {
			customId = String(args[5]);
			return {
				provider: 'mailjet' as const,
				messageId: '19421777835146490',
				messageUuid: '1ab23cd4-e567-8901-2345-6789f0gh1i2j'
			};
		});

		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 1,
			failedCount: 0
		});
		expect(customId).toMatch(/^budget-alert:[0-9a-f-]{36}$/);
		await db
			.update(budgetAlertDelivery)
			.set({ status: 'failed', sentAt: null })
			.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));

		const eventPayload = {
			event: 'sent',
			time: 1_771_588_800,
			email: owner.email,
			CustomID: customId,
			mj_message_id: '19421777835146490',
			Message_GUID: '1ab23cd4-e567-8901-2345-6789f0gh1i2j'
		};
		const parsed = parseMailjetWebhookPayload(eventPayload, new Date('2026-02-20T12:05:00.000Z'));
		await expect(recordMailjetDeliveryEvents(parsed)).resolves.toEqual({
			accepted: 1,
			duplicates: 0,
			matched: 1
		});
		await expect(recordMailjetDeliveryEvents(parsed)).resolves.toEqual({
			accepted: 0,
			duplicates: 1,
			matched: 0
		});
		const olderMatched = parseMailjetWebhookPayload(
			[
				{
					event: 'bounce',
					time: 1_771_585_200,
					email: owner.email,
					CustomID: customId
				},
				{
					event: 'open',
					time: 1_771_585_260,
					email: owner.email,
					CustomID: customId
				},
				{
					event: 'click',
					time: 1_771_585_320,
					email: owner.email,
					CustomID: customId
				}
			],
			new Date('2026-02-20T12:05:00.000Z')
		);
		await expect(recordMailjetDeliveryEvents(olderMatched)).resolves.toEqual({
			accepted: 3,
			duplicates: 0,
			matched: 3
		});
		const wrongRecipient = parseMailjetWebhookPayload(
			{
				event: 'blocked',
				time: 1_771_585_380,
				email: `other-${owner.email}`,
				CustomID: customId
			},
			new Date('2026-02-20T12:05:00.000Z')
		);
		await expect(recordMailjetDeliveryEvents(wrongRecipient)).resolves.toEqual({
			accepted: 1,
			duplicates: 0,
			matched: 0
		});
		const providerOnly = parseMailjetWebhookPayload(
			{
				event: 'unsub',
				time: 1_771_585_440,
				email: owner.email
			},
			new Date('2026-02-20T12:05:00.000Z')
		);
		await expect(recordMailjetDeliveryEvents(providerOnly)).resolves.toEqual({
			accepted: 1,
			duplicates: 0,
			matched: 0
		});

		const [delivery] = await db
			.select({
				id: budgetAlertDelivery.id,
				status: budgetAlertDelivery.status,
				sentAt: budgetAlertDelivery.sentAt,
				provider: budgetAlertDelivery.provider,
				providerMessageId: budgetAlertDelivery.providerMessageId,
				providerMessageUuid: budgetAlertDelivery.providerMessageUuid,
				lastProviderEvent: budgetAlertDelivery.lastProviderEvent,
				lastProviderEventAt: budgetAlertDelivery.lastProviderEventAt
			})
			.from(budgetAlertDelivery)
			.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));
		expect(delivery).toEqual({
			id: expect.any(Number),
			status: 'sent',
			sentAt: new Date('2026-02-20T12:00:00.000Z'),
			provider: 'mailjet',
			providerMessageId: '19421777835146490',
			providerMessageUuid: '1ab23cd4-e567-8901-2345-6789f0gh1i2j',
			lastProviderEvent: 'sent',
			lastProviderEventAt: new Date('2026-02-20T12:00:00.000Z')
		});
		await expect(
			db
				.select({ eventType: emailDeliveryEvent.eventType })
				.from(emailDeliveryEvent)
				.where(eq(emailDeliveryEvent.budgetAlertDeliveryId, delivery.id))
		).resolves.toHaveLength(4);
		const fingerprints = [...parsed, ...olderMatched, ...wrongRecipient, ...providerOnly].map(
			(event) => event.fingerprint
		);
		await db
			.update(emailDeliveryEvent)
			.set({ receivedAt: new Date('2026-01-01T00:00:00.000Z') })
			.where(inArray(emailDeliveryEvent.fingerprint, fingerprints));
		await expect(pruneEmailDeliveryEvents(new Date('2026-04-02T00:00:00.000Z'))).resolves.toEqual({
			deletedEvents: 6
		});
	});

	it('skips email event retention while another instance owns its advisory lock', async () => {
		const reserved = await client.reserve();
		try {
			await reserved`
				SELECT pg_advisory_lock(
					hashtextextended('expense-manager:email-delivery-event-cleanup:v1', 0)
				)
			`;
			await expect(pruneEmailDeliveryEvents()).resolves.toEqual({
				deletedEvents: 0,
				skipped: true
			});
		} finally {
			await reserved`
				SELECT pg_advisory_unlock(
					hashtextextended('expense-manager:email-delivery-event-cleanup:v1', 0)
				)
			`;
			reserved.release();
		}
	});

	it('runs automatic budget alerts only for opted-in workspaces', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');
		await seedWarningBudget(fixture);
		await expect(getBudgetAlertPreference(fixture.context)).resolves.toEqual({
			isEnabled: false,
			recipientMode: 'all_managers',
			escalateOverBudget: false,
			recipientUserIds: [],
			locale: 'en'
		});
		await expect(setBudgetAlertPreference(memberContext, true)).rejects.toMatchObject({
			status: 403
		});

		await setBudgetAlertPreference({ ...fixture.context, locale: 'pt-BR' }, true);
		await expect(getBudgetAlertPreference(fixture.context)).resolves.toEqual({
			isEnabled: true,
			recipientMode: 'all_managers',
			escalateOverBudget: false,
			recipientUserIds: [],
			locale: 'pt-BR'
		});
		const [storedPreference] = await db
			.select({
				isEnabled: budgetAlertPreference.isEnabled,
				locale: budgetAlertPreference.locale,
				updatedByUserId: budgetAlertPreference.updatedByUserId
			})
			.from(budgetAlertPreference)
			.where(eq(budgetAlertPreference.workspaceId, fixture.context.workspaceId));
		expect(storedPreference).toEqual({
			isEnabled: true,
			locale: 'pt-BR',
			updatedByUserId: fixture.context.userId
		});

		const send = vi.fn(async () => {});
		const schedulerLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		try {
			const firstCycle = await runAutomaticBudgetAlertScheduler({
				now: new Date('2026-06-20T12:00:00.000Z'),
				send
			});
			expect(firstCycle).toMatchObject({ sent: 1, failed: 0, errors: 0 });
			expect(firstCycle.processed).toBeGreaterThanOrEqual(1);
			expect(send).toHaveBeenCalledWith(
				expect.stringContaining('@example.com'),
				fixture.context.workspaceName,
				'2026-06-01',
				expect.any(Array),
				'pt-BR',
				expect.stringMatching(/^budget-alert:[0-9a-f-]{36}$/)
			);

			const secondCycle = await runAutomaticBudgetAlertScheduler({
				now: new Date('2026-06-20T13:00:00.000Z'),
				send
			});
			expect(secondCycle).toMatchObject({ sent: 0, failed: 0, errors: 0 });
			expect(secondCycle.processed).toBeGreaterThanOrEqual(1);
			expect(send).toHaveBeenCalledTimes(1);

			await setBudgetAlertPreference(fixture.context, false);
			await expect(
				runAutomaticBudgetAlertScheduler({
					now: new Date('2026-07-20T12:00:00.000Z'),
					send
				})
			).resolves.toMatchObject({ sent: 0, failed: 0, errors: 0 });
		} finally {
			schedulerLog.mockRestore();
		}
	});

	it('atomically stores only verified manager recipients and lets stale selections be disabled', async () => {
		const fixture = await createWorkspaceFixture();
		const admin = await createMemberContext(fixture, 'admin');
		const member = await createMemberContext(fixture, 'member');
		const unverified = await createUser('unverified-admin', { emailVerified: false });
		await db.insert(workspaceMember).values({
			workspaceId: fixture.context.workspaceId,
			userId: unverified.id,
			role: 'admin',
			status: 'active'
		});

		await expect(listBudgetAlertEligibleRecipients(fixture.context)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ userId: fixture.context.userId, isSelected: false }),
				expect.objectContaining({ userId: admin.userId, isSelected: false })
			])
		);
		const eligible = await listBudgetAlertEligibleRecipients(fixture.context);
		expect(eligible.map((recipient) => recipient.userId)).not.toContain(member.userId);
		expect(eligible.map((recipient) => recipient.userId)).not.toContain(unverified.id);

		await setBudgetAlertPreference(fixture.context, {
			isEnabled: true,
			recipientMode: 'selected',
			escalateOverBudget: true,
			recipientUserIds: [admin.userId]
		});
		await expect(getBudgetAlertPreference(fixture.context)).resolves.toMatchObject({
			isEnabled: true,
			recipientMode: 'selected',
			escalateOverBudget: true,
			recipientUserIds: [admin.userId]
		});
		await expect(getBudgetAlertPreference(member)).resolves.toMatchObject({
			recipientMode: 'selected',
			recipientUserIds: []
		});
		await expect(
			setBudgetAlertPreference(
				{ ...fixture.context, userId: `missing-${randomUUID()}` },
				{
					isEnabled: false,
					recipientMode: 'selected',
					escalateOverBudget: false,
					recipientUserIds: [fixture.context.userId]
				}
			)
		).rejects.toBeDefined();
		await expect(getBudgetAlertPreference(fixture.context)).resolves.toMatchObject({
			isEnabled: true,
			recipientMode: 'selected',
			escalateOverBudget: true,
			recipientUserIds: [admin.userId]
		});
		await expect(
			setBudgetAlertPreference(fixture.context, {
				isEnabled: true,
				recipientMode: 'selected',
				escalateOverBudget: false,
				recipientUserIds: [member.userId]
			})
		).rejects.toMatchObject({ status: 400 });
		await expect(
			setBudgetAlertPreference(fixture.context, {
				isEnabled: true,
				recipientMode: 'all_managers',
				escalateOverBudget: false,
				recipientUserIds: [member.userId]
			})
		).resolves.toMatchObject({ recipientMode: 'all_managers', recipientUserIds: [] });
		await setBudgetAlertPreference(fixture.context, {
			isEnabled: true,
			recipientMode: 'selected',
			escalateOverBudget: true,
			recipientUserIds: [admin.userId]
		});

		await db
			.update(workspaceMember)
			.set({ role: 'member' })
			.where(
				and(
					eq(workspaceMember.workspaceId, fixture.context.workspaceId),
					eq(workspaceMember.userId, admin.userId)
				)
			);
		await expect(setBudgetAlertPreference(fixture.context, false)).resolves.toMatchObject({
			isEnabled: false,
			recipientUserIds: []
		});
		await expect(
			db
				.select({ userId: budgetAlertRecipient.userId })
				.from(budgetAlertRecipient)
				.where(eq(budgetAlertRecipient.workspaceId, fixture.context.workspaceId))
		).resolves.toEqual([]);
		await expect(setBudgetAlertPreference(fixture.context, true)).rejects.toMatchObject({
			status: 400
		});
	});

	it('sends one initial transition and only the configured warning-to-over escalation', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		const send = vi.fn(async () => {});
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 1
		});
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 0,
			alreadySent: true
		});
		const [warningExpense] = await db
			.select({ id: expense.id })
			.from(expense)
			.where(eq(expense.workspaceId, fixture.context.workspaceId))
			.limit(1);
		await db.update(expense).set({ amountCents: 1_000 }).where(eq(expense.id, warningExpense.id));
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 0,
			alertCount: 0
		});
		await db.update(expense).set({ amountCents: 9_000 }).where(eq(expense.id, warningExpense.id));
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 0,
			alreadySent: true
		});

		await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Over budget transition',
			amount: '20.00',
			expenseDate: '2026-06-16'
		});
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 0,
			alreadySent: true
		});
		await setBudgetAlertPreference(fixture.context, {
			isEnabled: true,
			recipientMode: 'all_managers',
			escalateOverBudget: true,
			recipientUserIds: []
		});
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 1
		});
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 0,
			alreadySent: true
		});

		const transitions = await db
			.select({ level: budgetAlertDelivery.level, stage: budgetAlertDelivery.stage })
			.from(budgetAlertDelivery)
			.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));
		expect(transitions).toEqual(
			expect.arrayContaining([
				{ level: 'warning', stage: 'initial' },
				{ level: 'over', stage: 'escalation' }
			])
		);
		expect(transitions).toHaveLength(2);

		const directOver = await createWorkspaceFixture();
		await upsertBudget(directOver.context, {
			categoryId: directOver.categoryId,
			periodMonth: '2026-06',
			amount: '100.00',
			warningThresholdPct: 80
		});
		await createExpense(directOver.context, {
			categoryId: directOver.categoryId,
			description: 'Direct over budget',
			amount: '110.00',
			expenseDate: '2026-06-16'
		});
		await sendBudgetAlerts(directOver.context, '2026-06', { send });
		await expect(
			db
				.select({ level: budgetAlertDelivery.level, stage: budgetAlertDelivery.stage })
				.from(budgetAlertDelivery)
				.where(eq(budgetAlertDelivery.workspaceId, directOver.context.workspaceId))
		).resolves.toEqual([{ level: 'over', stage: 'initial' }]);
	});

	it('keeps legacy delivery months closed without inferring category transitions', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		await db.insert(budgetAlertDelivery).values({
			workspaceId: fixture.context.workspaceId,
			periodMonth: '2026-06-01',
			recipientEmail: 'legacy-budget-alert@example.invalid',
			status: 'sent'
		});
		const send = vi.fn(async () => {});
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toEqual({
			sentCount: 0,
			failedCount: 0,
			alertCount: 0,
			alreadySent: true,
			inProgress: false
		});
		expect(send).not.toHaveBeenCalled();
	});

	it('retries only failed legacy recipients with the original combined digest and ledger', async () => {
		const fixture = await createWorkspaceFixture();
		const admin = await createMemberContext(fixture, 'admin');
		await seedWarningBudget(fixture);
		const [secondCategory] = await db
			.insert(category)
			.values({
				workspaceId: fixture.context.workspaceId,
				name: 'Travel',
				color: '#2563eb',
				icon: '✈️'
			})
			.returning({ id: category.id });
		await upsertBudget(fixture.context, {
			categoryId: secondCategory.id,
			periodMonth: '2026-06',
			amount: '200.00',
			warningThresholdPct: 75
		});
		await createExpense(fixture.context, {
			categoryId: secondCategory.id,
			description: 'Legacy combined alert',
			amount: '160.00',
			expenseDate: '2026-06-16'
		});
		const managers = await db
			.select({ id: user.id, email: user.email })
			.from(user)
			.where(inArray(user.id, [fixture.context.userId, admin.userId]));
		const emailById = new Map(managers.map((manager) => [manager.id, manager.email]));
		const [sentLegacy, failedLegacy] = await db
			.insert(budgetAlertDelivery)
			.values([
				{
					workspaceId: fixture.context.workspaceId,
					periodMonth: '2026-06-01',
					recipientEmail: emailById.get(fixture.context.userId)!,
					status: 'sent',
					attemptCount: 1,
					sentAt: new Date('2026-06-20T12:00:00.000Z')
				},
				{
					workspaceId: fixture.context.workspaceId,
					periodMonth: '2026-06-01',
					recipientEmail: emailById.get(admin.userId)!,
					status: 'failed',
					attemptCount: 1
				}
			])
			.returning({
				id: budgetAlertDelivery.id,
				providerReference: budgetAlertDelivery.providerReference
			});
		const send = vi.fn(async () => ({
			provider: 'mailjet' as const,
			messageId: 'legacy-message-id',
			messageUuid: 'legacy-message-uuid'
		}));

		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 1,
			failedCount: 0,
			alertCount: 2,
			alreadySent: false
		});
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(
			emailById.get(admin.userId),
			fixture.context.workspaceName,
			'2026-06-01',
			expect.arrayContaining([
				expect.objectContaining({ categoryName: 'Limpeza', status: 'warning' }),
				expect.objectContaining({ categoryName: 'Travel', status: 'warning' })
			]),
			'en',
			`budget-alert:${failedLegacy.providerReference}`
		);
		const rows = await db
			.select({
				id: budgetAlertDelivery.id,
				status: budgetAlertDelivery.status,
				attemptCount: budgetAlertDelivery.attemptCount,
				providerReference: budgetAlertDelivery.providerReference,
				provider: budgetAlertDelivery.provider,
				providerMessageId: budgetAlertDelivery.providerMessageId,
				providerMessageUuid: budgetAlertDelivery.providerMessageUuid,
				recipientUserId: budgetAlertDelivery.recipientUserId,
				categoryId: budgetAlertDelivery.categoryId,
				level: budgetAlertDelivery.level,
				stage: budgetAlertDelivery.stage
			})
			.from(budgetAlertDelivery)
			.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));
		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: sentLegacy.id,
					status: 'sent',
					attemptCount: 1,
					providerReference: sentLegacy.providerReference
				}),
				expect.objectContaining({
					id: failedLegacy.id,
					status: 'sent',
					attemptCount: 2,
					providerReference: failedLegacy.providerReference,
					provider: 'mailjet',
					providerMessageId: 'legacy-message-id',
					providerMessageUuid: 'legacy-message-uuid'
				})
			])
		);
		expect(rows).toHaveLength(2);
		expect(
			rows.every((row) => !row.recipientUserId && !row.categoryId && !row.level && !row.stage)
		).toBe(true);
		const history = await listBudgetAlertDeliveryHistory(fixture.context);
		expect(history.items).toHaveLength(2);
		for (const item of history.items) {
			expect(item).not.toHaveProperty('providerReference');
			expect(item).not.toHaveProperty('providerMessageId');
			expect(item).not.toHaveProperty('providerMessageUuid');
			expect(item.retryable).toBe(false);
		}
	});

	it('does not claim a legacy retry when there is no current alert summary', async () => {
		const fixture = await createWorkspaceFixture();
		const [owner] = await db
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, fixture.context.userId));
		await db.insert(budgetAlertDelivery).values({
			workspaceId: fixture.context.workspaceId,
			periodMonth: '2026-06-01',
			recipientEmail: owner.email,
			status: 'pending'
		});
		const send = vi.fn(async () => {});

		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toEqual({
			sentCount: 0,
			failedCount: 0,
			alertCount: 0,
			alreadySent: false,
			inProgress: false
		});
		expect(send).not.toHaveBeenCalled();
		await expect(
			db
				.select({
					status: budgetAlertDelivery.status,
					attemptCount: budgetAlertDelivery.attemptCount
				})
				.from(budgetAlertDelivery)
				.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId))
		).resolves.toEqual([{ status: 'pending', attemptCount: 0 }]);
	});

	it('atomically claims pending and expired legacy deliveries without duplicate sends', async () => {
		const fixture = await createWorkspaceFixture();
		const admin = await createMemberContext(fixture, 'admin');
		await seedWarningBudget(fixture);
		const managers = await db
			.select({ id: user.id, email: user.email })
			.from(user)
			.where(inArray(user.id, [fixture.context.userId, admin.userId]));
		const emailById = new Map(managers.map((manager) => [manager.id, manager.email]));
		const now = new Date('2026-06-20T12:00:00.000Z');
		await db.insert(budgetAlertDelivery).values([
			{
				workspaceId: fixture.context.workspaceId,
				periodMonth: '2026-06-01',
				recipientEmail: emailById.get(fixture.context.userId)!,
				status: 'pending'
			},
			{
				workspaceId: fixture.context.workspaceId,
				periodMonth: '2026-06-01',
				recipientEmail: emailById.get(admin.userId)!,
				status: 'sending',
				claimToken: 'expired-legacy-claim',
				claimExpiresAt: new Date(now.getTime() - 1),
				attemptCount: 2
			}
		]);
		let releaseSend!: () => void;
		let markSendStarted!: () => void;
		const sendStarted = new Promise<void>((resolve) => (markSendStarted = resolve));
		const sendGate = new Promise<void>((resolve) => (releaseSend = resolve));
		const send = vi.fn(async () => {
			markSendStarted();
			await sendGate;
		});

		const first = sendBudgetAlerts(fixture.context, '2026-06', { now, send });
		await sendStarted;
		await expect(
			sendBudgetAlerts(fixture.context, '2026-06', { now, send })
		).resolves.toMatchObject({ sentCount: 0, failedCount: 0, inProgress: true });
		expect(send).toHaveBeenCalledTimes(2);
		releaseSend();
		await expect(first).resolves.toMatchObject({ sentCount: 2, failedCount: 0 });
		const rows = await db
			.select({
				status: budgetAlertDelivery.status,
				attemptCount: budgetAlertDelivery.attemptCount
			})
			.from(budgetAlertDelivery)
			.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));
		expect(rows).toEqual(
			expect.arrayContaining([
				{ status: 'sent', attemptCount: 1 },
				{ status: 'sent', attemptCount: 3 }
			])
		);
		expect(rows).toHaveLength(2);
	});

	it('honors legacy retry caps, provider feedback and current verified-manager eligibility', async () => {
		const fixture = await createWorkspaceFixture();
		const bouncedAdmin = await createMemberContext(fixture, 'admin');
		const unverifiedAdmin = await createMemberContext(fixture, 'admin');
		await seedWarningBudget(fixture);
		await db.update(user).set({ emailVerified: false }).where(eq(user.id, unverifiedAdmin.userId));
		const managers = await db
			.select({ id: user.id, email: user.email })
			.from(user)
			.where(
				inArray(user.id, [fixture.context.userId, bouncedAdmin.userId, unverifiedAdmin.userId])
			);
		const emailById = new Map(managers.map((manager) => [manager.id, manager.email]));
		await db.insert(budgetAlertDelivery).values([
			{
				workspaceId: fixture.context.workspaceId,
				periodMonth: '2026-06-01',
				recipientEmail: emailById.get(fixture.context.userId)!,
				status: 'failed',
				attemptCount: 8
			},
			{
				workspaceId: fixture.context.workspaceId,
				periodMonth: '2026-06-01',
				recipientEmail: emailById.get(bouncedAdmin.userId)!,
				status: 'failed',
				attemptCount: 1,
				lastProviderEvent: 'bounce'
			},
			{
				workspaceId: fixture.context.workspaceId,
				periodMonth: '2026-06-01',
				recipientEmail: emailById.get(unverifiedAdmin.userId)!,
				status: 'pending'
			}
		]);
		const send = vi.fn(async () => {});

		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 0,
			failedCount: 0,
			alertCount: 1,
			alreadySent: false,
			inProgress: false
		});
		expect(send).not.toHaveBeenCalled();
		const rows = await db
			.select({
				status: budgetAlertDelivery.status,
				attemptCount: budgetAlertDelivery.attemptCount
			})
			.from(budgetAlertDelivery)
			.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));
		expect(rows).toEqual(
			expect.arrayContaining([
				{ status: 'failed', attemptCount: 8 },
				{ status: 'failed', attemptCount: 1 },
				{ status: 'pending', attemptCount: 0 }
			])
		);
		expect(rows).toHaveLength(3);
	});

	it('does not claim legacy delivery when no verified manager can be identified by email', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		const [owner] = await db
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, fixture.context.userId));
		await db.insert(budgetAlertDelivery).values({
			workspaceId: fixture.context.workspaceId,
			periodMonth: '2026-06-01',
			recipientEmail: owner.email,
			status: 'pending'
		});
		await db.update(user).set({ emailVerified: false }).where(eq(user.id, fixture.context.userId));
		const send = vi.fn(async () => {});

		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 0,
			failedCount: 0,
			alreadySent: false,
			inProgress: false
		});
		expect(send).not.toHaveBeenCalled();
		await expect(
			db
				.select({
					status: budgetAlertDelivery.status,
					attemptCount: budgetAlertDelivery.attemptCount
				})
				.from(budgetAlertDelivery)
				.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId))
		).resolves.toEqual([{ status: 'pending', attemptCount: 0 }]);
	});

	it('retains a failed legacy row and provider reference across a retry', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		const [owner] = await db
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, fixture.context.userId));
		const [legacy] = await db
			.insert(budgetAlertDelivery)
			.values({
				workspaceId: fixture.context.workspaceId,
				periodMonth: '2026-06-01',
				recipientEmail: owner.email,
				status: 'pending'
			})
			.returning({
				id: budgetAlertDelivery.id,
				providerReference: budgetAlertDelivery.providerReference
			});
		const providerLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const failingSend = vi.fn(async () => {
				throw new Error('network unavailable');
			});
			await expect(
				sendBudgetAlerts(fixture.context, '2026-06', { send: failingSend })
			).resolves.toMatchObject({ sentCount: 0, failedCount: 1 });
			let [row] = await db
				.select({
					id: budgetAlertDelivery.id,
					status: budgetAlertDelivery.status,
					attemptCount: budgetAlertDelivery.attemptCount,
					claimToken: budgetAlertDelivery.claimToken,
					lastErrorCategory: budgetAlertDelivery.lastErrorCategory,
					providerReference: budgetAlertDelivery.providerReference
				})
				.from(budgetAlertDelivery)
				.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));
			expect(row).toMatchObject({
				id: legacy.id,
				status: 'failed',
				attemptCount: 1,
				claimToken: null,
				lastErrorCategory: 'network',
				providerReference: legacy.providerReference
			});
			await db.insert(auditEvent).values({
				workspaceId: fixture.context.workspaceId,
				actorUserId: fixture.context.userId,
				action: 'budget.alerts_sent',
				entityType: 'budget',
				entityId: String(fixture.context.workspaceId),
				metadata: { periodMonth: '2026-06-01', alertCount: 1, recipientCount: 1 }
			});

			const retrySend = vi.fn(async () => {});
			await expect(
				sendBudgetAlerts(fixture.context, '2026-06', { send: retrySend })
			).resolves.toMatchObject({ sentCount: 1, failedCount: 0 });
			expect(retrySend).toHaveBeenCalledWith(
				owner.email,
				expect.any(String),
				'2026-06-01',
				expect.any(Array),
				'en',
				`budget-alert:${legacy.providerReference}`
			);
			[row] = await db
				.select({
					id: budgetAlertDelivery.id,
					status: budgetAlertDelivery.status,
					attemptCount: budgetAlertDelivery.attemptCount,
					claimToken: budgetAlertDelivery.claimToken,
					lastErrorCategory: budgetAlertDelivery.lastErrorCategory,
					providerReference: budgetAlertDelivery.providerReference
				})
				.from(budgetAlertDelivery)
				.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));
			expect(row).toMatchObject({
				id: legacy.id,
				status: 'sent',
				attemptCount: 2,
				claimToken: null,
				lastErrorCategory: null,
				providerReference: legacy.providerReference
			});
			await expect(
				db
					.select({ id: budgetAlertDelivery.id })
					.from(budgetAlertDelivery)
					.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId))
			).resolves.toHaveLength(1);
			await expect(
				db
					.select({ id: auditEvent.id })
					.from(auditEvent)
					.where(
						and(
							eq(auditEvent.workspaceId, fixture.context.workspaceId),
							eq(auditEvent.action, 'budget.alerts_sent')
						)
					)
			).resolves.toHaveLength(1);
		} finally {
			providerLog.mockRestore();
		}
	});

	it('keeps a legacy audit-only month closed without creating a retry ledger', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		await db.insert(auditEvent).values({
			workspaceId: fixture.context.workspaceId,
			actorUserId: fixture.context.userId,
			action: 'budget.alerts_sent',
			entityType: 'budget',
			entityId: String(fixture.context.workspaceId),
			metadata: { periodMonth: '2026-06-01', alertCount: 1, recipientCount: 1 }
		});
		const send = vi.fn(async () => {});

		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toEqual({
			sentCount: 0,
			failedCount: 0,
			alertCount: 0,
			alreadySent: true,
			inProgress: false
		});
		expect(send).not.toHaveBeenCalled();
		await expect(
			db
				.select({ id: budgetAlertDelivery.id })
				.from(budgetAlertDelivery)
				.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId))
		).resolves.toHaveLength(0);
	});

	it('notifies a newly eligible recipient without resending successful recipients', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		const firstSend = vi.fn(async () => {});
		await sendBudgetAlerts(fixture.context, '2026-06', { send: firstSend });
		expect(firstSend).toHaveBeenCalledTimes(1);

		const admin = await createMemberContext(fixture, 'admin');
		const secondSend = vi.fn(async () => {});
		await expect(
			sendBudgetAlerts(fixture.context, '2026-06', { send: secondSend })
		).resolves.toMatchObject({ sentCount: 1 });
		expect(secondSend).toHaveBeenCalledTimes(1);
		expect(secondSend).toHaveBeenCalledWith(
			expect.stringContaining(admin.userId),
			expect.any(String),
			'2026-06-01',
			expect.any(Array),
			'en',
			expect.any(String)
		);
		await expect(
			db
				.select({ id: budgetAlertDelivery.id })
				.from(budgetAlertDelivery)
				.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId))
		).resolves.toHaveLength(2);
	});

	it('does not contact an unverified manager', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		await db.update(user).set({ emailVerified: false }).where(eq(user.id, fixture.context.userId));
		const send = vi.fn(async () => {});
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 0,
			failedCount: 0,
			alertCount: 1
		});
		expect(send).not.toHaveBeenCalled();
	});

	it('scopes cursor-paginated delivery history and retries only eligible transient failures', async () => {
		const fixture = await createWorkspaceFixture();
		const admin = await createMemberContext(fixture, 'admin');
		const member = await createMemberContext(fixture, 'member');
		const other = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		const providerLog = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			await sendBudgetAlerts(fixture.context, '2026-06', {
				send: vi.fn(async () => {
					throw new Error('network unavailable');
				})
			});
			await expect(listBudgetAlertDeliveryHistory(member)).rejects.toMatchObject({ status: 403 });
			await expect(listBudgetAlertDeliveryHistory(other.context)).resolves.toMatchObject({
				items: []
			});
			const firstPage = await listBudgetAlertDeliveryHistory(fixture.context, { limit: 1 });
			expect(firstPage.items).toHaveLength(1);
			expect(firstPage.nextCursor).toEqual(expect.any(String));
			expect(firstPage.items[0]).not.toHaveProperty('providerReference');
			expect(firstPage.items[0]).not.toHaveProperty('providerMessageId');
			expect(firstPage.items[0]).toMatchObject({
				status: 'failed',
				lastErrorCategory: 'network',
				retryable: true
			});
			const secondPage = await listBudgetAlertDeliveryHistory(fixture.context, {
				limit: 1,
				cursor: firstPage.nextCursor ?? undefined
			});
			expect(secondPage.items).toHaveLength(1);
			expect(secondPage.items[0].id).not.toBe(firstPage.items[0].id);
			await expect(
				listBudgetAlertDeliveryHistory(fixture.context, { cursor: 'not-a-cursor', limit: 0 })
			).resolves.toMatchObject({ items: [expect.any(Object)] });

			const [warningExpense] = await db
				.select({ id: expense.id })
				.from(expense)
				.where(eq(expense.workspaceId, fixture.context.workspaceId))
				.limit(1);
			await db.update(expense).set({ amountCents: 1_000 }).where(eq(expense.id, warningExpense.id));
			await expect(
				retryBudgetAlertDelivery(fixture.context, firstPage.items[0].id, {
					send: vi.fn(async () => {})
				})
			).rejects.toMatchObject({ status: 409 });
			await db.update(expense).set({ amountCents: 9_000 }).where(eq(expense.id, warningExpense.id));
			await expect(
				retryBudgetAlertDelivery(fixture.context, firstPage.items[0].id, {
					send: vi.fn(async () => {})
				})
			).resolves.toEqual({ sentCount: 1, failedCount: 0 });
			await expect(
				retryBudgetAlertDelivery(other.context, secondPage.items[0].id, {
					send: vi.fn(async () => {})
				})
			).rejects.toMatchObject({ status: 404 });
			await db
				.update(budgetAlertDelivery)
				.set({ lastProviderEvent: 'bounce' })
				.where(eq(budgetAlertDelivery.id, secondPage.items[0].id));
			await expect(
				retryBudgetAlertDelivery(admin, secondPage.items[0].id, {
					send: vi.fn(async () => {})
				})
			).rejects.toMatchObject({ status: 409 });
		} finally {
			providerLog.mockRestore();
		}
	});

	it('skips automatic budget alerts when another instance owns the scheduler lock', async () => {
		const reserved = await client.reserve();
		try {
			await reserved`SELECT pg_advisory_lock(${7_273_299_172})`;
			await expect(runAutomaticBudgetAlertScheduler()).resolves.toEqual({
				processed: 0,
				sent: 0,
				failed: 0,
				errors: 0,
				skipped: true
			});
		} finally {
			await reserved`SELECT pg_advisory_unlock(${7_273_299_172})`;
			reserved.release();
		}
	});

	it('atomically claims budget-alert recipients across concurrent requests', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		let releaseSend!: () => void;
		let markSendStarted!: () => void;
		const sendStarted = new Promise<void>((resolve) => (markSendStarted = resolve));
		const sendGate = new Promise<void>((resolve) => (releaseSend = resolve));
		const send = vi.fn(async () => {
			markSendStarted();
			await sendGate;
		});

		const first = sendBudgetAlerts(fixture.context, '2026-06', { send });
		await sendStarted;
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 0,
			failedCount: 0,
			inProgress: true
		});
		expect(send).toHaveBeenCalledTimes(1);
		releaseSend();
		await expect(first).resolves.toMatchObject({ sentCount: 1, failedCount: 0 });
	});
}
