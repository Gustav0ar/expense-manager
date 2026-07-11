import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { user } from '$lib/server/db/auth.schema';
import { client, db } from '$lib/server/db';
import {
	attachmentDeletion,
	auditEvent,
	category,
	expense,
	expenseAttachment,
	paymentMethod,
	recurringExpense,
	workspace,
	workspaceMember
} from '$lib/server/db/schema';
import {
	deleteExpenseAttachment,
	getUploadDir,
	saveExpenseAttachment,
	safeStoragePath
} from './attachments';
import { runAttachmentDeletionWorker } from './attachment-deletion';
import { deleteExpense, getAnalyticalExpenseReport, getDashboard } from './expenses';
import { listReconciliationQueue, stageOfxTransactions } from './reconciliation';
import {
	expenseTrashRetentionMs,
	expenseTrashPurgeLockKey,
	listTrashedExpenses,
	purgeTrashedExpense,
	restoreTrashedExpense,
	runExpenseTrashPurgeWorker
} from './expense-trash';
import type { WorkspaceContext } from './workspaces';

const workspaceIds: number[] = [];
const userIds: string[] = [];
const storageRoots: string[] = [];

describe('recoverable expense trash', () => {
	afterEach(async () => {
		delete process.env.UPLOAD_DIR;
		for (const workspaceId of workspaceIds.splice(0)) {
			await db.delete(workspace).where(eq(workspace.id, workspaceId));
			await db.delete(attachmentDeletion).where(eq(attachmentDeletion.workspaceId, workspaceId));
		}
		for (const userId of userIds.splice(0)) await db.delete(user).where(eq(user.id, userId));
		for (const root of storageRoots.splice(0)) await rm(root, { recursive: true, force: true });
	});

	it('moves an expense and attachment into retained trash and restores both atomically', async () => {
		const fixture = await createFixture();
		const saved = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['receipt-body'], 'receipt.txt', { type: 'text/plain' })
		);
		await deleteExpense(fixture.context, fixture.expenseId);

		const [trashed] = await db
			.select({ deletedAt: expense.deletedAt, expiresAt: expense.trashExpiresAt })
			.from(expense)
			.where(eq(expense.id, fixture.expenseId));
		expect(trashed.deletedAt).not.toBeNull();
		expect(trashed.expiresAt!.getTime() - trashed.deletedAt!.getTime()).toBe(
			expenseTrashRetentionMs
		);
		const [intent] = await db
			.select()
			.from(attachmentDeletion)
			.where(eq(attachmentDeletion.attachmentId, saved!.id));
		expect(intent).toMatchObject({ reason: 'expense_trash', status: 'pending' });
		expect(intent.notBefore.getTime()).toBe(trashed.expiresAt!.getTime() + 48 * 60 * 60 * 1000);
		expect((await listTrashedExpenses(fixture.context)).items).toHaveLength(1);
		await expect(
			runAttachmentDeletionWorker({
				now: new Date(trashed.deletedAt!.getTime() + 1),
				workspaceId: fixture.context.workspaceId,
				uploadDir: getUploadDir(),
				removeFile: async () => {
					throw new Error('a restorable file must not be claimed');
				},
				reconcile: false
			})
		).resolves.toMatchObject({ processed: 0, completed: 0 });

		await restoreTrashedExpense(fixture.context, fixture.expenseId, new Date());
		const [restored] = await db
			.select({ deletedAt: expense.deletedAt, expiresAt: expense.trashExpiresAt })
			.from(expense)
			.where(eq(expense.id, fixture.expenseId));
		expect(restored).toEqual({ deletedAt: null, expiresAt: null });
		const [restoredAttachment] = await db
			.select({ deletedAt: expenseAttachment.deletedAt })
			.from(expenseAttachment)
			.where(eq(expenseAttachment.id, saved!.id));
		expect(restoredAttachment.deletedAt).toBeNull();
		expect(
			await db
				.select()
				.from(attachmentDeletion)
				.where(eq(attachmentDeletion.attachmentId, saved!.id))
		).toHaveLength(0);
		expect(
			await db
				.select()
				.from(auditEvent)
				.where(
					and(
						eq(auditEvent.workspaceId, fixture.context.workspaceId),
						eq(auditEvent.action, 'expense.restored')
					)
				)
		).toHaveLength(1);
	});

	it('rejects an exact-boundary, corrupt, cross-workspace or underprivileged restore without partial changes', async () => {
		const fixture = await createFixture();
		const saved = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['original'], 'receipt.txt', { type: 'text/plain' })
		);
		await deleteExpense(fixture.context, fixture.expenseId);
		const [row] = await db
			.select({ expiresAt: expense.trashExpiresAt })
			.from(expense)
			.where(eq(expense.id, fixture.expenseId));

		await expect(
			restoreTrashedExpense({ ...fixture.context, role: 'member' }, fixture.expenseId, new Date())
		).rejects.toMatchObject({ status: 403 });
		await expect(
			restoreTrashedExpense(
				{ ...fixture.context, workspaceId: fixture.context.workspaceId + 999 },
				fixture.expenseId,
				new Date()
			)
		).rejects.toMatchObject({ status: 404 });
		await expect(
			restoreTrashedExpense(fixture.context, fixture.expenseId, row.expiresAt!)
		).rejects.toMatchObject({ status: 409 });

		const [attachment] = await db
			.select({ storageKey: expenseAttachment.storageKey })
			.from(expenseAttachment)
			.where(eq(expenseAttachment.id, saved!.id));
		await writeFile(safeStoragePath(getUploadDir(), attachment.storageKey), 'tampered');
		await expect(
			restoreTrashedExpense(
				fixture.context,
				fixture.expenseId,
				new Date(row.expiresAt!.getTime() - 1)
			)
		).rejects.toMatchObject({ status: 409 });
		const [stillTrashed] = await db
			.select({ deletedAt: expense.deletedAt })
			.from(expense)
			.where(eq(expense.id, fixture.expenseId));
		expect(stillTrashed.deletedAt).not.toBeNull();
		expect(
			await db
				.select()
				.from(attachmentDeletion)
				.where(eq(attachmentDeletion.attachmentId, saved!.id))
		).toHaveLength(1);
	});

	it('repairs a missing attachment intent before bounded purge and remains idempotent', async () => {
		const fixture = await createFixture();
		const saved = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['retained'], 'receipt.txt', { type: 'text/plain' })
		);
		await deleteExpense(fixture.context, fixture.expenseId);
		const now = new Date('2026-09-01T00:00:00.000Z');
		await db.update(expense).set({ trashExpiresAt: now }).where(eq(expense.id, fixture.expenseId));
		await db.delete(attachmentDeletion).where(eq(attachmentDeletion.attachmentId, saved!.id));

		await expect(
			purgeTrashedExpense(fixture.context, fixture.expenseId, now)
		).resolves.toMatchObject({
			purged: 1
		});
		expect(await db.select().from(expense).where(eq(expense.id, fixture.expenseId))).toHaveLength(
			0
		);
		const [repaired] = await db
			.select()
			.from(attachmentDeletion)
			.where(eq(attachmentDeletion.attachmentId, saved!.id));
		expect(repaired).toMatchObject({ reason: 'expense_trash', status: 'pending' });
		expect(repaired.notBefore.toISOString()).toBe('2026-09-03T00:00:00.000Z');
		await expect(
			runExpenseTrashPurgeWorker({ now, workspaceId: fixture.context.workspaceId })
		).resolves.toMatchObject({ purged: 0, skipped: false });
	});

	it('allows only expired rows to be purged and keeps early purge behind delete-equivalent guards', async () => {
		const fixture = await createFixture();
		await deleteExpense(fixture.context, fixture.expenseId);
		const [row] = await db
			.select({ expiresAt: expense.trashExpiresAt })
			.from(expense)
			.where(eq(expense.id, fixture.expenseId));
		await expect(
			purgeTrashedExpense(
				{ ...fixture.context, role: 'member' },
				fixture.expenseId,
				new Date(row.expiresAt!.getTime() + 1)
			)
		).rejects.toMatchObject({ status: 403 });
		await expect(
			purgeTrashedExpense(
				fixture.context,
				fixture.expenseId,
				new Date(row.expiresAt!.getTime() - 1)
			)
		).rejects.toMatchObject({ status: 409 });
	});

	it('enforces the live recurring materialization policy in both orderings', async () => {
		const fixture = await createFixture();
		const [schedule] = await db
			.insert(recurringExpense)
			.values({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Monthly source',
				amountCents: 1234,
				currency: 'USD',
				startDate: '2026-07-10',
				nextRunDate: '2026-08-10'
			})
			.returning({ id: recurringExpense.id });
		await db
			.update(expense)
			.set({ sourceRecurringExpenseId: schedule.id })
			.where(eq(expense.id, fixture.expenseId));
		await deleteExpense(fixture.context, fixture.expenseId);
		const [replacement] = await db
			.insert(expense)
			.values({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Replacement',
				amountCents: 1234,
				expenseDate: '2026-07-10',
				sourceRecurringExpenseId: schedule.id
			})
			.returning({ id: expense.id });
		await expect(restoreTrashedExpense(fixture.context, fixture.expenseId)).rejects.toMatchObject({
			status: 409
		});

		await db.delete(expense).where(eq(expense.id, replacement.id));
		await restoreTrashedExpense(fixture.context, fixture.expenseId);
		await expect(
			db.insert(expense).values({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Racing replacement',
				amountCents: 1234,
				expenseDate: '2026-07-10',
				sourceRecurringExpenseId: schedule.id
			})
		).rejects.toMatchObject({ cause: { code: '23505' } });
	});

	it('revalidates active category, catalog and workspace currency references', async () => {
		const fixture = await createFixture();
		const [method] = await db
			.insert(paymentMethod)
			.values({ workspaceId: fixture.context.workspaceId, name: 'Card' })
			.returning({ id: paymentMethod.id });
		await db
			.update(expense)
			.set({ paymentMethodId: method.id, paymentMethod: 'Card' })
			.where(eq(expense.id, fixture.expenseId));
		await deleteExpense(fixture.context, fixture.expenseId);

		await db.update(category).set({ isArchived: true }).where(eq(category.id, fixture.categoryId));
		await expect(restoreTrashedExpense(fixture.context, fixture.expenseId)).rejects.toMatchObject({
			status: 409
		});
		await db.update(category).set({ isArchived: false }).where(eq(category.id, fixture.categoryId));
		await db.update(paymentMethod).set({ isArchived: true }).where(eq(paymentMethod.id, method.id));
		await expect(restoreTrashedExpense(fixture.context, fixture.expenseId)).rejects.toMatchObject({
			status: 409
		});
		await db
			.update(paymentMethod)
			.set({ isArchived: false })
			.where(eq(paymentMethod.id, method.id));
		await expect(
			restoreTrashedExpense({ ...fixture.context, currency: 'BRL' }, fixture.expenseId)
		).rejects.toMatchObject({ status: 409 });
	});

	it('excludes trash from dashboard, analytical reports and reconciliation candidates', async () => {
		const fixture = await createFixture();
		expect((await getDashboard(fixture.context, '2026-07-01', '2026-07-31')).totalCents).toBe(1234);
		expect(
			(
				await getAnalyticalExpenseReport(fixture.context, {
					from: '2026-07-01',
					to: '2026-07-31'
				})
			).items
		).toHaveLength(1);
		await stageOfxTransactions(
			fixture.context,
			new File(
				[
					'<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>001<ACCTID>trash-isolation</BANKACCTFROM><BANKTRANLIST><STMTTRN><DTPOSTED>20260710<TRNAMT>-12.34<FITID>trash-candidate<NAME>Recoverable expense</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>'
				],
				'trash.ofx',
				{ type: 'application/x-ofx' }
			)
		);
		expect((await listReconciliationQueue(fixture.context))[0].candidates).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: fixture.expenseId })])
		);

		await deleteExpense(fixture.context, fixture.expenseId);
		expect((await getDashboard(fixture.context, '2026-07-01', '2026-07-31')).totalCents).toBe(0);
		expect(
			(
				await getAnalyticalExpenseReport(fixture.context, {
					from: '2026-07-01',
					to: '2026-07-31'
				})
			).items
		).toHaveLength(0);
		expect((await listReconciliationQueue(fixture.context))[0].candidates).toHaveLength(0);
	});

	it('serializes restore against purge at the exact expiry boundary without partial artifacts', async () => {
		const fixture = await createFixture();
		const saved = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['boundary'], 'boundary.txt', { type: 'text/plain' })
		);
		await deleteExpense(fixture.context, fixture.expenseId);
		const boundary = new Date('2026-09-01T00:00:00.000Z');
		await db
			.update(expense)
			.set({ trashExpiresAt: boundary })
			.where(eq(expense.id, fixture.expenseId));

		const [restoreResult, purgeResult] = await Promise.allSettled([
			restoreTrashedExpense(fixture.context, fixture.expenseId, boundary),
			purgeTrashedExpense(fixture.context, fixture.expenseId, boundary)
		]);
		expect(restoreResult).toMatchObject({ status: 'rejected', reason: { status: 409 } });
		expect(purgeResult).toMatchObject({ status: 'fulfilled', value: { purged: 1 } });
		expect(await db.select().from(expense).where(eq(expense.id, fixture.expenseId))).toHaveLength(
			0
		);
		const [intent] = await db
			.select()
			.from(attachmentDeletion)
			.where(eq(attachmentDeletion.attachmentId, saved!.id));
		expect(intent).toMatchObject({ status: 'pending', reason: 'expense_trash' });
		await expect(stat(safeStoragePath(getUploadDir(), intent.storageKey))).resolves.toMatchObject({
			size: 8
		});
		const events = await db
			.select({ action: auditEvent.action })
			.from(auditEvent)
			.where(eq(auditEvent.workspaceId, fixture.context.workspaceId));
		expect(events.filter((event) => event.action === 'expense.purged')).toHaveLength(1);
		expect(events.filter((event) => event.action === 'expense.restored')).toHaveLength(0);
	});

	it('maps per-row member permissions and preserves independently deleted attachments', async () => {
		const fixture = await createFixture();
		await expect(listTrashedExpenses({ ...fixture.context, role: 'viewer' })).rejects.toMatchObject(
			{ status: 403 }
		);
		const saved = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['independent'], 'independent.txt', { type: 'text/plain' })
		);
		await deleteExpenseAttachment(fixture.context, saved!.id);
		await deleteExpense(fixture.context, fixture.expenseId);
		expect(
			(await listTrashedExpenses({ ...fixture.context, role: 'member' })).items[0].canRestore
		).toBe(false);
		await db
			.update(expense)
			.set({ reviewStatus: 'pending', reviewedAt: null, reviewedByUserId: null })
			.where(eq(expense.id, fixture.expenseId));
		expect(
			(await listTrashedExpenses({ ...fixture.context, role: 'member' })).items[0].canRestore
		).toBe(true);
		await restoreTrashedExpense({ ...fixture.context, role: 'member' }, fixture.expenseId);
		const [attachment] = await db
			.select({ deletedAt: expenseAttachment.deletedAt })
			.from(expenseAttachment)
			.where(eq(expenseAttachment.id, saved!.id));
		expect(attachment.deletedAt).not.toBeNull();
		expect(
			await db
				.select()
				.from(attachmentDeletion)
				.where(eq(attachmentDeletion.attachmentId, saved!.id))
		).toHaveLength(1);
	});

	it('paginates more than 100 rows without gaps across timestamp ties and scopes cursors', async () => {
		const fixture = await createFixture();
		const deletedAt = new Date('2026-07-20T12:00:00.000Z');
		const trashExpiresAt = new Date(deletedAt.getTime() + expenseTrashRetentionMs);
		await db
			.update(expense)
			.set({ deletedAt, trashExpiresAt })
			.where(eq(expense.id, fixture.expenseId));
		const inserted = await db
			.insert(expense)
			.values(
				Array.from({ length: 104 }, (_, index) => ({
					workspaceId: fixture.context.workspaceId,
					categoryId: fixture.categoryId,
					createdByUserId: fixture.context.userId,
					description: `Paginated trash ${index + 1}`,
					amountCents: 100 + index,
					expenseDate: '2026-07-20',
					deletedAt,
					trashExpiresAt
				}))
			)
			.returning({ id: expense.id });
		const expectedIds = [fixture.expenseId, ...inserted.map((row) => row.id)].sort((a, b) => b - a);

		const first = await listTrashedExpenses(fixture.context);
		expect(first.items.map((item) => item.id)).toEqual(expectedIds.slice(0, 100));
		expect(first).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });

		const second = await listTrashedExpenses(fixture.context, { cursor: first.nextCursor! });
		expect(second.items.map((item) => item.id)).toEqual(expectedIds.slice(100));
		expect(second).toMatchObject({ hasMore: false, nextCursor: null });
		expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(105);

		await expect(
			listTrashedExpenses(
				{ ...fixture.context, workspaceId: fixture.context.workspaceId + 1 },
				{ cursor: first.nextCursor! }
			)
		).rejects.toMatchObject({ status: 400 });
		await expect(
			listTrashedExpenses({ ...fixture.context, locale: 'pt-BR' }, { cursor: 'not-a-valid-cursor' })
		).rejects.toMatchObject({
			status: 400,
			body: { message: 'O cursor da lixeira é inválido.' }
		});
	});

	it('rejects missing and claimed trash attachment intents', async () => {
		const missing = await createFixture();
		const missingAttachment = await saveExpenseAttachment(
			missing.context,
			missing.expenseId,
			new File(['missing'], 'missing.txt', { type: 'text/plain' })
		);
		await deleteExpense(missing.context, missing.expenseId);
		await db
			.delete(attachmentDeletion)
			.where(eq(attachmentDeletion.attachmentId, missingAttachment!.id));
		await expect(restoreTrashedExpense(missing.context, missing.expenseId)).rejects.toMatchObject({
			status: 409
		});

		const claimed = await createFixture();
		const claimedAttachment = await saveExpenseAttachment(
			claimed.context,
			claimed.expenseId,
			new File(['claimed'], 'claimed.txt', { type: 'text/plain' })
		);
		await deleteExpense(claimed.context, claimed.expenseId);
		await db
			.update(attachmentDeletion)
			.set({ status: 'processing', claimToken: 'test-claim', claimExpiresAt: new Date() })
			.where(eq(attachmentDeletion.attachmentId, claimedAttachment!.id));
		await expect(restoreTrashedExpense(claimed.context, claimed.expenseId)).rejects.toMatchObject({
			status: 409
		});

		const absent = await createFixture();
		const absentAttachment = await saveExpenseAttachment(
			absent.context,
			absent.expenseId,
			new File(['absent'], 'absent.txt', { type: 'text/plain' })
		);
		await deleteExpense(absent.context, absent.expenseId);
		const [absentRow] = await db
			.select({ storageKey: expenseAttachment.storageKey })
			.from(expenseAttachment)
			.where(eq(expenseAttachment.id, absentAttachment!.id));
		await rm(safeStoragePath(getUploadDir(), absentRow.storageKey));
		await expect(restoreTrashedExpense(absent.context, absent.expenseId)).rejects.toMatchObject({
			status: 409
		});
	});

	it('covers purge permission, missing-row and advisory-lock skip outcomes', async () => {
		const fixture = await createFixture();
		await expect(
			runExpenseTrashPurgeWorker({
				now: new Date('2026-01-01T00:00:00.000Z'),
				workspaceId: fixture.context.workspaceId
			})
		).resolves.toEqual({ purged: 0, skipped: false });
		await expect(
			restoreTrashedExpense({ ...fixture.context, role: 'viewer' }, fixture.expenseId)
		).rejects.toMatchObject({ status: 403 });
		await expect(
			purgeTrashedExpense({ ...fixture.context, role: 'viewer' }, fixture.expenseId)
		).rejects.toMatchObject({ status: 403 });
		await expect(purgeTrashedExpense(fixture.context, fixture.expenseId)).rejects.toMatchObject({
			status: 404
		});
		await db
			.update(expense)
			.set({ reviewStatus: 'pending', paymentStatus: 'paid', paidAt: '2026-07-10' })
			.where(eq(expense.id, fixture.expenseId));
		await deleteExpense(fixture.context, fixture.expenseId);
		const boundary = new Date('2026-09-01T00:00:00.000Z');
		await db
			.update(expense)
			.set({ trashExpiresAt: boundary })
			.where(eq(expense.id, fixture.expenseId));
		await expect(
			purgeTrashedExpense({ ...fixture.context, role: 'member' }, fixture.expenseId, boundary)
		).rejects.toMatchObject({ status: 403 });

		const reserved = await client.reserve();
		try {
			await reserved`select pg_advisory_lock(${expenseTrashPurgeLockKey})`;
			await expect(
				runExpenseTrashPurgeWorker({
					now: boundary,
					limit: 0,
					workspaceId: fixture.context.workspaceId
				})
			).resolves.toEqual({ purged: 0, skipped: true });
			await expect(
				purgeTrashedExpense(fixture.context, fixture.expenseId, boundary)
			).rejects.toMatchObject({ status: 409 });
		} finally {
			await reserved`select pg_advisory_unlock(${expenseTrashPurgeLockKey})`;
			reserved.release();
		}
	});

	it('translates the database recurring uniqueness race during restore', async () => {
		const fixture = await createFixture();
		const [schedule] = await db
			.insert(recurringExpense)
			.values({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Race source',
				amountCents: 1234,
				currency: 'USD',
				startDate: '2026-07-10',
				nextRunDate: '2026-08-10'
			})
			.returning({ id: recurringExpense.id });
		await db
			.update(expense)
			.set({ sourceRecurringExpenseId: schedule.id })
			.where(eq(expense.id, fixture.expenseId));
		await deleteExpense(fixture.context, fixture.expenseId);
		await expect(
			restoreTrashedExpense(fixture.context, fixture.expenseId, new Date(), {
				onBeforeRestoreUpdate: async () => {
					await db.insert(expense).values({
						workspaceId: fixture.context.workspaceId,
						categoryId: fixture.categoryId,
						createdByUserId: fixture.context.userId,
						description: 'Concurrent replacement',
						amountCents: 1234,
						expenseDate: '2026-07-10',
						sourceRecurringExpenseId: schedule.id
					});
				}
			})
		).rejects.toMatchObject({ status: 409 });
	});
});

