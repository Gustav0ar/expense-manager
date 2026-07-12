import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { advisoryLockClient, db } from '$lib/server/db';
import { attachmentDeletion, expenseAttachment } from '$lib/server/db/schema';
import { randomToken } from '$lib/server/utils/crypto';
import { getUploadDir, safeStoragePath } from './attachments';

export const attachmentDeletionGraceMs = 48 * 60 * 60 * 1000;
export const attachmentDeletionClaimTtlMs = 10 * 60 * 1000;
export const attachmentDeletionMaxAttempts = 8;
export const attachmentDeletionBatchSize = 25;
export const attachmentStorageLockKey = 7_273_299_174;

type DeletionSource = {
	id: number;
	workspaceId: number;
	expenseId: number;
	storageKey: string;
	sizeBytes: number;
	sha256: string;
};

type ClaimedDeletion = {
	id: number;
	storageKey: string;
	attemptCount: number;
};

export type AttachmentDeletionErrorCategory = 'permission' | 'io' | 'path_invalid' | 'unknown';

type AttachmentDeletionWorkerOptions = {
	now?: Date;
	uploadDir?: string;
	removeFile?: (filePath: string) => Promise<void>;
	limit?: number;
	reconcile?: boolean;
	workspaceId?: number;
};

export function buildAttachmentDeletionRows(
	rows: DeletionSource[],
	deletedAt = new Date(),
	options: {
		reason?: 'attachment_deleted' | 'expense_trash';
		notBefore?: Date;
	} = {}
) {
	const notBefore = options.notBefore ?? new Date(deletedAt.getTime() + attachmentDeletionGraceMs);
	return rows.map((row) => ({
		attachmentId: row.id,
		workspaceId: row.workspaceId,
		expenseId: row.expenseId,
		entityType: 'expense_attachment',
		entityId: String(row.id),
		storageKey: row.storageKey,
		sizeBytes: row.sizeBytes,
		sha256: row.sha256,
		status: 'pending',
		reason: options.reason ?? 'attachment_deleted',
		notBefore,
		nextAttemptAt: notBefore,
		createdAt: deletedAt,
		updatedAt: deletedAt
	}));
}

export async function runAttachmentDeletionWorker(options: AttachmentDeletionWorkerOptions = {}) {
	const workspaceId = resolveAttachmentWorkerWorkspaceId(options.workspaceId);
	const resolvedOptions = { ...options, workspaceId };
	const reserved = await advisoryLockClient.reserve();
	try {
		const [lock] = await reserved<{ acquired: boolean }[]>`
			select pg_try_advisory_lock(${attachmentStorageLockKey}) as acquired
		`;
		if (!lock?.acquired) {
			return { processed: 0, completed: 0, failed: 0, pending: 0, skipped: true };
		}

		try {
			return await processAttachmentDeletions(resolvedOptions);
		} finally {
			await reserved`select pg_advisory_unlock(${attachmentStorageLockKey})`;
		}
	} finally {
		reserved.release();
	}
}

export async function runAttachmentStorageReconciliation(
	options: Pick<AttachmentDeletionWorkerOptions, 'uploadDir' | 'workspaceId'> = {}
) {
	const workspaceId = resolveAttachmentWorkerWorkspaceId(options.workspaceId);
	const reserved = await advisoryLockClient.reserve();
	try {
		const [lock] = await reserved<{ acquired: boolean }[]>`
			select pg_try_advisory_lock(${attachmentStorageLockKey}) as acquired
		`;
		if (!lock?.acquired) return { failed: 0, reconciliation: null, skipped: true };

		try {
			const reconciliation = await reconcileAttachmentStorage({
				uploadDir: options.uploadDir,
				workspaceId
			}).catch(() => ({
				active: 0,
				retained: 0,
				disk: 0,
				missingActive: 0,
				missingRetained: 0,
				unknownDisk: 0,
				scanFailed: true
			}));
			return {
				failed: reconciliation.missingActive + reconciliation.missingRetained,
				reconciliation
			};
		} finally {
			await reserved`select pg_advisory_unlock(${attachmentStorageLockKey})`;
		}
	} finally {
		reserved.release();
	}
}

