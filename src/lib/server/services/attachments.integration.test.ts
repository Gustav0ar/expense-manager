import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { user } from '$lib/server/db/auth.schema';
import {
	attachmentDeletion,
	category,
	expense,
	expenseAttachment,
	workspace,
	workspaceMember
} from '$lib/server/db/schema';
import { client, db } from '$lib/server/db';
import {
	attachmentContentDisposition,
	deleteExpenseAttachment,
	getAttachmentForDownload,
	getUploadDir,
	isAllowedAttachmentType,
	maxAttachmentBytes,
	safeStoragePath,
	sanitizeFileName,
	saveExpenseAttachment
} from './attachments';
import {
	attachmentDeletionGraceMs,
	attachmentDeletionMaxAttempts,
	attachmentStorageLockKey,
	classifyAttachmentDeletionError,
	reconcileAttachmentStorage,
	resolveAttachmentWorkerWorkspaceId,
	runAttachmentDeletionWorker
} from './attachment-deletion';
import type { WorkspaceContext } from './workspaces';

const workspaceIds: number[] = [];
const userIds: string[] = [];
const uploadDirs: string[] = [];

describe('attachment service integration', () => {
	afterEach(async () => {
		delete process.env.UPLOAD_DIR;
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

	it('normalizes names, content types, content disposition and storage boundaries', () => {
		expect(isAllowedAttachmentType('IMAGE/PNG')).toBe(true);
		expect(isAllowedAttachmentType('application/zip')).toBe(false);
		expect(sanitizeFileName('  comprovante ação № 1.pdf ')).toBe('comprovante-acao-No-1.pdf');
		expect(sanitizeFileName('💥')).toBe('receipt');
		expect(sanitizeFileName(`${'a'.repeat(130)}.txt`)).toHaveLength(120);
		expect(attachmentContentDisposition('invoice "July".pdf')).toBe(
			'attachment; filename="invoice-July.pdf"'
		);
		expect(safeStoragePath('/tmp/uploads', '1/2/receipt.txt')).toBe(
			path.resolve('/tmp/uploads/1/2/receipt.txt')
		);
		expect(() => safeStoragePath('/tmp/uploads', '../secret.txt')).toThrow();
		expect(classifyAttachmentDeletionError({ status: 400 })).toBe('path_invalid');
		expect(
			classifyAttachmentDeletionError(Object.assign(new Error('denied'), { code: 'EPERM' }))
		).toBe('permission');
		expect(classifyAttachmentDeletionError(new Error('generic I/O failure'))).toBe('io');
		expect(classifyAttachmentDeletionError(new Error('attachment path is invalid'))).toBe(
			'path_invalid'
		);
		expect(classifyAttachmentDeletionError('unexpected')).toBe('unknown');
		process.env.ATTACHMENT_WORKER_TEST_WORKSPACE_ID = '123';
		delete process.env.ATTACHMENT_WORKER_TEST_SCOPE_SENTINEL;
		expect(resolveAttachmentWorkerWorkspaceId()).toBeUndefined();
		process.env.ATTACHMENT_WORKER_TEST_SCOPE_SENTINEL = 'infrastructure-test-only';
		expect(resolveAttachmentWorkerWorkspaceId()).toBe(123);
		delete process.env.ATTACHMENT_WORKER_TEST_WORKSPACE_ID;
		delete process.env.ATTACHMENT_WORKER_TEST_SCOPE_SENTINEL;
	});

	it('skips while the backup owns the storage advisory lock', async () => {
		const reserved = await client.reserve();
		try {
			await reserved`select pg_advisory_lock(${attachmentStorageLockKey})`;
			await expect(runAttachmentDeletionWorker()).resolves.toMatchObject({
				processed: 0,
				completed: 0,
				failed: 0,
				pending: 0,
				skipped: true
			});
		} finally {
			await reserved`select pg_advisory_unlock(${attachmentStorageLockKey})`;
			reserved.release();
		}
	});

	it('handles empty, unauthorized and missing-expense uploads without writing files', async () => {
		const fixture = await createFixture();
		await expect(
			saveExpenseAttachment(
				{ ...fixture.context, role: 'viewer' },
				fixture.expenseId,
				new File(['x'], 'x.txt', { type: 'text/plain' })
			)
		).rejects.toMatchObject({ status: 403 });
		await expect(
			saveExpenseAttachment(
				fixture.context,
				2_147_483_647,
				new File(['x'], 'x.txt', { type: 'text/plain' })
			)
		).rejects.toMatchObject({ status: 404 });
		await expect(
			saveExpenseAttachment(
				fixture.context,
				fixture.expenseId,
				new File([], 'empty.txt', { type: 'text/plain' })
			)
		).resolves.toBeNull();
		expect(await readdir(process.env.UPLOAD_DIR!)).toEqual([]);
	});

	it('deletes stored attachments and reports missing files and records', async () => {
		const fixture = await createFixture();
		const saved = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['receipt body'], 'receipt.txt', { type: 'text/plain' })
		);
		expect(saved).not.toBeNull();
		const download = await getAttachmentForDownload(fixture.context, saved!.id);
		expect(download.contentLength).toBe(12);
		expect(await new Response(download.stream).text()).toBe('receipt body');

		await expect(
			deleteExpenseAttachment({ ...fixture.context, role: 'viewer' }, saved!.id)
		).rejects.toMatchObject({ status: 403 });
		await expect(deleteExpenseAttachment(fixture.context, saved!.id)).resolves.toBeUndefined();
		await expect(getAttachmentForDownload(fixture.context, saved!.id)).rejects.toMatchObject({
			status: 404
		});
		const [intent] = await db
			.select({ storageKey: attachmentDeletion.storageKey, status: attachmentDeletion.status })
			.from(attachmentDeletion)
			.where(eq(attachmentDeletion.attachmentId, saved!.id));
		expect(intent.status).toBe('pending');
		const retainedPath = safeStoragePath(getUploadDir(), intent.storageKey);
		await expect(stat(retainedPath)).resolves.toMatchObject({ size: 12 });
		await expect(
			runAttachmentWorkerUntilAcquired({
				now: new Date(Date.now() + attachmentDeletionGraceMs + 1),
				workspaceId: fixture.context.workspaceId,
				reconcile: false
			})
		).resolves.toMatchObject({ processed: 1, completed: 1, failed: 0 });
		await expect(stat(retainedPath)).rejects.toMatchObject({ code: 'ENOENT' });
		await expect(deleteExpenseAttachment(fixture.context, saved!.id)).rejects.toMatchObject({
			status: 404
		});

		const missingFile = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['gone'], 'gone.txt', { type: 'text/plain' })
		);
		await rm(
			safeStoragePath(getUploadDir(), `${fixture.context.workspaceId}/${fixture.expenseId}`),
			{
				recursive: true,
				force: true
			}
		);
		await expect(getAttachmentForDownload(fixture.context, missingFile!.id)).rejects.toMatchObject({
			status: 404
		});
		await deleteExpenseAttachment(fixture.context, missingFile!.id);
		await expect(
			runAttachmentDeletionWorker({
				now: new Date(Date.now() + attachmentDeletionGraceMs + 1),
				workspaceId: fixture.context.workspaceId,
				reconcile: false
			})
		).resolves.toMatchObject({ processed: 1, completed: 1, failed: 0 });
	});

	it('removes temporary and final files when streaming or persistence fails', async () => {
		const fixture = await createFixture();
		const streamedOversize = {
			name: 'streamed.txt',
			type: 'text/plain',
			size: 1,
			stream: () => new Blob([new Uint8Array(maxAttachmentBytes + 1)]).stream()
		} as File;
		await expect(
			saveExpenseAttachment(fixture.context, fixture.expenseId, streamedOversize)
		).rejects.toMatchObject({ status: 400 });

		await expect(
			saveExpenseAttachment(
				{ ...fixture.context, userId: `missing-${randomUUID()}` },
				fixture.expenseId,
				new File(['db failure'], 'failure.txt', { type: 'text/plain' })
			)
		).rejects.toThrow();
		const entries = await readdir(process.env.UPLOAD_DIR!, { recursive: true });
		expect(entries.some((entry) => entry.endsWith('.tmp') || entry.endsWith('.txt'))).toBe(false);
	});

	it('rolls back the tombstone and intent when the audit write fails', async () => {
		const fixture = await createFixture();
		const saved = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['rollback'], 'rollback.txt', { type: 'text/plain' })
		);

		await expect(
			deleteExpenseAttachment({ ...fixture.context, userId: `missing-${randomUUID()}` }, saved!.id)
		).rejects.toThrow();
		await expect(
			db
				.select({ deletedAt: expenseAttachment.deletedAt })
				.from(expenseAttachment)
				.where(eq(expenseAttachment.id, saved!.id))
		).resolves.toEqual([{ deletedAt: null }]);
		await expect(
			db
				.select({ id: attachmentDeletion.id })
				.from(attachmentDeletion)
				.where(eq(attachmentDeletion.attachmentId, saved!.id))
		).resolves.toEqual([]);
	});

	it('retries permission failures to the cap without losing the retained file', async () => {
		const fixture = await createFixture();
		const saved = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['protected'], 'protected.txt', { type: 'text/plain' })
		);
		await deleteExpenseAttachment(fixture.context, saved!.id);
		const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
		const firstDue = Date.now() + attachmentDeletionGraceMs + 1;
		const permissionError = Object.assign(new Error('denied'), { code: 'EACCES' });

		for (let attempt = 0; attempt < attachmentDeletionMaxAttempts * 10; attempt++) {
			const result = await runAttachmentDeletionWorker({
				now: new Date(firstDue + attempt * 24 * 60 * 60 * 1000),
				workspaceId: fixture.context.workspaceId,
				removeFile: async () => {
					throw permissionError;
				},
				reconcile: false
			});
			if ('skipped' in result && result.skipped)
				await new Promise<void>((resolve) => setImmediate(resolve));
			const [state] = await db
				.select({ status: attachmentDeletion.status })
				.from(attachmentDeletion)
				.where(eq(attachmentDeletion.attachmentId, saved!.id));
			if (state.status === 'failed') break;
		}

		const [intent] = await db
			.select({
				status: attachmentDeletion.status,
				attemptCount: attachmentDeletion.attemptCount,
				category: attachmentDeletion.lastErrorCategory,
				storageKey: attachmentDeletion.storageKey
			})
			.from(attachmentDeletion)
			.where(eq(attachmentDeletion.attachmentId, saved!.id));
		expect(intent).toMatchObject({
			status: 'failed',
			attemptCount: attachmentDeletionMaxAttempts,
			category: 'permission'
		});
		await expect(stat(safeStoragePath(getUploadDir(), intent.storageKey))).resolves.toBeDefined();
		expect(logger).toHaveBeenCalledTimes(attachmentDeletionMaxAttempts);
		logger.mockRestore();
	});

	it('serializes concurrent workers and rejects a traversal key without touching outside files', async () => {
		const fixture = await createFixture();
		const saved = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['concurrent'], 'concurrent.txt', { type: 'text/plain' })
		);
		await deleteExpenseAttachment(fixture.context, saved!.id);
		const due = new Date(Date.now() + attachmentDeletionGraceMs + 1);
		let removals = 0;
		const results = await Promise.all([
			runAttachmentWorkerUntilAcquired({
				now: due,
				workspaceId: fixture.context.workspaceId,
				removeFile: async (filePath) => {
					removals++;
					await rm(filePath);
				},
				reconcile: false
			}),
			runAttachmentWorkerUntilAcquired({
				now: due,
				workspaceId: fixture.context.workspaceId,
				reconcile: false
			})
		]);
		expect(results.reduce((sum, result) => sum + result.completed, 0)).toBe(1);
		expect(removals).toBe(1);

		const traversal = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['traversal'], 'traversal.txt', { type: 'text/plain' })
		);
		await deleteExpenseAttachment(fixture.context, traversal!.id);
		const sentinel = path.resolve(getUploadDir(), '..', 'keep.txt');
		await writeFile(sentinel, 'keep');
		await db
			.update(attachmentDeletion)
			.set({ storageKey: '../keep.txt' })
			.where(eq(attachmentDeletion.attachmentId, traversal!.id));
		const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
		await runAttachmentWorkerUntilAcquired({
			now: new Date(due.getTime() + 60_000),
			workspaceId: fixture.context.workspaceId,
			reconcile: false
		});
		await expect(stat(sentinel)).resolves.toMatchObject({ size: 4 });
		await expect(
			db
				.select({ category: attachmentDeletion.lastErrorCategory })
				.from(attachmentDeletion)
				.where(eq(attachmentDeletion.attachmentId, traversal!.id))
		).resolves.toEqual([{ category: 'path_invalid' }]);
		logger.mockRestore();
	});

	it('enqueues an intent when a hard-delete cascade removes attachment metadata', async () => {
		const fixture = await createFixture();
		const saved = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['cascade'], 'cascade.txt', { type: 'text/plain' })
		);
		await db.delete(expense).where(eq(expense.id, fixture.expenseId));

		await expect(
			db
				.select({ id: expenseAttachment.id })
				.from(expenseAttachment)
				.where(eq(expenseAttachment.id, saved!.id))
		).resolves.toEqual([]);
		const [intent] = await db
			.select({
				status: attachmentDeletion.status,
				storageKey: attachmentDeletion.storageKey
			})
			.from(attachmentDeletion)
			.where(eq(attachmentDeletion.attachmentId, saved!.id));
		expect(intent.status).toBe('pending');
		await expect(stat(safeStoragePath(getUploadDir(), intent.storageKey))).resolves.toMatchObject({
			size: 7
		});
	});

	it('scopes claims and queue counts to one workspace', async () => {
		const first = await createFixture();
		const firstAttachment = await saveExpenseAttachment(
			first.context,
			first.expenseId,
			new File(['first'], 'first.txt', { type: 'text/plain' })
		);
		await deleteExpenseAttachment(first.context, firstAttachment!.id);
		const second = await createFixture();
		const secondAttachment = await saveExpenseAttachment(
			second.context,
			second.expenseId,
			new File(['second'], 'second.txt', { type: 'text/plain' })
		);
		await deleteExpenseAttachment(second.context, secondAttachment!.id);

		const result = await runAttachmentWorkerUntilAcquired({
			now: new Date(Date.now() + attachmentDeletionGraceMs + 1),
			workspaceId: first.context.workspaceId,
			removeFile: async () => {},
			reconcile: false
		});
		expect(result).toMatchObject({ processed: 1, completed: 1, pending: 0, failed: 0 });
		await expect(
			db
				.select({ status: attachmentDeletion.status })
				.from(attachmentDeletion)
				.where(eq(attachmentDeletion.attachmentId, secondAttachment!.id))
		).resolves.toEqual([{ status: 'pending' }]);
	});

	it('reconciles active, retained and unknown files without deleting any of them', async () => {
		const fixture = await createFixture();
		const active = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['active'], 'active.txt', { type: 'text/plain' })
		);
		const retained = await saveExpenseAttachment(
			fixture.context,
			fixture.expenseId,
			new File(['retained'], 'retained.txt', { type: 'text/plain' })
		);
		await deleteExpenseAttachment(fixture.context, retained!.id);
		const unknownPath = safeStoragePath(getUploadDir(), 'unknown/file.txt');
		await mkdir(path.dirname(unknownPath), { recursive: true });
		await writeFile(unknownPath, 'unknown');

		await expect(
			reconcileAttachmentStorage({ workspaceId: fixture.context.workspaceId })
		).resolves.toMatchObject({
			active: 1,
			retained: 1,
			disk: 3,
			missingActive: 0,
			missingRetained: 0,
			unknownDisk: 1,
			scanFailed: false
		});
		const [activeRow] = await db
			.select({ storageKey: expenseAttachment.storageKey })
			.from(expenseAttachment)
			.where(eq(expenseAttachment.id, active!.id));
		await rm(safeStoragePath(getUploadDir(), activeRow.storageKey));
		await expect(
			reconcileAttachmentStorage({ workspaceId: fixture.context.workspaceId })
		).resolves.toMatchObject({
			missingActive: 1,
			missingRetained: 0,
			unknownDisk: 1
		});
		await expect(stat(unknownPath)).resolves.toMatchObject({ size: 7 });
		const [retainedRow] = await db
			.select({ storageKey: attachmentDeletion.storageKey })
			.from(attachmentDeletion)
			.where(eq(attachmentDeletion.attachmentId, retained!.id));
		await rm(safeStoragePath(getUploadDir(), retainedRow.storageKey));
		await expect(
			runAttachmentWorkerUntilAcquired({
				uploadDir: getUploadDir(),
				workspaceId: fixture.context.workspaceId
			})
		).resolves.toMatchObject({ failed: 2 });
		await expect(
			reconcileAttachmentStorage({
				uploadDir: path.join(getUploadDir(), 'does-not-exist'),
				workspaceId: fixture.context.workspaceId
			})
		).resolves.toMatchObject({ disk: 0, missingActive: 1 });
		const finalWorkerResult = await runAttachmentWorkerUntilAcquired({
			uploadDir: getUploadDir(),
			limit: 0,
			workspaceId: fixture.context.workspaceId
		});
		expect(finalWorkerResult).toHaveProperty('reconciliation');
	});
});

