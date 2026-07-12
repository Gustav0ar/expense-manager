import type { ServiceIntegrationTestContext } from '../services.integration.test';

export function registerExpenseLifecycleTests(context: ServiceIntegrationTestContext) {
	const {
		afterEach,
		mkdtemp,
		readdir,
		rm,
		tmpdir,
		path,
		expect,
		it,
		eq,
		attachmentDeletion,
		categoryBudget,
		expense,
		expenseAttachment,
		recurringExpense,
		db,
		maxMoneyCents,
		getAttachmentForDownload,
		maxAttachmentBytes,
		saveExpenseAttachment,
		createExpense,
		bulkReviewExpenses,
		deleteExpense,
		getExpenseListSummary,
		listExpenses,
		reviewExpense,
		updateExpensePaymentStatus,
		expenseTrashDates,
		uploadDirs,
		createWorkspaceFixture,
		createMemberContext
	} = context;

	it('summarizes filtered expenses without using the current cursor page only', async () => {
		const fixture = await createWorkspaceFixture();
		await db.insert(expense).values([
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Produto limpeza',
				amountCents: 3550,
				expenseDate: '2026-06-26'
			},
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Produto limpeza extra',
				amountCents: 1500,
				expenseDate: '2026-06-27'
			}
		]);

		const summary = await getExpenseListSummary(fixture.context, {
			from: '2026-06-01',
			to: '2026-06-30',
			q: 'limpeza'
		});

		expect(summary).toEqual({ itemCount: 2, totalCents: 5050 });
	});

	it('streams attachments to storage and downloads them from active expenses', async () => {
		const fixture = await createWorkspaceFixture();
		const previousUploadDir = process.env.UPLOAD_DIR;
		const uploadDir = await mkdtemp(path.join(tmpdir(), 'expense-attachments-'));
		uploadDirs.push(uploadDir);
		process.env.UPLOAD_DIR = uploadDir;

		try {
			const [expenseRow] = await db
				.insert(expense)
				.values({
					workspaceId: fixture.context.workspaceId,
					categoryId: fixture.categoryId,
					createdByUserId: fixture.context.userId,
					description: 'Produto limpeza',
					amountCents: 3550,
					expenseDate: '2026-06-26'
				})
				.returning({ id: expense.id });
			const content = 'recibo teste';
			const file = new File([content], 'recibo teste.txt', { type: 'text/plain' });

			const created = await saveExpenseAttachment(fixture.context, expenseRow.id, file);

			expect(created?.id).toBeGreaterThan(0);
			const [stored] = await db
				.select({
					originalName: expenseAttachment.originalName,
					contentType: expenseAttachment.contentType,
					sizeBytes: expenseAttachment.sizeBytes,
					storageKey: expenseAttachment.storageKey
				})
				.from(expenseAttachment)
				.where(eq(expenseAttachment.id, created!.id));
			expect(stored).toMatchObject({
				originalName: 'recibo-teste.txt',
				contentType: 'text/plain',
				sizeBytes: new TextEncoder().encode(content).byteLength
			});
			const attachmentDirectoryEntries = await readdir(
				path.dirname(path.join(uploadDir, stored.storageKey))
			);
			expect(attachmentDirectoryEntries.some((entry) => entry.endsWith('.tmp'))).toBe(false);

			const download = await getAttachmentForDownload(fixture.context, created!.id);
			expect(download.contentLength).toBe(stored.sizeBytes);
			await expect(new Response(download.stream).text()).resolves.toBe(content);
			await expect(listExpenses(fixture.context, { q: 'Produto limpeza' })).resolves.toMatchObject({
				items: [
					expect.objectContaining({
						id: expenseRow.id,
						attachments: [
							expect.objectContaining({
								id: created!.id,
								originalName: 'recibo-teste.txt',
								contentType: 'text/plain',
								sizeBytes: stored.sizeBytes
							})
						]
					})
				]
			});

			const deletedAt = new Date();
			await db
				.update(expense)
				.set({ deletedAt, trashExpiresAt: expenseTrashDates(deletedAt).trashExpiresAt })
				.where(eq(expense.id, expenseRow.id));

			await expect(getAttachmentForDownload(fixture.context, created!.id)).rejects.toMatchObject({
				status: 404
			});
		} finally {
			if (previousUploadDir === undefined) {
				delete process.env.UPLOAD_DIR;
			} else {
				process.env.UPLOAD_DIR = previousUploadDir;
			}
		}
	});

	it('limits expense attachments to 2 MiB', () => {
		expect(maxAttachmentBytes).toBe(2 * 1024 * 1024);
	});

	it('enforces the same direct-insert money boundary on every money table', async () => {
		const fixture = await createWorkspaceFixture();
		const commonExpense = {
			workspaceId: fixture.context.workspaceId,
			categoryId: fixture.categoryId,
			createdByUserId: fixture.context.userId,
			currency: fixture.context.currency
		};

		await expect(
			db.insert(expense).values({
				...commonExpense,
				description: 'Maximum direct expense',
				amountCents: maxMoneyCents,
				expenseDate: '2026-06-01'
			})
		).resolves.toBeDefined();
		await expect(
			db.insert(expense).values({
				...commonExpense,
				description: 'Oversized direct expense',
				amountCents: maxMoneyCents + 1,
				expenseDate: '2026-06-02'
			})
		).rejects.toThrow();

		await expect(
			db.insert(categoryBudget).values({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				periodMonth: '2026-06-01',
				amountCents: maxMoneyCents,
				createdByUserId: fixture.context.userId
			})
		).resolves.toBeDefined();
		await expect(
			db.insert(categoryBudget).values({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				periodMonth: '2026-07-01',
				amountCents: maxMoneyCents + 1,
				createdByUserId: fixture.context.userId
			})
		).rejects.toThrow();

		await expect(
			db.insert(recurringExpense).values({
				...commonExpense,
				description: 'Maximum direct recurrence',
				amountCents: maxMoneyCents,
				frequency: 'monthly',
				intervalCount: 1,
				startDate: '2026-06-01',
				nextRunDate: '2026-06-01'
			})
		).resolves.toBeDefined();
		await expect(
			db.insert(recurringExpense).values({
				...commonExpense,
				description: 'Oversized direct recurrence',
				amountCents: maxMoneyCents + 1,
				frequency: 'monthly',
				intervalCount: 1,
				startDate: '2026-07-01',
				nextRunDate: '2026-07-01'
			})
		).rejects.toThrow();
	});

	it('tombstones attachments and enqueues durable deletion when expense is deleted', async () => {
		const fixture = await createWorkspaceFixture();
		const previousUploadDir = process.env.UPLOAD_DIR;
		const uploadDir = await mkdtemp(path.join(tmpdir(), 'attach-delete-'));
		process.env.UPLOAD_DIR = uploadDir;
		try {
			const [expenseRow] = await db
				.insert(expense)
				.values({
					workspaceId: fixture.context.workspaceId,
					categoryId: fixture.categoryId,
					createdByUserId: fixture.context.userId,
					description: 'To delete',
					amountCents: 1_000,
					expenseDate: '2026-06-26'
				})
				.returning({ id: expense.id });

			const file = new File(['receipt'], 'receipt.txt', { type: 'text/plain' });
			const att = await saveExpenseAttachment(fixture.context, expenseRow.id, file);
			expect(att?.id).toBeGreaterThan(0);

			await deleteExpense(fixture.context, expenseRow.id);

			const remaining = await db
				.select({ deletedAt: expenseAttachment.deletedAt })
				.from(expenseAttachment)
				.where(eq(expenseAttachment.id, att!.id));
			expect(remaining[0]?.deletedAt).toBeInstanceOf(Date);
			await expect(
				db
					.select({ status: attachmentDeletion.status })
					.from(attachmentDeletion)
					.where(eq(attachmentDeletion.attachmentId, att!.id))
			).resolves.toEqual([{ status: 'pending' }]);
			await expect(getAttachmentForDownload(fixture.context, att!.id)).rejects.toMatchObject({
				status: 404
			});
		} finally {
			if (previousUploadDir === undefined) {
				delete process.env.UPLOAD_DIR;
			} else {
				process.env.UPLOAD_DIR = previousUploadDir;
			}
			await rm(uploadDir, { recursive: true, force: true });
		}
	});

	it('bulk-rejects expenses and resets payment status', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');
		const e1 = await createExpense(memberContext, {
			description: 'To reject',
			amount: '30,00',
			expenseDate: '2026-06-10',
			categoryId: fixture.categoryId
		});

		const result = await bulkReviewExpenses(fixture.context, [e1.ids[0]], 'rejected');
		expect(result.count).toBe(1);

		const listed = await listExpenses(fixture.context, {});
		const rejected = listed.items.find((e) => e.id === e1.ids[0]);
		expect(rejected?.reviewStatus).toBe('rejected');
		expect(rejected?.paymentStatus).toBe('unpaid');

		// Member role cannot bulk review
		await expect(bulkReviewExpenses(memberContext, [e1.ids[0]], 'approved')).rejects.toMatchObject({
			status: 403
		});

		// Empty ids list is rejected
		await expect(bulkReviewExpenses(fixture.context, [], 'approved')).rejects.toMatchObject({
			status: 400
		});
	});

	it('bulk-reject only affects pending, unpaid expenses', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');

		// Pending + unpaid — the only state bulk review can act on.
		const ePending = await createExpense(memberContext, {
			description: 'Pending unpaid',
			amount: '20,00',
			expenseDate: '2026-06-10',
			categoryId: fixture.categoryId
		});

		// Approved + paid — outside bulk review's reviewStatus='pending' filter.
		const eApprovedPaid = await createExpense(memberContext, {
			description: 'Approved and paid',
			amount: '50,00',
			expenseDate: '2026-06-10',
			categoryId: fixture.categoryId
		});
		await reviewExpense(fixture.context, eApprovedPaid.ids[0], { reviewStatus: 'approved' });
		await updateExpensePaymentStatus(fixture.context, eApprovedPaid.ids[0], {
			paymentStatus: 'paid'
		});

		// Defensive legacy state: the service layer does not create pending+paid
		// rows, but the schema permits one and bulk review must not erase its payment.
		const [ePendingPaid] = await db
			.insert(expense)
			.values({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Pending but paid',
				amountCents: 7500,
				expenseDate: '2026-06-10',
				reviewStatus: 'pending',
				paymentStatus: 'paid',
				paidAt: '2026-06-10'
			})
			.returning({ id: expense.id });

		// Only the pending+unpaid expense is eligible.
		const result = await bulkReviewExpenses(
			fixture.context,
			[ePending.ids[0], eApprovedPaid.ids[0], ePendingPaid.id],
			'rejected'
		);
		expect(result.count).toBe(1);

		const listed = await listExpenses(fixture.context, {});
		const rejected = listed.items.find((e) => e.id === ePending.ids[0]);
		expect(rejected?.reviewStatus).toBe('rejected');
		expect(rejected?.paymentStatus).toBe('unpaid');

		// The approved+paid expense is untouched: still approved, still paid.
		const untouched = listed.items.find((e) => e.id === eApprovedPaid.ids[0]);
		expect(untouched?.reviewStatus).toBe('approved');
		expect(untouched?.paymentStatus).toBe('paid');

		const protectedPayment = listed.items.find((e) => e.id === ePendingPaid.id);
		expect(protectedPayment?.reviewStatus).toBe('pending');
		expect(protectedPayment?.paymentStatus).toBe('paid');
	});

	it('rejects unsafe attachment inputs before writing files', async () => {
		const fixture = await createWorkspaceFixture();
		const uploadDirs: string[] = [];
		afterEach(async () => {
			for (const d of uploadDirs) await rm(d, { recursive: true, force: true });
		});
		const previousUploadDir = process.env.UPLOAD_DIR;
		const uploadDir = await mkdtemp(path.join(tmpdir(), 'expense-attachments-'));
		uploadDirs.push(uploadDir);
		process.env.UPLOAD_DIR = uploadDir;

		try {
			const [expenseRow] = await db
				.insert(expense)
				.values({
					workspaceId: fixture.context.workspaceId,
					categoryId: fixture.categoryId,
					createdByUserId: fixture.context.userId,
					description: 'Produto limpeza',
					amountCents: 3550,
					expenseDate: '2026-06-26'
				})
				.returning({ id: expense.id });

			await expect(
				saveExpenseAttachment(
					fixture.context,
					expenseRow.id,
					new File(['conteúdo'], 'malware.exe', { type: 'application/x-msdownload' })
				)
			).rejects.toMatchObject({ status: 400 });
			await expect(
				saveExpenseAttachment(
					fixture.context,
					expenseRow.id,
					new File([new Uint8Array(maxAttachmentBytes + 1)], 'grande.txt', {
						type: 'text/plain'
					})
				)
			).rejects.toMatchObject({ status: 400 });
			await expect(readdir(uploadDir)).resolves.toEqual([]);
		} finally {
			if (previousUploadDir === undefined) {
				delete process.env.UPLOAD_DIR;
			} else {
				process.env.UPLOAD_DIR = previousUploadDir;
			}
		}
	});
}
