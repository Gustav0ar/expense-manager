import { error } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { env } from '$env/dynamic/private';
import { and, eq, isNull } from 'drizzle-orm';
import { maxAttachmentBytes } from '$lib/attachment-limits';
import { db } from '$lib/server/db';
import { auditEvent, expense, expenseAttachment } from '$lib/server/db/schema';
import { canWriteExpenses } from '$lib/server/security/roles';
import { randomToken } from '$lib/server/utils/crypto';
import type { WorkspaceContext } from './workspaces';
import { translate } from '$lib/i18n';

export { maxAttachmentBytes };

class AttachmentTooLargeError extends Error {}

const allowedContentTypes = new Set([
	'application/pdf',
	'image/jpeg',
	'image/png',
	'image/webp',
	'text/plain'
]);

export function isAllowedAttachmentType(contentType: string) {
	return allowedContentTypes.has(contentType.toLowerCase());
}

export function sanitizeFileName(name: string) {
	const sanitized = name
		.normalize('NFKD')
		.replace(/[^\w.\- ]+/g, '')
		.trim()
		.replace(/\s+/g, '-')
		.slice(0, 120);

	return sanitized || 'receipt';
}

export async function saveExpenseAttachment(
	context: WorkspaceContext,
	expenseId: number,
	file: File
) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	await assertExpenseInWorkspace(context.workspaceId, expenseId, context.locale);

	if (!file || file.size === 0) return null;
	if (file.size > maxAttachmentBytes)
		throw error(400, translate(context.locale, 'Attachment is larger than 2 MB.'));
	if (!isAllowedAttachmentType(file.type))
		throw error(400, translate(context.locale, 'Attachment type is not allowed.'));

	const originalName = sanitizeFileName(file.name);
	const storageKey = `${context.workspaceId}/${expenseId}/${randomToken(16)}-${originalName}`;
	const tempStorageKey = `${storageKey}.${randomToken(8)}.tmp`;
	const uploadDir = getUploadDir();
	const filePath = safeStoragePath(uploadDir, storageKey, context.locale);
	const tempPath = safeStoragePath(uploadDir, tempStorageKey, context.locale);

	await mkdir(path.dirname(filePath), { recursive: true });
	let fileWritten = false;

	try {
		const storedFile = await streamAttachmentToFile(file, tempPath, context.locale);
		await assertStoragePathAvailable(filePath, context.locale);
		await rename(tempPath, filePath);
		fileWritten = true;

		const created = await db.transaction(async (tx) => {
			const [attachment] = await tx
				.insert(expenseAttachment)
				.values({
					workspaceId: context.workspaceId,
					expenseId,
					uploadedByUserId: context.userId,
					originalName,
					contentType: file.type,
					sizeBytes: storedFile.sizeBytes,
					storageKey,
					sha256: storedFile.checksum
				})
				.returning({ id: expenseAttachment.id });

			await tx.insert(auditEvent).values({
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: 'expense_attachment.created',
				entityType: 'expense_attachment',
				entityId: String(attachment.id),
				metadata: { expenseId, sizeBytes: storedFile.sizeBytes, contentType: file.type }
			});

			return attachment;
		});

		return created;
	} catch (err) {
		await rm(tempPath, { force: true }).catch(() => {});
		if (fileWritten) await rm(filePath, { force: true }).catch(() => {});
		throw err;
	}
}

export async function getAttachmentForDownload(context: WorkspaceContext, id: number) {
	const [attachment] = await db
		.select({
			id: expenseAttachment.id,
			originalName: expenseAttachment.originalName,
			contentType: expenseAttachment.contentType,
			sizeBytes: expenseAttachment.sizeBytes,
			storageKey: expenseAttachment.storageKey
		})
		.from(expenseAttachment)
		.innerJoin(expense, eq(expense.id, expenseAttachment.expenseId))
		.where(
			and(
				eq(expenseAttachment.id, id),
				eq(expenseAttachment.workspaceId, context.workspaceId),
				eq(expense.workspaceId, context.workspaceId),
				isNull(expense.deletedAt)
			)
		)
		.limit(1);

	if (!attachment) throw error(404, translate(context.locale, 'Attachment not found.'));

	const filePath = safeStoragePath(getUploadDir(), attachment.storageKey, context.locale);
	const fileStats = await stat(filePath).catch(() => {
		throw error(404, translate(context.locale, 'Attachment file not found.'));
	});

	if (!fileStats.isFile())
		throw error(404, translate(context.locale, 'Attachment file not found.'));

	return {
		...attachment,
		contentLength: fileStats.size,
		stream: Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>
	};
}