async function createFixture() {
	const storageRoot = await mkdtemp(path.join(tmpdir(), 'coverage-attachments-'));
	const uploadDir = path.join(storageRoot, 'uploads');
	await mkdir(uploadDir);
	uploadDirs.push(storageRoot);
	process.env.UPLOAD_DIR = uploadDir;
	const id = `attachment-${randomUUID()}`;
	await db
		.insert(user)
		.values({ id, name: 'Attachment owner', email: `${id}@example.com`, emailVerified: true });
	userIds.push(id);
	const [workspaceRow] = await db
		.insert(workspace)
		.values({ name: `Attachment ${randomUUID()}`, createdByUserId: id, currency: 'USD' })
		.returning({
			id: workspace.id,
			name: workspace.name,
			currency: workspace.currency,
			weekStartsOn: workspace.weekStartsOn
		});
	workspaceIds.push(workspaceRow.id);
	await db
		.insert(workspaceMember)
		.values({ workspaceId: workspaceRow.id, userId: id, role: 'owner', status: 'active' });
	const [categoryRow] = await db
		.insert(category)
		.values({ workspaceId: workspaceRow.id, name: 'Receipts', color: '#123456' })
		.returning({ id: category.id });
	const [expenseRow] = await db
		.insert(expense)
		.values({
			workspaceId: workspaceRow.id,
			categoryId: categoryRow.id,
			createdByUserId: id,
			description: 'Attached expense',
			amountCents: 100,
			expenseDate: '2026-07-01'
		})
		.returning({ id: expense.id });
	const context: WorkspaceContext = {
		userId: id,
		workspaceId: workspaceRow.id,
		workspaceName: workspaceRow.name,
		currency: workspaceRow.currency,
		weekStartsOn: workspaceRow.weekStartsOn,
		locale: 'en',
		role: 'owner'
	};
	return { context, expenseId: expenseRow.id };
}

async function runAttachmentWorkerUntilAcquired(
	options: Parameters<typeof runAttachmentDeletionWorker>[0]
) {
	const deadline = Date.now() + 5_000;
	do {
		const result = await runAttachmentDeletionWorker(options);
		if (!('skipped' in result) || !result.skipped) return result;
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	} while (Date.now() < deadline);
	throw new Error('attachment worker storage lock stayed busy');
}
