import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { user } from '$lib/server/db/auth.schema';
import { category, expense, workspace, workspaceMember } from '$lib/server/db/schema';
import { db } from '$lib/server/db';
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
import type { WorkspaceContext } from './workspaces';

const workspaceIds: number[] = [];
const userIds: string[] = [];
const uploadDirs: string[] = [];

describe('attachment service integration', () => {
	afterEach(async () => {
		delete process.env.UPLOAD_DIR;
		for (const workspaceId of workspaceIds.splice(0)) {
			await db.delete(workspace).where(eq(workspace.id, workspaceId));
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
});

async function createFixture() {
	const uploadDir = await mkdtemp(path.join(tmpdir(), 'coverage-attachments-'));
	uploadDirs.push(uploadDir);
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