export function resolveAttachmentWorkerWorkspaceId(explicitWorkspaceId?: number) {
	if (explicitWorkspaceId != null) return explicitWorkspaceId;
	const configuredWorkspaceId = Number.parseInt(
		process.env.ATTACHMENT_WORKER_TEST_WORKSPACE_ID ?? '',
		10
	);
	const testScopeEnabled =
		process.env.ATTACHMENT_WORKER_TEST_SCOPE_SENTINEL === 'infrastructure-test-only';
	return testScopeEnabled &&
		Number.isSafeInteger(configuredWorkspaceId) &&
		configuredWorkspaceId > 0
		? configuredWorkspaceId
		: undefined;
}

async function processAttachmentDeletions(options: AttachmentDeletionWorkerOptions) {
	const now = options.now ?? new Date();
	const claimToken = randomToken(18);
	const claimed = await claimAttachmentDeletions(
		claimToken,
		now,
		options.limit ?? attachmentDeletionBatchSize,
		options.workspaceId
	);
	const uploadDir = options.uploadDir ?? getUploadDir();
	const removeFile = options.removeFile ?? ((filePath: string) => rm(filePath));
	let completed = 0;

	for (const deletion of claimed) {
		try {
			const filePath = safeStoragePath(uploadDir, deletion.storageKey);
			await removeFile(filePath).catch((error: unknown) => {
				if (hasErrorCode(error, 'ENOENT')) return;
				throw error;
			});
			const updated = await db
				.update(attachmentDeletion)
				.set({
					status: 'completed',
					claimToken: null,
					claimExpiresAt: null,
					lastErrorCategory: null,
					completedAt: now,
					updatedAt: now
				})
				.where(
					and(eq(attachmentDeletion.id, deletion.id), eq(attachmentDeletion.claimToken, claimToken))
				)
				.returning({ id: attachmentDeletion.id });
			completed += updated.length;
		} catch (error) {
			const category = classifyAttachmentDeletionError(error);
			await recordAttachmentDeletionFailure(deletion, claimToken, category, now);
			console.error(
				JSON.stringify({
					level: 'error',
					message: 'attachment_deletion: filesystem removal failed',
					deletionId: deletion.id,
					category
				})
			);
		}
	}

	const [counts] = await db.execute<{ pending: number; failed: number }>(sql`
		select
			count(*) filter (where "status" in ('pending', 'processing'))::integer as "pending",
			count(*) filter (where "status" = 'failed')::integer as "failed"
		from "attachment_deletion"
		where true
		${options.workspaceId == null ? sql`` : sql`and "workspace_id" = ${options.workspaceId}`}
	`);
	const reconciliation =
		options.reconcile === true
			? await reconcileAttachmentStorage({
					uploadDir,
					workspaceId: options.workspaceId
				}).catch(() => ({
					active: 0,
					retained: 0,
					disk: 0,
					missingActive: 1,
					missingRetained: 0,
					unknownDisk: 0,
					scanFailed: true
				}))
			: null;

	return {
		processed: claimed.length,
		completed,
		pending: Number(counts?.pending ?? 0),
		failed:
			Number(counts?.failed ?? 0) +
			(reconciliation?.missingActive ?? 0) +
			(reconciliation?.missingRetained ?? 0),
		reconciliation
	};
}

async function claimAttachmentDeletions(
	claimToken: string,
	now: Date,
	limit: number,
	workspaceId?: number
) {
	const claimExpiresAt = new Date(now.getTime() + attachmentDeletionClaimTtlMs);
	const rows = await db.transaction(async (tx) =>
		tx.execute<ClaimedDeletion>(sql`
			with candidates as (
				select d."id"
				from "attachment_deletion" d
				where d."attempt_count" < ${attachmentDeletionMaxAttempts}
					${workspaceId == null ? sql`` : sql`and d."workspace_id" = ${workspaceId}`}
					and d."not_before" <= ${now.toISOString()}::timestamptz
					and d."next_attempt_at" <= ${now.toISOString()}::timestamptz
					and (
						d."status" = 'pending'
						or (
							d."status" = 'processing'
							and d."claim_expires_at" < ${now.toISOString()}::timestamptz
						)
					)
				order by d."next_attempt_at", d."id"
				for update of d skip locked
				limit ${Math.max(1, Math.min(limit, attachmentDeletionBatchSize))}
			), claimed as (
				update "attachment_deletion" d
				set "status" = 'processing',
					"claim_token" = ${claimToken},
					"claim_expires_at" = ${claimExpiresAt.toISOString()}::timestamptz,
					"attempt_count" = d."attempt_count" + 1,
					"last_attempt_at" = ${now.toISOString()}::timestamptz,
					"last_error_category" = null,
					"updated_at" = ${now.toISOString()}::timestamptz
				from candidates c
				where d."id" = c."id"
				returning d."id", d."storage_key" as "storageKey", d."attempt_count" as "attemptCount"
			)
			select "id", "storageKey", "attemptCount" from claimed
		`)
	);
	return rows.map((row) => ({
		id: Number(row.id),
		storageKey: row.storageKey,
		attemptCount: Number(row.attemptCount)
	}));
}