async function createFixture() {
	const storageRoot = await mkdtemp(path.join(tmpdir(), 'expense-trash-'));
	const uploadDir = path.join(storageRoot, 'uploads');
	await mkdir(uploadDir);
	storageRoots.push(storageRoot);
	process.env.UPLOAD_DIR = uploadDir;

	const userId = `trash-${randomUUID()}`;
	await db.insert(user).values({
		id: userId,
		name: 'Trash owner',
		email: `${userId}@example.com`,
		emailVerified: true
	});
	userIds.push(userId);
	const [workspaceRow] = await db
		.insert(workspace)
		.values({ name: `Trash ${randomUUID()}`, createdByUserId: userId, currency: 'USD' })
		.returning({
			id: workspace.id,
			name: workspace.name,
			currency: workspace.currency,
			weekStartsOn: workspace.weekStartsOn
		});
	workspaceIds.push(workspaceRow.id);
	await db.insert(workspaceMember).values({
		workspaceId: workspaceRow.id,
		userId,
		role: 'owner',
		status: 'active'
	});
	const [categoryRow] = await db
		.insert(category)
		.values({ workspaceId: workspaceRow.id, name: 'Trash category', color: '#123456' })
		.returning({ id: category.id });
	const [expenseRow] = await db
		.insert(expense)
		.values({
			workspaceId: workspaceRow.id,
			categoryId: categoryRow.id,
			createdByUserId: userId,
			description: 'Recoverable expense',
			amountCents: 1234,
			expenseDate: '2026-07-10'
		})
		.returning({ id: expense.id });
	const context: WorkspaceContext = {
		userId,
		workspaceId: workspaceRow.id,
		workspaceName: workspaceRow.name,
		currency: workspaceRow.currency,
		weekStartsOn: workspaceRow.weekStartsOn,
		locale: 'en',
		role: 'owner'
	};
	return { context, expenseId: expenseRow.id, categoryId: categoryRow.id };
}