export async function deleteExpenseAttachment(context: WorkspaceContext, attachmentId: number) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const [attachment] = await db
		.select({
			id: expenseAttachment.id,
			expenseId: expenseAttachment.expenseId,
			storageKey: expenseAttachment.storageKey,
			sizeBytes: expenseAttachment.sizeBytes,
			contentType: expenseAttachment.contentType
		})
		.from(expenseAttachment)
		.innerJoin(expense, eq(expense.id, expenseAttachment.expenseId))
		.where(
			and(
				eq(expenseAttachment.id, attachmentId),
				eq(expenseAttachment.workspaceId, context.workspaceId),
				eq(expense.workspaceId, context.workspaceId)
				// Intentionally no isNull(expense.deletedAt): we must be able to
				// clean up attachments on soft-deleted expenses too.
			)
		)
		.limit(1);

	if (!attachment) throw error(404, translate(context.locale, 'Attachment not found.'));

	const filePath = safeStoragePath(getUploadDir(), attachment.storageKey, context.locale);

	await db.transaction(async (tx) => {
		await tx.delete(expenseAttachment).where(eq(expenseAttachment.id, attachment.id));

		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'expense_attachment.deleted',
			entityType: 'expense_attachment',
			entityId: String(attachment.id),
			metadata: {
				expenseId: attachment.expenseId,
				sizeBytes: attachment.sizeBytes,
				contentType: attachment.contentType
			}
		});
	});

	// Remove the file from disk after the DB transaction succeeds.
	// Failure here leaves an orphaned file but won't corrupt DB state.
	await rm(filePath, { force: true }).catch(() => {});
}

export function attachmentContentDisposition(fileName: string) {
	const sanitized = sanitizeFileName(fileName).replace(/"/g, '');
	return `attachment; filename="${sanitized}"`;
}

export function getUploadDir() {
	return process.env.UPLOAD_DIR || env.UPLOAD_DIR || path.join(process.cwd(), 'uploads');
}

export function safeStoragePath(
	root: string,
	storageKey: string,
	locale: WorkspaceContext['locale'] = 'en'
) {
	const resolvedRoot = path.resolve(root);
	const resolvedPath = path.resolve(resolvedRoot, storageKey);
	if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
		throw error(400, translate(locale, 'Attachment path is invalid.'));
	}
	return resolvedPath;
}

async function streamAttachmentToFile(
	file: File,
	filePath: string,
	locale: WorkspaceContext['locale']
) {
	const hash = createHash('sha256');
	let sizeBytes = 0;

	async function* chunks() {
		const reader = file.stream().getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;

				sizeBytes += value.byteLength;
				if (sizeBytes > maxAttachmentBytes) throw new AttachmentTooLargeError();

				hash.update(value);
				yield value;
			}
		} finally {
			reader.releaseLock();
		}
	}

	try {
		await pipeline(chunks(), createWriteStream(filePath, { flags: 'wx' }));
	} catch (err) {
		if (err instanceof AttachmentTooLargeError)
			throw error(400, translate(locale, 'Attachment is larger than 2 MB.'));
		throw err;
	}

	if (sizeBytes === 0) throw error(400, translate(locale, 'Attachment is empty.'));

	return {
		sizeBytes,
		checksum: hash.digest('hex')
	};
}

async function assertStoragePathAvailable(filePath: string, locale: WorkspaceContext['locale']) {
	try {
		await stat(filePath);
	} catch (err) {
		if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return;
		throw err;
	}

	throw error(409, translate(locale, 'Attachment file already exists.'));
}

async function assertExpenseInWorkspace(
	workspaceId: number,
	expenseId: number,
	locale: WorkspaceContext['locale']
) {
	const [row] = await db
		.select({ id: expense.id })
		.from(expense)
		.where(
			and(
				eq(expense.id, expenseId),
				eq(expense.workspaceId, workspaceId),
				isNull(expense.deletedAt)
			)
		)
		.limit(1);

	if (!row) throw error(404, translate(locale, 'Expense not found.'));
}
