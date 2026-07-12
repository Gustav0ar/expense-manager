import type { ServiceIntegrationTestContext } from '../services.integration.test';

export function registerExpenseTests(context: ServiceIntegrationTestContext) {
	const {
		randomUUID,
		expect,
		it,
		and,
		eq,
		auditEvent,
		category,
		categoryBudget,
		categoryRule,
		expense,
		paymentMethod,
		recurringExpense,
		vendor,
		client,
		db,
		createCategory,
		listCategories,
		removeCategory,
		unarchiveCategory,
		createExpense,
		bulkReviewExpenses,
		deleteExpense,
		getAnalyticalExpenseReport,
		getDashboard,
		getExpenseListSummary,
		getReport,
		listExpenses,
		reviewExpense,
		updateExpense,
		updateExpensePaymentStatus,
		getOrCreateCatalogItem,
		listExpenseCatalogs,
		removeExpenseCatalogItem,
		updateExpenseCatalogItem,
		createRecurringExpense,
		materializeDueRecurringExpenses,
		runRecurringExpenseScheduler,
		setRecurringExpenseStatus,
		createWorkspaceFixture,
		createMemberContext,
		createExpenseCatalogs
	} = context;

	it('enforces expense review and payment workflow before reporting totals', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');
		const initialCatalogs = await createExpenseCatalogs(fixture.context, {
			paymentMethod: 'Boleto',
			vendor: 'Fornecedor A',
			costCenter: 'Operação'
		});
		const updatedCatalogs = await createExpenseCatalogs(fixture.context, {
			paymentMethod: 'Boleto',
			vendor: 'Fornecedor B',
			costCenter: 'Diretoria'
		});

		const created = await createExpense(memberContext, {
			categoryId: fixture.categoryId,
			description: 'Compra para revisar',
			amount: '120,00',
			expenseDate: '2026-06-26',
			...initialCatalogs,
			competencyMonth: '2026-06'
		});
		const expenseId = created.id;

		const pendingList = await listExpenses(fixture.context, { reviewStatus: 'pending' });
		expect(pendingList.items[0]).toMatchObject({
			id: expenseId,
			reviewStatus: 'pending',
			paymentStatus: 'unpaid',
			paymentMethodId: initialCatalogs.paymentMethodId,
			vendorId: initialCatalogs.vendorId,
			costCenterId: initialCatalogs.costCenterId,
			paymentMethod: 'Boleto',
			vendor: 'Fornecedor A',
			costCenter: 'Operação',
			competencyMonth: '2026-06-01'
		});
		await updateExpense(memberContext, expenseId, {
			categoryId: fixture.categoryId,
			description: 'Compra revisada',
			amount: '130,00',
			expenseDate: '2026-06-26',
			...updatedCatalogs,
			competencyMonth: '2026-06',
			notes: 'Atualizada'
		});
		const updatedPendingList = await listExpenses(fixture.context, { reviewStatus: 'pending' });
		expect(updatedPendingList.items[0]).toMatchObject({
			id: expenseId,
			description: 'Compra revisada',
			amountCents: 13_000,
			vendorId: updatedCatalogs.vendorId,
			costCenterId: updatedCatalogs.costCenterId,
			vendor: 'Fornecedor B',
			costCenter: 'Diretoria',
			notes: 'Atualizada'
		});
		const pendingAnalytics = await getAnalyticalExpenseReport(
			fixture.context,
			{
				from: '2026-06-01',
				to: '2026-06-30',
				reviewStatus: 'pending',
				q: 'Diretoria'
			},
			{ limit: 10 }
		);
		expect(pendingAnalytics).toMatchObject({
			summary: {
				itemCount: 1,
				totalCents: 13_000,
				approvedCents: 0,
				pendingCents: 13_000,
				rejectedCents: 0,
				unpaidCents: 13_000
			},
			truncated: false
		});
		expect(pendingAnalytics.items[0]).toMatchObject({
			id: expenseId,
			expenseDate: '2026-06-26',
			competencyMonth: '2026-06-01',
			description: 'Compra revisada',
			categoryName: 'Limpeza',
			categoryIcon: '🧼',
			amountCents: 13_000,
			paymentMethod: 'Boleto',
			vendor: 'Fornecedor B',
			costCenter: 'Diretoria',
			reviewStatus: 'pending',
			paymentStatus: 'unpaid',
			notes: 'Atualizada',
			attachmentCount: 0
		});
		await expect(
			listExpenses(fixture.context, {
				vendorId: updatedCatalogs.vendorId,
				costCenterId: updatedCatalogs.costCenterId,
				competencyMonth: '2026-06-01'
			})
		).resolves.toMatchObject({
			items: [
				expect.objectContaining({
					id: expenseId,
					vendorId: updatedCatalogs.vendorId,
					costCenterId: updatedCatalogs.costCenterId,
					competencyMonth: '2026-06-01'
				})
			],
			nextCursor: null
		});
		await expect(
			getExpenseListSummary(fixture.context, {
				vendorId: updatedCatalogs.vendorId,
				costCenterId: updatedCatalogs.costCenterId,
				competencyMonth: '2026-06-01'
			})
		).resolves.toEqual({ itemCount: 1, totalCents: 13_000 });
		await expect(
			listExpenses(fixture.context, {
				vendorId: initialCatalogs.vendorId,
				competencyMonth: '2026-06-01'
			})
		).resolves.toMatchObject({ items: [] });
		await expect(
			updateExpensePaymentStatus(fixture.context, expenseId, {
				paymentStatus: 'paid',
				paidAt: '2026-06-26'
			})
		).rejects.toMatchObject({ status: 404 });
		await expect(
			reviewExpense(memberContext, expenseId, { reviewStatus: 'approved' })
		).rejects.toMatchObject({ status: 403 });

		let dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(0);

		await reviewExpense(fixture.context, expenseId, { reviewStatus: 'approved' });
		dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(13_000);

		await updateExpense(memberContext, expenseId, {
			categoryId: fixture.categoryId,
			description: 'Compra revisada',
			amount: '130,00',
			expenseDate: '2026-06-26',
			...updatedCatalogs,
			competencyMonth: '2026-06',
			notes: 'Reenviada'
		});
		let [workflowRow] = await db
			.select({
				reviewStatus: expense.reviewStatus,
				reviewedByUserId: expense.reviewedByUserId,
				reviewedAt: expense.reviewedAt,
				reviewRejectionReason: expense.reviewRejectionReason,
				paymentStatus: expense.paymentStatus,
				paidAt: expense.paidAt,
				reconciledByUserId: expense.reconciledByUserId
			})
			.from(expense)
			.where(eq(expense.id, expenseId));
		expect(workflowRow).toEqual({
			reviewStatus: 'pending',
			reviewedByUserId: null,
			reviewedAt: null,
			reviewRejectionReason: null,
			paymentStatus: 'unpaid',
			paidAt: null,
			reconciledByUserId: null
		});
		dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(0);

		await reviewExpense(fixture.context, expenseId, { reviewStatus: 'approved' });
		await expect(deleteExpense(memberContext, expenseId)).rejects.toMatchObject({ status: 403 });
		dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(13_000);
		await expect(
			getReport(fixture.context, {
				from: '2026-06-01',
				to: '2026-06-30',
				groupBy: 'payment'
			})
		).resolves.toEqual([
			{
				key: 'Boleto',
				label: 'Boleto',
				color: '#2563eb',
				totalCents: 13_000
			}
		]);
		await expect(
			getReport(fixture.context, {
				from: '2026-06-01',
				to: '2026-06-30',
				groupBy: 'payment',
				vendorId: updatedCatalogs.vendorId,
				costCenterId: updatedCatalogs.costCenterId,
				competencyMonth: '2026-06-01'
			})
		).resolves.toEqual([
			{
				key: 'Boleto',
				label: 'Boleto',
				color: '#2563eb',
				totalCents: 13_000
			}
		]);
		await expect(
			getReport(fixture.context, {
				from: '2026-06-01',
				to: '2026-06-30',
				groupBy: 'payment',
				vendorId: initialCatalogs.vendorId,
				competencyMonth: '2026-06-01'
			})
		).resolves.toEqual([]);

		await updateExpensePaymentStatus(fixture.context, expenseId, {
			paymentStatus: 'reconciled',
			paidAt: '2026-06-27'
		});
		await expect(
			updateExpense(memberContext, expenseId, {
				categoryId: fixture.categoryId,
				description: 'Compra paga alterada',
				amount: '140,00',
				expenseDate: '2026-06-26',
				...updatedCatalogs,
				competencyMonth: '2026-06'
			})
		).rejects.toMatchObject({ status: 403 });
		[workflowRow] = await db
			.select({
				reviewStatus: expense.reviewStatus,
				reviewedByUserId: expense.reviewedByUserId,
				reviewedAt: expense.reviewedAt,
				reviewRejectionReason: expense.reviewRejectionReason,
				paymentStatus: expense.paymentStatus,
				paidAt: expense.paidAt,
				reconciledByUserId: expense.reconciledByUserId
			})
			.from(expense)
			.where(eq(expense.id, expenseId));
		expect(workflowRow).toEqual({
			reviewStatus: 'approved',
			reviewedByUserId: fixture.context.userId,
			reviewedAt: expect.any(Date),
			reviewRejectionReason: null,
			paymentStatus: 'reconciled',
			paidAt: '2026-06-27',
			reconciledByUserId: fixture.context.userId
		});
		await expect(
			reviewExpense(fixture.context, expenseId, {
				reviewStatus: 'rejected',
				reason: ''
			})
		).rejects.toMatchObject({ status: 400 });
		await expect(
			getAnalyticalExpenseReport(fixture.context, {
				from: '2026-06-01',
				to: '2026-06-30',
				paymentStatus: 'reconciled'
			})
		).resolves.toMatchObject({
			summary: {
				itemCount: 1,
				totalCents: 13_000,
				approvedCents: 13_000,
				reconciledCents: 13_000
			},
			items: [
				expect.objectContaining({
					id: expenseId,
					paidAt: '2026-06-27',
					paymentStatus: 'reconciled'
				})
			]
		});

		await reviewExpense(fixture.context, expenseId, {
			reviewStatus: 'rejected',
			reason: 'Duplicada'
		});
		[workflowRow] = await db
			.select({
				reviewStatus: expense.reviewStatus,
				reviewedByUserId: expense.reviewedByUserId,
				reviewedAt: expense.reviewedAt,
				reviewRejectionReason: expense.reviewRejectionReason,
				paymentStatus: expense.paymentStatus,
				paidAt: expense.paidAt,
				reconciledByUserId: expense.reconciledByUserId
			})
			.from(expense)
			.where(eq(expense.id, expenseId));
		expect(workflowRow).toEqual({
			reviewStatus: 'rejected',
			reviewedByUserId: fixture.context.userId,
			reviewedAt: expect.any(Date),
			reviewRejectionReason: 'Duplicada',
			paymentStatus: 'unpaid',
			paidAt: null,
			reconciledByUserId: null
		});
		dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(0);

		await deleteExpense(fixture.context, expenseId);
		const afterDelete = await listExpenses(fixture.context, { q: 'Compra revisada' });
		expect(afterDelete.items).toHaveLength(0);
	});

	it('guards payment state-machine transitions and preserves paidAt when reconciling', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');
		const viewerContext = await createMemberContext(fixture, 'viewer');

		// Create as a member so the expense starts in 'pending' review state
		const created = await createExpense(memberContext, {
			categoryId: fixture.categoryId,
			description: 'Despesa para transições',
			amount: '50,00',
			expenseDate: '2026-06-10'
		});
		const id = created.id;

		// Cannot pay/reconcile before approval (WHERE reviewStatus='approved' fails)
		await expect(
			updateExpensePaymentStatus(fixture.context, id, { paymentStatus: 'paid' })
		).rejects.toMatchObject({ status: 404 });

		// Member lacks reconcile rights — 403 on any payment status change
		await expect(
			updateExpensePaymentStatus(memberContext, id, { paymentStatus: 'paid' })
		).rejects.toMatchObject({ status: 403 });

		// Viewer cannot delete an expense
		await expect(deleteExpense(viewerContext, id)).rejects.toMatchObject({ status: 403 });

		// Cannot reject a reconciled expense without reconcile rights (member role)
		await reviewExpense(fixture.context, id, { reviewStatus: 'approved' });
		await updateExpensePaymentStatus(fixture.context, id, {
			paymentStatus: 'reconciled',
			paidAt: '2026-06-10'
		});
		await expect(
			reviewExpense(memberContext, id, { reviewStatus: 'rejected', reason: 'Teste' })
		).rejects.toMatchObject({ status: 403 });

		// Member cannot delete an approved+paid expense (paymentStatus !== 'unpaid' guard)
		await expect(deleteExpense(memberContext, id)).rejects.toMatchObject({ status: 403 });

		// Cannot downgrade reconciled → paid
		await expect(
			updateExpensePaymentStatus(fixture.context, id, { paymentStatus: 'paid' })
		).rejects.toMatchObject({ status: 400 });

		// Can reset to unpaid (reconcilers may undo reconciliation)
		await updateExpensePaymentStatus(fixture.context, id, { paymentStatus: 'unpaid' });

		// Re-approve and mark paid with a specific date; then reconcile without supplying
		// paidAt — the service should preserve the original payment date.
		await reviewExpense(fixture.context, id, { reviewStatus: 'approved' });
		await updateExpensePaymentStatus(fixture.context, id, {
			paymentStatus: 'paid',
			paidAt: '2026-06-12'
		});
		await updateExpensePaymentStatus(fixture.context, id, { paymentStatus: 'reconciled' });
		const [row] = await db
			.select({ paidAt: expense.paidAt, paymentStatus: expense.paymentStatus })
			.from(expense)
			.where(eq(expense.id, id));
		expect(row).toEqual({ paidAt: '2026-06-12', paymentStatus: 'reconciled' });

		// Owner (with reconcile rights) can reject a reconciled expense; payment fields are cleared
		await reviewExpense(fixture.context, id, { reviewStatus: 'rejected', reason: 'Erro' });
		const [afterReject] = await db
			.select({
				reviewStatus: expense.reviewStatus,
				paymentStatus: expense.paymentStatus,
				paidAt: expense.paidAt
			})
			.from(expense)
			.where(eq(expense.id, id));
		expect(afterReject).toEqual({
			reviewStatus: 'rejected',
			paymentStatus: 'unpaid',
			paidAt: null
		});
	});

	it('rolls back an expense payment update when its audit event cannot be inserted', async () => {
		const fixture = await createWorkspaceFixture();
		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: `Atomic payment ${randomUUID()}`,
			amount: '10.00',
			expenseDate: '2026-07-01'
		});
		const invalidActor = { ...fixture.context, userId: `missing-${randomUUID()}` };

		await expect(
			updateExpensePaymentStatus(invalidActor, created.id, {
				paymentStatus: 'paid',
				paidAt: '2026-07-02'
			})
		).rejects.toMatchObject({ cause: { code: '23503' } });
		const [rolledBack] = await db
			.select({ paymentStatus: expense.paymentStatus, paidAt: expense.paidAt })
			.from(expense)
			.where(eq(expense.id, created.id));
		expect(rolledBack).toEqual({ paymentStatus: 'unpaid', paidAt: null });

		await updateExpensePaymentStatus(fixture.context, created.id, {
			paymentStatus: 'paid',
			paidAt: '2026-07-02'
		});
		const events = await db
			.select({ entityId: auditEvent.entityId })
			.from(auditEvent)
			.where(
				and(
					eq(auditEvent.workspaceId, fixture.context.workspaceId),
					eq(auditEvent.action, 'expense.payment_paid'),
					eq(auditEvent.entityId, String(created.id))
				)
			);
		expect(events).toEqual([{ entityId: String(created.id) }]);
	});

	it('keeps recurring expenses generated by members pending until approval', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');

		const schedule = await createRecurringExpense(memberContext, {
			categoryId: fixture.categoryId,
			description: 'Recorrência do membro',
			amount: '60,00',
			frequency: 'monthly',
			intervalCount: 1,
			startDate: '2026-06-01'
		});
		await expect(materializeDueRecurringExpenses(memberContext, '2026-06-30')).resolves.toEqual({
			createdCount: 1
		});

		const [generated] = await db
			.select({
				id: expense.id,
				reviewStatus: expense.reviewStatus,
				reviewedByUserId: expense.reviewedByUserId,
				reviewedAt: expense.reviewedAt,
				sourceRecurringExpenseId: expense.sourceRecurringExpenseId
			})
			.from(expense)
			.where(eq(expense.sourceRecurringExpenseId, schedule.id));
		expect(generated).toEqual({
			id: expect.any(Number),
			reviewStatus: 'pending',
			reviewedByUserId: null,
			reviewedAt: null,
			sourceRecurringExpenseId: schedule.id
		});

		let dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(0);
		await reviewExpense(fixture.context, generated.id, { reviewStatus: 'approved' });
		dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(6_000);
	});

	it('skips the recurring scheduler when another instance owns its lock', async () => {
		const reserved = await client.reserve();
		try {
			await reserved`SELECT pg_advisory_lock(${7_273_299_171})`;
			await expect(runRecurringExpenseScheduler()).resolves.toEqual({
				processed: 0,
				created: 0,
				errors: 0,
				skipped: true
			});
		} finally {
			await reserved`SELECT pg_advisory_unlock(${7_273_299_171})`;
			reserved.release();
		}
	});

	it('does not reactivate a recurrence paused during materialization', async () => {
		const fixture = await createWorkspaceFixture();
		const schedule = await createRecurringExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Pause race',
			amount: '25.00',
			frequency: 'monthly',
			intervalCount: 1,
			startDate: '2026-06-01'
		});
		let releaseMaterialization!: () => void;
		let markSchedulesLocked!: () => void;
		const schedulesLocked = new Promise<void>((resolve) => (markSchedulesLocked = resolve));
		const materializationGate = new Promise<void>((resolve) => (releaseMaterialization = resolve));

		const materialization = materializeDueRecurringExpenses(fixture.context, '2026-06-30', {
			afterSchedulesLocked: async () => {
				markSchedulesLocked();
				await materializationGate;
			}
		});
		await schedulesLocked;

		let pauseResolved = false;
		const pause = setRecurringExpenseStatus(fixture.context, schedule.id, 'paused').then(() => {
			pauseResolved = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(pauseResolved).toBe(false);
		} finally {
			releaseMaterialization();
		}
		await expect(materialization).resolves.toEqual({ createdCount: 1 });
		await pause;

		const [storedSchedule] = await db
			.select({ status: recurringExpense.status, nextRunDate: recurringExpense.nextRunDate })
			.from(recurringExpense)
			.where(eq(recurringExpense.id, schedule.id));
		expect(storedSchedule).toEqual({ status: 'paused', nextRunDate: '2026-07-01' });
	});

	it('paginates installments and covers expense validation branches', async () => {
		const fixture = await createWorkspaceFixture();
		const viewerContext = await createMemberContext(fixture, 'viewer');
		await expect(
			createExpense(viewerContext, {
				categoryId: fixture.categoryId,
				description: 'Sem permissão',
				amount: '10,00',
				expenseDate: '2026-06-01'
			})
		).rejects.toMatchObject({ status: 403 });

		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Compra parcelada',
			amount: '50,00',
			expenseDate: '2026-06-01',
			competencyMonth: '2026-06',
			installments: 2
		});
		expect(created.ids).toHaveLength(2);

		const limitedAnalytics = await getAnalyticalExpenseReport(
			fixture.context,
			{
				from: '2026-06-01',
				to: '2026-07-31'
			},
			{ limit: 1 }
		);
		expect(limitedAnalytics).toMatchObject({
			summary: {
				itemCount: 2,
				totalCents: 10_000
			},
			limit: 1,
			truncated: true
		});
		expect(limitedAnalytics.items).toHaveLength(1);

		const firstPage = await listExpenses(fixture.context, { limit: 1 });
		expect(firstPage.items).toHaveLength(1);
		expect(firstPage.items[0]).toMatchObject({
			description: 'Compra parcelada',
			installmentNumber: 2,
			installmentsTotal: 2,
			competencyMonth: '2026-07-01'
		});
		expect(firstPage.nextCursor).toBeTruthy();

		const secondPage = await listExpenses(fixture.context, {
			limit: 1,
			cursor: firstPage.nextCursor ?? undefined
		});
		expect(secondPage.items[0]).toMatchObject({
			description: 'Compra parcelada',
			installmentNumber: 1,
			installmentsTotal: 2,
			competencyMonth: '2026-06-01'
		});

		await updateExpensePaymentStatus(fixture.context, created.id, { paymentStatus: 'paid' });
		let [paymentRow] = await db
			.select({ paymentStatus: expense.paymentStatus, paidAt: expense.paidAt })
			.from(expense)
			.where(eq(expense.id, created.id));
		expect(paymentRow).toEqual({
			paymentStatus: 'paid',
			paidAt: new Date().toISOString().slice(0, 10)
		});
		await updateExpensePaymentStatus(fixture.context, created.id, { paymentStatus: 'unpaid' });
		[paymentRow] = await db
			.select({ paymentStatus: expense.paymentStatus, paidAt: expense.paidAt })
			.from(expense)
			.where(eq(expense.id, created.id));
		expect(paymentRow).toEqual({ paymentStatus: 'unpaid', paidAt: null });

		await expect(
			updateExpense(fixture.context, created.id + 999_999, {
				categoryId: fixture.categoryId,
				description: 'Inexistente',
				amount: '10,00',
				expenseDate: '2026-06-01'
			})
		).rejects.toMatchObject({ status: 404 });
		await expect(
			updateExpense(fixture.context, created.id, {
				categoryId: fixture.categoryId + 999_999,
				description: 'Categoria inválida',
				amount: '10,00',
				expenseDate: '2026-06-01'
			})
		).rejects.toMatchObject({ status: 400 });
		await expect(deleteExpense(fixture.context, created.id + 999_999)).rejects.toMatchObject({
			status: 404
		});

		await expect(
			getReport(fixture.context, {
				from: '2026-01-01',
				to: '2026-12-31',
				groupBy: 'category',
				categoryId: fixture.categoryId
			})
		).resolves.toEqual([
			expect.objectContaining({
				key: String(fixture.categoryId),
				totalCents: 10_000
			})
		]);
		await expect(
			getReport(fixture.context, {
				from: '2026-01-01',
				to: '2026-12-31',
				groupBy: 'year',
				categoryId: fixture.categoryId
			})
		).resolves.toEqual([expect.objectContaining({ totalCents: 10_000 })]);
	});

	it('groups report by vendor and cost center', async () => {
		const fixture = await createWorkspaceFixture();
		await createExpense(fixture.context, {
			description: 'Vendor test',
			amount: '50,00',
			expenseDate: '2026-06-15',
			categoryId: fixture.categoryId
		});

		const byVendor = await getReport(fixture.context, {
			from: '2026-01-01',
			to: '2026-12-31',
			groupBy: 'vendor'
		});
		expect(byVendor).toEqual([expect.objectContaining({ totalCents: 5_000 })]);

		const byCostCenter = await getReport(fixture.context, {
			from: '2026-01-01',
			to: '2026-12-31',
			groupBy: 'costCenter'
		});
		expect(byCostCenter).toEqual([expect.objectContaining({ totalCents: 5_000 })]);
	});

	it('bulk-reviews pending expenses and scopes by workspace', async () => {
		const fixture = await createWorkspaceFixture();
		// Create expenses as a member so reviewStatus is 'pending'
		const memberContext = await createMemberContext(fixture, 'member');
		const e1 = await createExpense(memberContext, {
			description: 'Bulk one',
			amount: '10,00',
			expenseDate: '2026-06-01',
			categoryId: fixture.categoryId
		});
		const e2 = await createExpense(memberContext, {
			description: 'Bulk two',
			amount: '20,00',
			expenseDate: '2026-06-02',
			categoryId: fixture.categoryId
		});

		const result = await bulkReviewExpenses(fixture.context, [e1.ids[0], e2.ids[0]], 'approved');
		expect(result.count).toBe(2);

		const listed = await listExpenses(fixture.context, {});
		for (const exp of listed.items) {
			expect(exp.reviewStatus).toBe('approved');
		}

		// IDs from another workspace must not be touched
		const other = await createWorkspaceFixture();
		const otherMember = await createMemberContext(other, 'member');
		const e3 = await createExpense(otherMember, {
			description: 'Other ws',
			amount: '5,00',
			expenseDate: '2026-06-03',
			categoryId: other.categoryId
		});
		const crossResult = await bulkReviewExpenses(fixture.context, [e3.ids[0]], 'rejected');
		expect(crossResult.count).toBe(0);
	});

	it('deduplicates controlled expense catalogs per workspace', async () => {
		const fixture = await createWorkspaceFixture();
		const otherFixture = await createWorkspaceFixture();

		const pix = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'paymentMethod',
			' Pix '
		);
		const pixUpper = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'paymentMethod',
			'PIX'
		);
		const otherPix = await getOrCreateCatalogItem(
			db,
			otherFixture.context.workspaceId,
			'paymentMethod',
			'Pix'
		);
		const supplier = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'vendor',
			'ACME  Serviços'
		);
		const duplicateSupplier = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'vendor',
			'Fornecedor B'
		);
		const department = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'costCenter',
			'Administrativo'
		);

		expect(pixUpper.id).toBe(pix.id);
		expect(otherPix.id).not.toBe(pix.id);
		await expect(listExpenseCatalogs(fixture.context)).resolves.toMatchObject({
			paymentMethods: [expect.objectContaining({ id: pix.id, name: 'PIX' })],
			vendors: [
				expect.objectContaining({ id: supplier.id, name: 'ACME Serviços', expenseCount: 0 }),
				expect.objectContaining({ id: duplicateSupplier.id, name: 'Fornecedor B' })
			],
			costCenters: [expect.objectContaining({ id: department.id, name: 'Administrativo' })]
		});
		await expect(
			updateExpenseCatalogItem(fixture.context, {
				kind: 'vendor',
				id: duplicateSupplier.id,
				name: 'acme serviços'
			})
		).rejects.toMatchObject({ status: 400 });

		await updateExpenseCatalogItem(fixture.context, {
			kind: 'vendor',
			id: supplier.id,
			name: 'ACME Brasil'
		});
		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Fornecedor controlado',
			amount: '10,00',
			expenseDate: '2026-06-10',
			paymentMethodId: pix.id,
			vendorId: supplier.id,
			costCenterId: department.id
		});
		await expect(listExpenses(fixture.context, { q: 'ACME Brasil' })).resolves.toMatchObject({
			items: [expect.objectContaining({ id: created.id, vendor: 'ACME Brasil' })]
		});

		const recurringOnlyPayment = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'paymentMethod',
			'Cartão recorrente'
		);
		const [recurringOnlySchedule] = await db
			.insert(recurringExpense)
			.values({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Assinatura sem despesa',
				amountCents: 10_000,
				frequency: 'monthly',
				intervalCount: 1,
				startDate: '2026-06-01',
				nextRunDate: '2026-06-01',
				paymentMethodId: recurringOnlyPayment.id,
				paymentMethod: recurringOnlyPayment.name
			})
			.returning({ id: recurringExpense.id });
		await expect(
			removeExpenseCatalogItem(fixture.context, {
				kind: 'paymentMethod',
				id: recurringOnlyPayment.id
			})
		).resolves.toMatchObject({
			mode: 'archived',
			item: expect.objectContaining({ expenseCount: 0, recurringCount: 1 })
		});
		await expect(
			db
				.select({ id: paymentMethod.id, isArchived: paymentMethod.isArchived })
				.from(paymentMethod)
				.where(eq(paymentMethod.id, recurringOnlyPayment.id))
		).resolves.toEqual([{ id: recurringOnlyPayment.id, isArchived: true }]);
		const [recurringAfterCatalogDelete] = await db
			.select({
				paymentMethodId: recurringExpense.paymentMethodId,
				paymentMethod: recurringExpense.paymentMethod
			})
			.from(recurringExpense)
			.where(eq(recurringExpense.id, recurringOnlySchedule.id));
		expect(recurringAfterCatalogDelete).toEqual({
			paymentMethodId: recurringOnlyPayment.id,
			paymentMethod: 'Cartão recorrente'
		});

		await expect(
			removeExpenseCatalogItem(fixture.context, { kind: 'vendor', id: duplicateSupplier.id })
		).resolves.toMatchObject({ mode: 'deleted' });
		await expect(
			db.select({ id: vendor.id }).from(vendor).where(eq(vendor.id, duplicateSupplier.id))
		).resolves.toEqual([]);

		await expect(
			removeExpenseCatalogItem(fixture.context, { kind: 'vendor', id: supplier.id })
		).resolves.toMatchObject({
			mode: 'archived',
			item: expect.objectContaining({ expenseCount: 1 })
		});
		const [archivedSupplier] = await db
			.select({ isArchived: vendor.isArchived })
			.from(vendor)
			.where(eq(vendor.id, supplier.id));
		expect(archivedSupplier.isArchived).toBe(true);
		await expect(listExpenseCatalogs(fixture.context)).resolves.toMatchObject({
			vendors: []
		});
		await updateExpense(fixture.context, created.id, {
			categoryId: fixture.categoryId,
			description: 'Fornecedor arquivado preservado',
			amount: '11,00',
			expenseDate: '2026-06-11',
			paymentMethodId: pix.id,
			vendorId: supplier.id,
			costCenterId: department.id
		});
		await expect(
			listExpenses(fixture.context, { q: 'arquivado preservado' })
		).resolves.toMatchObject({
			items: [expect.objectContaining({ id: created.id, vendor: 'ACME Brasil' })]
		});
		await expect(
			createExpense(fixture.context, {
				categoryId: fixture.categoryId,
				description: 'Fornecedor arquivado novo uso',
				amount: '10,00',
				expenseDate: '2026-06-10',
				vendorId: supplier.id
			})
		).rejects.toMatchObject({ status: 400 });
		await expect(
			createExpense(fixture.context, {
				categoryId: fixture.categoryId,
				description: 'Fornecedor controlado',
				amount: '10,00',
				expenseDate: '2026-06-10',
				paymentMethodId: otherPix.id
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it('deletes unused categories, archives used categories and restores archived categories', async () => {
		const fixture = await createWorkspaceFixture();
		const unused = await createCategory(fixture.context, {
			name: 'Sem uso',
			color: '#2563eb',
			icon: '💼'
		});
		const used = await createCategory(fixture.context, {
			name: 'Com despesas',
			color: '#dc2626',
			icon: '🧮'
		});

		await expect(removeCategory(fixture.context, unused.id)).resolves.toMatchObject({
			mode: 'deleted',
			item: expect.objectContaining({ id: unused.id, associationCount: 0 })
		});
		await expect(
			db.select({ id: category.id }).from(category).where(eq(category.id, unused.id))
		).resolves.toEqual([]);

		await createExpense(fixture.context, {
			categoryId: used.id,
			description: 'Imposto vinculado',
			amount: '10,00',
			expenseDate: '2026-06-10'
		});

		await expect(removeCategory(fixture.context, used.id)).resolves.toMatchObject({
			mode: 'archived',
			item: expect.objectContaining({ id: used.id, associationCount: 1, expenseCount: 1 })
		});
		await expect(listCategories(fixture.context)).resolves.not.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: used.id })])
		);
		await expect(listCategories(fixture.context, true)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: used.id, isArchived: true, associationCount: 1 })
			])
		);

		await unarchiveCategory(fixture.context, used.id);
		await expect(listCategories(fixture.context)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: used.id, isArchived: false, associationCount: 1 })
			])
		);
	});

	it('reports exact mixed category and payment-method usage without multiplying associations', async () => {
		const fixture = await createWorkspaceFixture();
		const usedCategory = await createCategory(fixture.context, {
			name: 'A mixed usage',
			color: '#2563eb'
		});
		const unusedCategory = await createCategory(fixture.context, {
			name: 'Z unused usage',
			color: '#2563eb'
		});
		const usedPaymentMethod = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'paymentMethod',
			'A mixed method'
		);
		const unusedPaymentMethod = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'paymentMethod',
			'Z unused method'
		);

		await db.insert(category).values([
			{
				workspaceId: fixture.context.workspaceId,
				name: 'Mixed child one',
				color: '#2563eb',
				parentCategoryId: usedCategory.id
			},
			{
				workspaceId: fixture.context.workspaceId,
				name: 'Mixed child two',
				color: '#2563eb',
				parentCategoryId: usedCategory.id
			}
		]);
		await db.insert(expense).values([
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: usedCategory.id,
				createdByUserId: fixture.context.userId,
				description: 'Mixed active one',
				amountCents: 100,
				expenseDate: '2026-06-01',
				paymentMethodId: usedPaymentMethod.id,
				paymentMethod: usedPaymentMethod.name
			},
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: usedCategory.id,
				createdByUserId: fixture.context.userId,
				description: 'Mixed active two',
				amountCents: 200,
				expenseDate: '2026-06-02',
				paymentMethodId: usedPaymentMethod.id,
				paymentMethod: usedPaymentMethod.name
			},
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: usedCategory.id,
				createdByUserId: fixture.context.userId,
				description: 'Mixed deleted',
				amountCents: 300,
				expenseDate: '2026-06-03',
				paymentMethodId: usedPaymentMethod.id,
				paymentMethod: usedPaymentMethod.name,
				deletedAt: new Date('2026-06-04T00:00:00.000Z'),
				trashExpiresAt: new Date('2026-07-04T00:00:00.000Z')
			}
		]);
		await db.insert(recurringExpense).values([
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: usedCategory.id,
				createdByUserId: fixture.context.userId,
				description: 'Mixed recurrence one',
				amountCents: 400,
				startDate: '2026-06-01',
				nextRunDate: '2026-07-01',
				paymentMethodId: usedPaymentMethod.id,
				paymentMethod: usedPaymentMethod.name
			},
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: usedCategory.id,
				createdByUserId: fixture.context.userId,
				description: 'Mixed recurrence two',
				amountCents: 500,
				startDate: '2026-06-02',
				nextRunDate: '2026-07-02',
				paymentMethodId: usedPaymentMethod.id,
				paymentMethod: usedPaymentMethod.name
			}
		]);
		await db.insert(categoryBudget).values([
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: usedCategory.id,
				periodMonth: '2026-06-01',
				amountCents: 10_000,
				createdByUserId: fixture.context.userId
			},
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: usedCategory.id,
				periodMonth: '2026-07-01',
				amountCents: 20_000,
				createdByUserId: fixture.context.userId
			}
		]);
		await db.insert(categoryRule).values([
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: usedCategory.id,
				createdByUserId: fixture.context.userId,
				name: 'Mixed rule one',
				pattern: 'one'
			},
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: usedCategory.id,
				createdByUserId: fixture.context.userId,
				name: 'Mixed rule two',
				pattern: 'two'
			}
		]);

		const categories = (await listCategories(fixture.context)).filter((item) =>
			[usedCategory.id, unusedCategory.id].includes(item.id)
		);
		expect(categories).toEqual([
			expect.objectContaining({
				id: usedCategory.id,
				expenseCount: 3,
				recurringCount: 2,
				budgetCount: 2,
				ruleCount: 2,
				childCount: 2,
				associationCount: 11
			}),
			expect.objectContaining({
				id: unusedCategory.id,
				expenseCount: 0,
				recurringCount: 0,
				budgetCount: 0,
				ruleCount: 0,
				childCount: 0,
				associationCount: 0
			})
		]);

		const paymentMethods = (await listExpenseCatalogs(fixture.context)).paymentMethods.filter(
			(item) => [usedPaymentMethod.id, unusedPaymentMethod.id].includes(item.id)
		);
		expect(paymentMethods).toEqual([
			expect.objectContaining({
				id: usedPaymentMethod.id,
				expenseCount: 3,
				recurringCount: 2
			}),
			expect.objectContaining({
				id: unusedPaymentMethod.id,
				expenseCount: 0,
				recurringCount: 0
			})
		]);

		await expect(removeCategory(fixture.context, usedCategory.id)).resolves.toMatchObject({
			mode: 'archived',
			item: expect.objectContaining({ associationCount: 11 })
		});
		await expect(removeCategory(fixture.context, unusedCategory.id)).resolves.toMatchObject({
			mode: 'deleted'
		});
		await expect(
			removeExpenseCatalogItem(fixture.context, {
				kind: 'paymentMethod',
				id: usedPaymentMethod.id
			})
		).resolves.toMatchObject({
			mode: 'archived',
			item: expect.objectContaining({ expenseCount: 3, recurringCount: 2 })
		});
		await expect(
			removeExpenseCatalogItem(fixture.context, {
				kind: 'paymentMethod',
				id: unusedPaymentMethod.id
			})
		).resolves.toMatchObject({ mode: 'deleted' });
	});
}
