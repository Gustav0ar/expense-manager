import type { ServiceIntegrationTestContext } from '../services.integration.test';
import type { getActiveRules } from '../category-rules';

export function registerImportTests(context: ServiceIntegrationTestContext) {
	const {
		mkdtemp,
		tmpdir,
		path,
		expect,
		it,
		eq,
		inArray,
		attachmentDeletion,
		category,
		categoryRule,
		expense,
		expenseAttachment,
		importBatch,
		importPreview,
		client,
		db,
		saveExpenseAttachment,
		archiveCategoryRule,
		createCategoryRule,
		listCategoryRules,
		matchCategoryRule,
		matchCategoryRuleFromRules,
		expenseTrashDates,
		expenseTrashRetentionMs,
		restoreTrashedExpense,
		confirmImportPreview,
		confirmedImportPreviewRetentionMs,
		importExpenses,
		importPreviewTtlMs,
		listImportBatches,
		pruneExpiredImportPreviews,
		previewImportExpenses,
		undoImportBatch,
		uploadDirs,
		createWorkspaceFixture,
		createMemberContext
	} = context;

	it('persists failed-only imports with batch counters and failed row details', async () => {
		const fixture = await createWorkspaceFixture();
		const file = new File(['Data;Descrição;Valor\nbad;;abc\n'], 'falhas.csv', {
			type: 'text/csv'
		});

		const result = await importExpenses(fixture.context, { sourceType: 'csv', file });

		expect(result.importBatchId).toBeGreaterThan(0);
		expect(result).toMatchObject({ importedCount: 0, failedCount: 1 });
		expect(result.failedRows[0]?.message).toContain('date, description or amount');

		const [batch] = await db
			.select()
			.from(importBatch)
			.where(eq(importBatch.id, result.importBatchId));
		expect(batch).toMatchObject({
			rowCount: 1,
			importedCount: 0,
			failedCount: 1,
			failedRows: result.failedRows
		});

		const batches = await listImportBatches(fixture.context);
		expect(batches[0]).toMatchObject({
			id: result.importBatchId,
			rowCount: 1,
			importedCount: 0,
			failedCount: 1,
			failedRows: result.failedRows
		});
	});

	it('previews without expense writes and enforces ownership, expiry and checksum on confirm', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');
		const content = 'date,description,amount\n2026-07-11,Preview only,12.00\n';
		const now = new Date('2026-07-11T12:00:00.000Z');
		const preview = await previewImportExpenses(
			fixture.context,
			{
				sourceType: 'csv',
				defaultCategoryId: fixture.categoryId,
				file: new File([content], 'preview.csv', { type: 'text/csv' })
			},
			{ now }
		);

		expect(preview.rows[0]).toMatchObject({
			sourceRowId: 'csv:2',
			description: 'Preview only',
			categoryName: 'Limpeza',
			isDuplicate: false
		});
		await expect(
			db.select().from(expense).where(eq(expense.description, 'Preview only'))
		).resolves.toHaveLength(0);
		await expect(
			confirmImportPreview(memberContext, {
				previewId: preview.previewId,
				sourceChecksum: preview.sourceChecksum
			})
		).rejects.toMatchObject({ status: 404 });
		await expect(
			confirmImportPreview(fixture.context, {
				previewId: preview.previewId,
				sourceChecksum: '0'.repeat(64)
			})
		).rejects.toMatchObject({ status: 409 });
		await expect(
			confirmImportPreview(
				fixture.context,
				{ previewId: preview.previewId, sourceChecksum: preview.sourceChecksum },
				{ now: new Date(now.getTime() + importPreviewTtlMs + 1) }
			)
		).rejects.toMatchObject({ status: 410 });
	});

	it('confirms a preview exactly once across repeated and concurrent submissions', async () => {
		const fixture = await createWorkspaceFixture();
		const preview = await previewImportExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File(
				['date,description,amount\n2026-07-11,Idempotent preview,18.00\n'],
				'idempotent.csv',
				{ type: 'text/csv' }
			)
		});
		const input = { previewId: preview.previewId, sourceChecksum: preview.sourceChecksum };
		const [first, concurrent] = await Promise.all([
			confirmImportPreview(fixture.context, input),
			confirmImportPreview(fixture.context, input)
		]);
		const repeated = await confirmImportPreview(fixture.context, input);

		expect(concurrent.importBatchId).toBe(first.importBatchId);
		expect(repeated).toEqual(first);
		await expect(
			db.select().from(expense).where(eq(expense.description, 'Idempotent preview'))
		).resolves.toHaveLength(1);
		const [storedPreview] = await db
			.select({ status: importPreview.status, batchId: importPreview.confirmedBatchId })
			.from(importPreview)
			.where(eq(importPreview.id, preview.previewId));
		expect(storedPreview).toEqual({ status: 'confirmed', batchId: first.importBatchId });
	});

	it('prunes expired import previews while retaining fresh and recently confirmed replay state', async () => {
		const fixture = await createWorkspaceFixture();
		const now = new Date('2026-07-13T12:00:00.000Z');
		const makePreview = (description: string, createdAt: Date) =>
			previewImportExpenses(
				fixture.context,
				{
					sourceType: 'csv',
					defaultCategoryId: fixture.categoryId,
					file: new File(
						[`date,description,amount\n2026-07-11,${description},10.00\n`],
						`${description}.csv`,
						{ type: 'text/csv' }
					)
				},
				{ now: createdAt }
			);
		const expiredPending = await makePreview(
			'Expired pending',
			new Date(now.getTime() - importPreviewTtlMs - 1)
		);
		const freshPending = await makePreview('Fresh pending', now);
		const oldConfirmed = await makePreview(
			'Old confirmed',
			new Date(now.getTime() - confirmedImportPreviewRetentionMs - importPreviewTtlMs - 1)
		);
		await confirmImportPreview(
			fixture.context,
			{ previewId: oldConfirmed.previewId, sourceChecksum: oldConfirmed.sourceChecksum },
			{ now: new Date(oldConfirmed.expiresAt.getTime() - 1) }
		);
		const recentConfirmed = await makePreview('Recent confirmed', now);
		await confirmImportPreview(
			fixture.context,
			{ previewId: recentConfirmed.previewId, sourceChecksum: recentConfirmed.sourceChecksum },
			{ now }
		);

		const cleanup = await pruneExpiredImportPreviews(now);
		expect(cleanup.deletedPreviews).toBeGreaterThanOrEqual(2);
		const remaining = await db
			.select({ id: importPreview.id })
			.from(importPreview)
			.where(
				inArray(importPreview.id, [
					expiredPending.previewId,
					freshPending.previewId,
					oldConfirmed.previewId,
					recentConfirmed.previewId
				])
			);
		expect(new Set(remaining.map((row) => row.id))).toEqual(
			new Set([freshPending.previewId, recentConfirmed.previewId])
		);
	});

	it('skips import preview cleanup while another instance owns its advisory lock', async () => {
		const reserved = await client.reserve();
		try {
			await reserved`
				select pg_advisory_lock(
					hashtextextended('expense-manager:import-preview-cleanup:v1', 0)
				)
			`;
			await expect(pruneExpiredImportPreviews()).resolves.toEqual({
				deletedPreviews: 0,
				skipped: true
			});
		} finally {
			await reserved`
				select pg_advisory_unlock(
					hashtextextended('expense-manager:import-preview-cleanup:v1', 0)
				)
			`;
			reserved.release();
		}
	});

	it('undoes only unchanged unpaid rows and is scoped and repeat-safe', async () => {
		const fixture = await createWorkspaceFixture();
		const otherWorkspace = await createWorkspaceFixture();
		const result = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File(
				[
					[
						'date,description,amount',
						'2026-07-11,Undo eligible,10.00',
						'2026-07-11,Undo edited,20.00',
						'2026-07-11,Undo paid,30.00'
					].join('\n')
				],
				'undo.csv',
				{ type: 'text/csv' }
			)
		});
		const imported = await db
			.select({ id: expense.id, description: expense.description })
			.from(expense)
			.where(eq(expense.importBatchId, result.importBatchId));
		const edited = imported.find((row) => row.description === 'Undo edited')!;
		const paid = imported.find((row) => row.description === 'Undo paid')!;
		await db
			.update(expense)
			.set({ description: 'Materially edited' })
			.where(eq(expense.id, edited.id));
		await db
			.update(expense)
			.set({ paymentStatus: 'paid', paidAt: '2026-07-11' })
			.where(eq(expense.id, paid.id));

		await expect(
			undoImportBatch(otherWorkspace.context, result.importBatchId)
		).rejects.toMatchObject({
			status: 404
		});
		const undone = await undoImportBatch(fixture.context, result.importBatchId);
		expect(undone).toEqual({ undoneCount: 1, skippedCount: 2 });
		await expect(undoImportBatch(fixture.context, result.importBatchId)).resolves.toEqual(undone);

		const rows = await db
			.select({ description: expense.description, deletedAt: expense.deletedAt })
			.from(expense)
			.where(eq(expense.importBatchId, result.importBatchId));
		expect(rows.find((row) => row.description === 'Undo eligible')?.deletedAt).toBeInstanceOf(Date);
		expect(rows.find((row) => row.description === 'Materially edited')?.deletedAt).toBeNull();
		expect(rows.find((row) => row.description === 'Undo paid')?.deletedAt).toBeNull();
	});

	it('atomically tombstones attachments and enqueues deletion when undoing an import', async () => {
		const fixture = await createWorkspaceFixture();
		const uploadDir = await mkdtemp(path.join(tmpdir(), 'expense-import-undo-'));
		uploadDirs.push(uploadDir);
		const previousUploadDir = process.env.UPLOAD_DIR;
		process.env.UPLOAD_DIR = uploadDir;
		try {
			const imported = await importExpenses(fixture.context, {
				sourceType: 'csv',
				defaultCategoryId: fixture.categoryId,
				file: new File(
					['date,description,amount\n2026-07-11,Undo attachment,15.00\n'],
					'undo-attachment.csv',
					{ type: 'text/csv' }
				)
			});
			const [expenseRow] = await db
				.select({ id: expense.id })
				.from(expense)
				.where(eq(expense.importBatchId, imported.importBatchId));
			const saved = await saveExpenseAttachment(
				fixture.context,
				expenseRow.id,
				new File(['receipt'], 'receipt.txt', { type: 'text/plain' })
			);

			await expect(undoImportBatch(fixture.context, imported.importBatchId)).resolves.toEqual({
				undoneCount: 1,
				skippedCount: 0
			});
			const [trashedExpense] = await db
				.select({ deletedAt: expense.deletedAt, trashExpiresAt: expense.trashExpiresAt })
				.from(expense)
				.where(eq(expense.id, expenseRow.id));
			const [attachment] = await db
				.select({
					deletedAt: expenseAttachment.deletedAt,
					storageKey: expenseAttachment.storageKey
				})
				.from(expenseAttachment)
				.where(eq(expenseAttachment.id, saved!.id));
			const [intent] = await db
				.select({
					attachmentId: attachmentDeletion.attachmentId,
					reason: attachmentDeletion.reason,
					status: attachmentDeletion.status,
					storageKey: attachmentDeletion.storageKey,
					notBefore: attachmentDeletion.notBefore
				})
				.from(attachmentDeletion)
				.where(eq(attachmentDeletion.attachmentId, saved!.id));
			expect(attachment.deletedAt).toBeInstanceOf(Date);
			expect(trashedExpense.trashExpiresAt!.getTime() - trashedExpense.deletedAt!.getTime()).toBe(
				expenseTrashRetentionMs
			);
			expect(intent).toMatchObject({
				attachmentId: saved!.id,
				reason: 'expense_trash',
				status: 'pending',
				storageKey: attachment.storageKey
			});
			expect(intent.notBefore.getTime()).toBe(
				trashedExpense.trashExpiresAt!.getTime() + 48 * 60 * 60 * 1000
			);
			await restoreTrashedExpense(fixture.context, expenseRow.id);
			const [unchangedBatch] = await db
				.select({
					undoneCount: importBatch.undoneCount,
					undoSkippedCount: importBatch.undoSkippedCount,
					undoneAt: importBatch.undoneAt
				})
				.from(importBatch)
				.where(eq(importBatch.id, imported.importBatchId));
			expect(unchangedBatch).toMatchObject({
				undoneCount: 1,
				undoSkippedCount: 0,
				undoneAt: expect.any(Date)
			});
		} finally {
			if (previousUploadDir === undefined) delete process.env.UPLOAD_DIR;
			else process.env.UPLOAD_DIR = previousUploadDir;
		}
	});

	it('records valid import rows rejected by business validation', async () => {
		const fixture = await createWorkspaceFixture();
		const file = new File(
			['Data;Descrição;Valor;Categoria\n26/06/2026;Compra;35,50;Inexistente\n'],
			'sem-categoria.csv',
			{
				type: 'text/csv'
			}
		);

		const result = await importExpenses(fixture.context, { sourceType: 'csv', file });

		expect(result).toMatchObject({ importedCount: 0, failedCount: 1 });
		expect(result.failedRows[0]).toMatchObject({
			rowNumber: 2,
			message: 'Category not found and no default category was selected.'
		});
	});

	it('rejects invalid defaults and import files beyond the row limit', async () => {
		const fixture = await createWorkspaceFixture();
		const rows = Array.from({ length: 501 }, (_, index) => `26/06/2026;Compra ${index};35,50`).join(
			'\n'
		);

		await expect(
			importExpenses(fixture.context, {
				sourceType: 'csv',
				defaultCategoryId: fixture.categoryId + 999_999,
				file: new File(['Data;Descrição;Valor\n26/06/2026;Compra;35,50\n'], 'padrão.csv', {
					type: 'text/csv'
				})
			})
		).rejects.toMatchObject({ status: 400 });

		await expect(
			importExpenses(fixture.context, {
				sourceType: 'csv',
				defaultCategoryId: fixture.categoryId,
				file: new File([`Data;Descrição;Valor\n${rows}\n`], 'muitas.csv', { type: 'text/csv' })
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it('imports valid rows while preserving failed row accounting', async () => {
		const fixture = await createWorkspaceFixture();
		const file = new File(
			['Data;Descrição;Valor\n26/06/2026;Produto limpeza;35,50\nbad;;abc\n'],
			'parcial.csv',
			{ type: 'text/csv' }
		);

		const result = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file
		});

		expect(result).toMatchObject({ importedCount: 1, failedCount: 1 });

		const [batch] = await db
			.select()
			.from(importBatch)
			.where(eq(importBatch.id, result.importBatchId));
		expect(batch.rowCount).toBe(2);

		const createdExpenses = await db
			.select({ description: expense.description, amountCents: expense.amountCents })
			.from(expense)
			.where(eq(expense.importBatchId, result.importBatchId));
		expect(createdExpenses).toEqual([{ description: 'Produto limpeza', amountCents: 3550 }]);
	});

	it('deduplicates rows against existing DB expenses but allows genuinely identical within-batch rows', async () => {
		const fixture = await createWorkspaceFixture();

		// Re-import a file: same row as an existing expense → duplicateCount 1
		const csvRow = 'Data;Descrição;Valor\n26/06/2026;Café;10,00\n';
		const firstImport = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File([csvRow], 'first.csv', { type: 'text/csv' })
		});
		expect(firstImport.importedCount).toBe(1);

		const reimport = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File([csvRow], 'reimport.csv', { type: 'text/csv' })
		});
		expect(reimport.importedCount).toBe(0);
		expect(reimport.duplicateCount).toBe(1);

		// Two identical rows in the same file: both should be imported (genuine duplicates)
		const twoRows =
			'Data;Descrição;Valor\n27/06/2026;Dois cafés;5,00\n27/06/2026;Dois cafés;5,00\n';
		const batchImport = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File([twoRows], 'dois.csv', { type: 'text/csv' })
		});
		expect(batchImport.importedCount).toBe(2);
		expect(batchImport.duplicateCount).toBe(0);
	});

	it('preserves mixed-batch counts and ignores soft-deleted matches', async () => {
		const fixture = await createWorkspaceFixture();
		const existingCsv = 'date,description,amount\n2026-06-27,Existing row,10.00\n';
		const deletedCsv = 'date,description,amount\n2026-06-27,Deleted row,20.00\n';
		const existingImport = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File([existingCsv], 'existing.csv', { type: 'text/csv' })
		});
		const deletedImport = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File([deletedCsv], 'deleted.csv', { type: 'text/csv' })
		});
		const deletedAt = new Date();
		await db
			.update(expense)
			.set({ deletedAt, trashExpiresAt: expenseTrashDates(deletedAt).trashExpiresAt })
			.where(eq(expense.importBatchId, deletedImport.importBatchId));

		const mixedRows = [
			'2026-06-27,Existing row,10.00',
			'2026-06-27,Existing row,10.00',
			'2026-06-27,New row,30.00',
			'2026-06-27,New row,30.00',
			'2026-06-27,Deleted row,20.00',
			'2026-06-27,Deleted row,20.00'
		].join('\n');
		const result = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File([`date,description,amount\n${mixedRows}\n`], 'mixed.csv', {
				type: 'text/csv'
			})
		});

		expect(existingImport.importedCount).toBe(1);
		expect(result).toMatchObject({ importedCount: 4, duplicateCount: 2, failedCount: 0 });
		const created = await db
			.select({ description: expense.description })
			.from(expense)
			.where(eq(expense.importBatchId, result.importBatchId));
		expect(created.filter((row) => row.description === 'New row')).toHaveLength(2);
		expect(created.filter((row) => row.description === 'Deleted row')).toHaveLength(2);
	});

	it('bounds database statements for a 500-row import', async () => {
		const fixture = await createWorkspaceFixture();
		const rows = Array.from(
			{ length: 500 },
			(_, index) =>
				`2026-07-11,Statement row ${index},1.00,Method ${index},Vendor ${index},Center ${index}`
		).join('\n');
		const statements: string[] = [];
		const originalDebug = client.options.debug;
		client.options.debug = (_connection, query) => statements.push(query);

		let result: Awaited<ReturnType<typeof importExpenses>>;
		const startedAt = performance.now();
		try {
			result = await importExpenses(fixture.context, {
				sourceType: 'csv',
				defaultCategoryId: fixture.categoryId,
				file: new File(
					[`date,description,amount,payment_method,vendor,cost_center\n${rows}\n`],
					'statements.csv',
					{ type: 'text/csv' }
				)
			});
		} finally {
			client.options.debug = originalDebug;
		}
		const elapsedMs = performance.now() - startedAt;
		const normalized = statements.map((statement) => statement.replace(/\s+/g, ' ').trim());
		const expenseDuplicateQueries = normalized.filter(
			(statement) => statement.startsWith('select distinct') && statement.includes('from "expense"')
		);
		const expenseInsertQueries = normalized.filter((statement) =>
			statement.startsWith('insert into "expense"')
		);
		const catalogUpsertQueries = normalized.filter((statement) =>
			/insert into (payment_method|vendor|cost_center)/.test(statement)
		);

		expect(result).toMatchObject({ importedCount: 500, duplicateCount: 0, failedCount: 0 });
		// Preview and confirm each perform one bounded, server-authoritative duplicate pass.
		expect(expenseDuplicateQueries).toHaveLength(10);
		expect(expenseInsertQueries).toHaveLength(5);
		expect(catalogUpsertQueries).toHaveLength(15);
		expect(
			expenseDuplicateQueries.length + expenseInsertQueries.length + catalogUpsertQueries.length,
			'import statements should remain chunk-bounded instead of row-linear'
		).toBe(30);
		expect(elapsedMs, '500-row service import duration').toBeLessThan(5_000);
	});

	it('serializes concurrent imports in the same workspace', async () => {
		const fixture = await createWorkspaceFixture();
		const csv = 'Data;Descrição;Valor\n28/06/2026;Importação concorrente;12,50\n';

		const results = await Promise.all(
			['first.csv', 'second.csv'].map((name) =>
				importExpenses(fixture.context, {
					sourceType: 'csv',
					defaultCategoryId: fixture.categoryId,
					file: new File([csv], name, { type: 'text/csv' })
				})
			)
		);

		expect(results.reduce((total, result) => total + result.importedCount, 0)).toBe(1);
		expect(results.reduce((total, result) => total + result.duplicateCount, 0)).toBe(1);
	});

	it('does not import positive OFX credits as expenses', async () => {
		const fixture = await createWorkspaceFixture();
		const file = new File(
			[
				`<OFX><BANKTRANLIST>
					<STMTTRN><DTPOSTED>20260625120000[-3:BRT]<TRNAMT>42.35<NAME>Estorno</STMTTRN>
					<STMTTRN><DTPOSTED>20260626120000[-3:BRT]<TRNAMT>-21.10<NAME>Despesa OFX</STMTTRN>
				</BANKTRANLIST></OFX>`
			],
			'extrato.ofx',
			{ type: 'application/x-ofx' }
		);

		const result = await importExpenses(fixture.context, {
			sourceType: 'ofx',
			defaultCategoryId: fixture.categoryId,
			file
		});

		expect(result).toMatchObject({ importedCount: 1, failedCount: 1 });
		expect(result.failedRows[0]?.message).toContain('OFX transaction 1');
		const createdExpenses = await db
			.select({ description: expense.description, amountCents: expense.amountCents })
			.from(expense)
			.where(eq(expense.importBatchId, result.importBatchId));
		expect(createdExpenses).toEqual([{ description: 'Despesa OFX', amountCents: 2110 }]);
	});

	it('applies automatic category rules during imports and archives them safely', async () => {
		const fixture = await createWorkspaceFixture();
		const [supplyCategory] = await db
			.insert(category)
			.values({
				workspaceId: fixture.context.workspaceId,
				name: 'Insumos',
				color: '#2563eb',
				icon: '📦'
			})
			.returning({ id: category.id });

		const createdRule = await createCategoryRule(fixture.context, {
			name: 'Fornecedor ACME',
			categoryId: supplyCategory.id,
			matchTarget: 'vendor',
			pattern: 'acme',
			priority: 10
		});
		expect(createdRule.id).toBeGreaterThan(0);
		await expect(matchCategoryRule(fixture.context, { vendor: 'ACME Ltda' })).resolves.toBe(
			supplyCategory.id
		);
		await expect(listCategoryRules(fixture.context)).resolves.toMatchObject([
			{
				id: createdRule.id,
				categoryId: supplyCategory.id,
				matchTarget: 'vendor',
				isActive: true
			}
		]);

		const staticRules: Awaited<ReturnType<typeof getActiveRules>> = [
			{
				categoryId: fixture.categoryId,
				matchTarget: 'description',
				pattern: 'limpeza',
				patternNormalized: 'limpeza'
			},
			{
				categoryId: supplyCategory.id,
				matchTarget: 'payment',
				pattern: 'pix',
				patternNormalized: 'pix'
			}
		];
		expect(
			matchCategoryRuleFromRules(staticRules, {
				description: 'Produto de limpeza',
				paymentMethod: 'Boleto'
			})
		).toBe(fixture.categoryId);
		expect(
			matchCategoryRuleFromRules(staticRules.slice(1), {
				description: 'Sem regra',
				paymentMethod: 'Pix'
			})
		).toBe(supplyCategory.id);
		expect(matchCategoryRuleFromRules(staticRules, {})).toBeNull();

		const memberContext = await createMemberContext(fixture, 'member');
		await expect(
			createCategoryRule(memberContext, {
				name: 'Sem permissão',
				categoryId: supplyCategory.id,
				matchTarget: 'description',
				pattern: 'teste',
				priority: 100
			})
		).rejects.toMatchObject({ status: 403 });
		await expect(
			createCategoryRule(fixture.context, {
				name: 'Categoria inválida',
				categoryId: supplyCategory.id + 999_999,
				matchTarget: 'description',
				pattern: 'teste',
				priority: 100
			})
		).rejects.toMatchObject({ status: 400 });
		await expect(
			archiveCategoryRule(fixture.context, createdRule.id + 999_999)
		).rejects.toMatchObject({ status: 404 });

		const file = new File(
			[
				'Data;Descrição;Valor;Fornecedor;Centro de custo\n26/06/2026;Compra fiscal;35,50;ACME Ltda;Operação\n'
			],
			'regras.csv',
			{ type: 'text/csv' }
		);

		const result = await importExpenses(fixture.context, { sourceType: 'csv', file });

		expect(result).toMatchObject({ importedCount: 1, failedCount: 0 });
		const [createdExpense] = await db
			.select({
				categoryId: expense.categoryId,
				vendorId: expense.vendorId,
				costCenterId: expense.costCenterId,
				vendor: expense.vendor,
				costCenter: expense.costCenter,
				reviewStatus: expense.reviewStatus
			})
			.from(expense)
			.where(eq(expense.importBatchId, result.importBatchId));
		expect(createdExpense).toEqual({
			categoryId: supplyCategory.id,
			vendorId: expect.any(Number),
			costCenterId: expect.any(Number),
			vendor: 'ACME Ltda',
			costCenter: 'Operação',
			reviewStatus: 'approved'
		});

		const fallbackFile = new File(
			['Data;Descrição;Valor;Fornecedor\n27/06/2026;Compra com padrão;40,00;ACME Ltda\n'],
			'regras-com-padrao.csv',
			{ type: 'text/csv' }
		);
		const fallbackResult = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: fallbackFile
		});
		const [fallbackExpense] = await db
			.select({
				categoryId: expense.categoryId,
				description: expense.description
			})
			.from(expense)
			.where(eq(expense.importBatchId, fallbackResult.importBatchId));
		expect(fallbackExpense).toEqual({
			categoryId: supplyCategory.id,
			description: 'Compra com padrão'
		});

		await archiveCategoryRule(fixture.context, createdRule.id);
		await expect(matchCategoryRule(fixture.context, { vendor: 'ACME Ltda' })).resolves.toBeNull();
		const [archivedRule] = await db
			.select({ isActive: categoryRule.isActive })
			.from(categoryRule)
			.where(eq(categoryRule.id, createdRule.id));
		expect(archivedRule.isActive).toBe(false);
	});
}
