import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { emailVerificationThrottle, user } from '$lib/server/db/auth.schema';
import {
	auditEvent,
	attachmentDeletion,
	budgetAlertDelivery,
	budgetAlertPreference,
	budgetAlertRecipient,
	category,
	categoryBudget,
	categoryRule,
	emailDeliveryEvent,
	expense,
	expenseAttachment,
	importBatch,
	importPreview,
	paymentMethod,
	recurringExpense,
	vendor,
	workspace,
	workspaceInvitation,
	workspaceInvitationDelivery,
	workspaceMember
} from '$lib/server/db/schema';
import { client, db } from '$lib/server/db';
import { sendBudgetAlertEmail } from '$lib/server/email';
import { sha256 } from '$lib/server/utils/crypto';
import { maxMoneyCents } from '$lib/server/utils/money';
import { formatCents } from '$lib/utils/format';
import { getAttachmentForDownload, maxAttachmentBytes, saveExpenseAttachment } from './attachments';
import {
	archiveCategoryRule,
	createCategoryRule,
	getActiveRules,
	listCategoryRules,
	matchCategoryRule,
	matchCategoryRuleFromRules
} from './category-rules';
import { createCategory, listCategories, removeCategory, unarchiveCategory } from './categories';
import {
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
	upsertBudget
} from './budgets';
import { acceptInvitation, getPendingInvitation } from './invitations';
import {
	deliverInvitation,
	invitationDeliveryMaxAttempts,
	invitationDeliverySchedulerLockKey,
	runInvitationDeliveryScheduler
} from './invitation-delivery';
import {
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
	updateExpensePaymentStatus
} from './expenses';
import { expenseTrashDates, expenseTrashRetentionMs, restoreTrashedExpense } from './expense-trash';
import {
	getOrCreateCatalogItem,
	listExpenseCatalogs,
	removeExpenseCatalogItem,
	updateExpenseCatalogItem
} from './expense-catalogs';
import {
	confirmImportPreview,
	confirmedImportPreviewRetentionMs,
	importExpenses,
	importPreviewTtlMs,
	listImportBatches,
	pruneExpiredImportPreviews,
	previewImportExpenses,
	undoImportBatch
} from './imports';
import {
	parseMailjetWebhookPayload,
	pruneEmailDeliveryEvents,
	recordMailjetDeliveryEvents
} from './email-delivery-events';
import {
	createRecurringExpense,
	materializeDueRecurringExpenses,
	runRecurringExpenseScheduler,
	setRecurringExpenseStatus
} from './recurring';
import {
	pruneExpiredUnverifiedRegistrations,
	requestVerificationEmail
} from './email-verification';
import { inviteMember, resendInvitation, type WorkspaceContext } from './workspaces';

const workspaceIds: number[] = [];
const userIds: string[] = [];
const uploadDirs: string[] = [];

describe('server service integration', () => {
	afterEach(async () => {
		for (const workspaceId of workspaceIds.splice(0)) {
			await db.delete(workspace).where(eq(workspace.id, workspaceId));
			await db.delete(attachmentDeletion).where(eq(attachmentDeletion.workspaceId, workspaceId));
		}
		for (const userId of userIds.splice(0)) {
			await db.delete(user).where(eq(user.id, userId));
		}
		for (const uploadDir of uploadDirs.splice(0)) {
			await rm(uploadDir, { recursive: true, force: true });
		}
	});

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
});

async function createWorkspaceFixture() {
	const owner = await createUser('owner');
	const [workspaceRow] = await db
		.insert(workspace)
		.values({
			name: `Workspace ${randomUUID()}`,
			createdByUserId: owner.id,
			currency: 'USD'
		})
		.returning({
			id: workspace.id,
			name: workspace.name,
			weekStartsOn: workspace.weekStartsOn,
			currency: workspace.currency
		});
	workspaceIds.push(workspaceRow.id);

	await db.insert(workspaceMember).values({
		workspaceId: workspaceRow.id,
		userId: owner.id,
		role: 'owner',
		status: 'active'
	});

	const [categoryRow] = await db
		.insert(category)
		.values({
			workspaceId: workspaceRow.id,
			name: 'Limpeza',
			color: '#0f766e',
			icon: '🧼'
		})
		.returning({ id: category.id });

	const context: WorkspaceContext = {
		userId: owner.id,
		workspaceId: workspaceRow.id,
		workspaceName: workspaceRow.name,
		weekStartsOn: workspaceRow.weekStartsOn,
		currency: workspaceRow.currency,
		locale: 'en',
		role: 'owner'
	};

	return { context, categoryId: categoryRow.id };
}

async function createMemberContext(
	fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>,
	role: WorkspaceContext['role']
) {
	const member = await createUser(role);
	await db.insert(workspaceMember).values({
		workspaceId: fixture.context.workspaceId,
		userId: member.id,
		role,
		status: 'active'
	});

	return {
		...fixture.context,
		userId: member.id,
		role
	};
}

async function createExpenseCatalogs(
	context: WorkspaceContext,
	input: { paymentMethod?: string; vendor?: string; costCenter?: string }
) {
	const [paymentMethodItem, vendorItem, costCenterItem] = await Promise.all([
		input.paymentMethod
			? getOrCreateCatalogItem(db, context.workspaceId, 'paymentMethod', input.paymentMethod)
			: Promise.resolve(null),
		input.vendor
			? getOrCreateCatalogItem(db, context.workspaceId, 'vendor', input.vendor)
			: Promise.resolve(null),
		input.costCenter
			? getOrCreateCatalogItem(db, context.workspaceId, 'costCenter', input.costCenter)
			: Promise.resolve(null)
	]);

	return {
		paymentMethodId: paymentMethodItem?.id,
		vendorId: vendorItem?.id,
		costCenterId: costCenterItem?.id
	};
}

async function seedWarningBudget(fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>) {
	await upsertBudget(fixture.context, {
		categoryId: fixture.categoryId,
		periodMonth: '2026-06',
		amount: '100.00',
		warningThresholdPct: 80
	});
	await createExpense(fixture.context, {
		categoryId: fixture.categoryId,
		description: `Budget alert ${randomUUID()}`,
		amount: '90.00',
		expenseDate: '2026-06-15'
	});
}

async function createUser(prefix: string, options: { emailVerified?: boolean } = {}) {
	const id = `${prefix}-${randomUUID()}`;
	const email = `${id}@example.com`;
	await db.insert(user).values({
		id,
		name: prefix,
		email,
		emailVerified: options.emailVerified ?? true
	});
	userIds.push(id);
	return { id, email };
}

async function findUserById(userId: string) {
	const [row] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
	return row ?? null;
}

async function findWorkspaceById(workspaceId: number) {
	const [row] = await db
		.select({ id: workspace.id })
		.from(workspace)
		.where(eq(workspace.id, workspaceId))
		.limit(1);
	return row ?? null;
}