async function recordAttachmentDeletionFailure(
	deletion: ClaimedDeletion,
	claimToken: string,
	category: AttachmentDeletionErrorCategory,
	now: Date
) {
	const terminal = deletion.attemptCount >= attachmentDeletionMaxAttempts;
	const backoffMs = Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** (deletion.attemptCount - 1));
	await db
		.update(attachmentDeletion)
		.set({
			status: terminal ? 'failed' : 'pending',
			claimToken: null,
			claimExpiresAt: null,
			lastErrorCategory: category,
			nextAttemptAt: new Date(now.getTime() + backoffMs),
			updatedAt: now
		})
		.where(
			and(eq(attachmentDeletion.id, deletion.id), eq(attachmentDeletion.claimToken, claimToken))
		);
}

export async function reconcileAttachmentStorage(
	options: { uploadDir?: string; workspaceId?: number } = {}
) {
	const uploadDir = path.resolve(options.uploadDir ?? getUploadDir());
	const activeRows = await db
		.select({ storageKey: expenseAttachment.storageKey })
		.from(expenseAttachment)
		.where(
			and(
				isNull(expenseAttachment.deletedAt),
				options.workspaceId == null
					? undefined
					: eq(expenseAttachment.workspaceId, options.workspaceId)
			)
		);
	const retainedRows = await db
		.select({ storageKey: attachmentDeletion.storageKey })
		.from(attachmentDeletion)
		.where(
			and(
				ne(attachmentDeletion.status, 'completed'),
				options.workspaceId == null
					? undefined
					: eq(attachmentDeletion.workspaceId, options.workspaceId)
			)
		);
	const active = new Set(activeRows.map((row) => row.storageKey));
	const retained = new Set(retainedRows.map((row) => row.storageKey));
	const disk = new Set(await listStorageKeys(uploadDir));

	return {
		active: active.size,
		retained: retained.size,
		disk: disk.size,
		missingActive: countMissing(active, disk),
		missingRetained: countMissing(retained, disk),
		unknownDisk: [...disk].filter((key) => !active.has(key) && !retained.has(key)).length,
		scanFailed: false
	};
}

async function listStorageKeys(root: string, relative = ''): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(path.join(root, relative), { withFileTypes: true });
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT') && relative === '') return [];
		throw error;
	}

	const keys: string[] = [];
	for (const entry of entries) {
		const storageKey = relative ? path.posix.join(relative, entry.name) : entry.name;
		if (entry.isDirectory()) keys.push(...(await listStorageKeys(root, storageKey)));
		else if (entry.isFile()) keys.push(storageKey);
	}
	return keys;
}

function countMissing(expected: Set<string>, actual: Set<string>) {
	let count = 0;
	for (const key of expected) if (!actual.has(key)) count++;
	return count;
}

export function classifyAttachmentDeletionError(error: unknown): AttachmentDeletionErrorCategory {
	if (error && typeof error === 'object' && 'status' in error && error.status === 400)
		return 'path_invalid';
	if (hasErrorCode(error, 'EACCES') || hasErrorCode(error, 'EPERM')) return 'permission';
	if (error instanceof Error && /path.*invalid/i.test(error.message)) return 'path_invalid';
	if (error instanceof Error) return 'io';
	return 'unknown';
}

function hasErrorCode(error: unknown, code: string) {
	return error != null && typeof error === 'object' && 'code' in error && error.code === code;
}
