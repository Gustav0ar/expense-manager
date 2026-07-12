import { error } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { translate } from '$lib/i18n';
import { decodeCursor, encodeCursor, isSafePositiveInteger } from '$lib/server/utils/cursor';
import { advisoryLockClient, db } from '$lib/server/db';
import {
	attachmentDeletion,
	auditEvent,
	category,
	costCenter,
	expense,
	expenseAttachment,
	paymentMethod,
	vendor
} from '$lib/server/db/schema';
import {
	canReconcileExpenses,
	canReviewExpenses,
	canWriteExpenses
} from '$lib/server/security/roles';
import { attachmentStorageLockKey } from './attachment-deletion';
import { getUploadDir, safeStoragePath } from './attachments';
import { insertAuditEvent } from './audit';
import { catalogKindLabel, type ExpenseCatalogKind } from './expense-catalogs';
import type { WorkspaceContext } from './workspaces';

export const expenseTrashRetentionMs = 30 * 24 * 60 * 60 * 1000;
export const expenseTrashPurgeBatchSize = 25;
export const expenseTrashPurgeLockKey = 7_273_299_175;
export const expenseTrashPageSize = 100;

type ExpenseTrashCursor = {
	v: 1;
	w: number;
	d: string;
	i: number;
};

export function expenseTrashDates(now = new Date()) {
	return {
		deletedAt: now,
		trashExpiresAt: new Date(now.getTime() + expenseTrashRetentionMs)
	};
}

export async function listTrashedExpenses(
	context: WorkspaceContext,
	options: { cursor?: string; limit?: number } = {}
) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	const cursor = options.cursor ? parseTrashCursor(context, options.cursor) : null;
	const requestedLimit = Math.trunc(options.limit ?? expenseTrashPageSize);
	const limit = Number.isFinite(requestedLimit)
		? Math.min(Math.max(requestedLimit, 1), expenseTrashPageSize)
		: expenseTrashPageSize;

	const rows = await db
		.select({
			id: expense.id,
			description: expense.description,
			amountCents: expense.amountCents,
			currency: expense.currency,
			expenseDate: expense.expenseDate,
			categoryName: category.name,
			reviewStatus: expense.reviewStatus,
			paymentStatus: expense.paymentStatus,
			deletedAt: expense.deletedAt,
			trashExpiresAt: expense.trashExpiresAt
		})
		.from(expense)
		.innerJoin(category, eq(category.id, expense.categoryId))
		.where(
			and(
				eq(expense.workspaceId, context.workspaceId),
				isNotNull(expense.deletedAt),
				cursor
					? or(
							lt(expense.deletedAt, new Date(cursor.d)),
							and(eq(expense.deletedAt, new Date(cursor.d)), lt(expense.id, cursor.i))
						)
					: undefined
			)
		)
		.orderBy(desc(expense.deletedAt), desc(expense.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const pageRows = hasMore ? rows.slice(0, limit) : rows;
	const items = pageRows.map((item) => ({
		...item,
		canRestore:
			(item.reviewStatus === 'pending' || canReviewExpenses(context.role)) &&
			(item.paymentStatus === 'unpaid' || canReconcileExpenses(context.role))
	}));
	const last = hasMore ? pageRows.at(-1) : undefined;
	return {
		items,
		hasMore,
		nextCursor:
			last?.deletedAt === null || !last
				? null
				: encodeTrashCursor({
						v: 1,
						w: context.workspaceId,
						d: last.deletedAt.toISOString(),
						i: last.id
					})
	};
}

function encodeTrashCursor(cursor: ExpenseTrashCursor) {
	return encodeCursor(cursor);
}

function parseTrashCursor(context: WorkspaceContext, value: string): ExpenseTrashCursor {
	const cursor = decodeCursor(value, (parsed): parsed is ExpenseTrashCursor => {
		if (!parsed || typeof parsed !== 'object') return false;
		const candidate = parsed as Partial<ExpenseTrashCursor>;
		const date = typeof candidate.d === 'string' ? new Date(candidate.d) : null;
		return (
			candidate.v === 1 &&
			candidate.w === context.workspaceId &&
			isSafePositiveInteger(candidate.w) &&
			isSafePositiveInteger(candidate.i) &&
			date !== null &&
			!Number.isNaN(date.getTime()) &&
			date.toISOString() === candidate.d
		);
	});
	if (!cursor) throw error(400, translate(context.locale, 'Trash cursor is invalid.'));
	return cursor;
}

export async function restoreTrashedExpense(
	context: WorkspaceContext,
	id: number,
	now = new Date(),
	options: { onBeforeRestoreUpdate?: () => Promise<void> } = {}
) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));

	const reserved = await advisoryLockClient.reserve();
	try {
		await reserved`select pg_advisory_lock(${attachmentStorageLockKey})`;
		try {
			return await restoreWithStorageLock(context, id, now, options);
		} finally {
			await reserved`select pg_advisory_unlock(${attachmentStorageLockKey})`;
		}
	} finally {
		reserved.release();
	}
}

async function restoreWithStorageLock(
	context: WorkspaceContext,
	id: number,
	now: Date,
	options: { onBeforeRestoreUpdate?: () => Promise<void> }
) {
	try {
		return await db.transaction(async (tx) => {
			const [item] = await tx
				.select()
				.from(expense)
				.where(and(eq(expense.id, id), eq(expense.workspaceId, context.workspaceId)))
				.limit(1)
				.for('update');

			if (!item || !item.deletedAt)
				throw error(404, translate(context.locale, 'Trashed expense not found.'));
			if (!item.trashExpiresAt || item.trashExpiresAt.getTime() <= now.getTime())
				throw error(409, translate(context.locale, 'This expense can no longer be restored.'));
			if (item.reviewStatus !== 'pending' && !canReviewExpenses(context.role))
				throw error(403, translate(context.locale, 'Permission denied.'));
			if (item.paymentStatus !== 'unpaid' && !canReconcileExpenses(context.role))
				throw error(403, translate(context.locale, 'Permission denied.'));
			if (item.currency !== context.currency)
				throw error(
					409,
					translate(
						context.locale,
						'The workspace currency changed, so this expense cannot be restored.'
					)
				);

			const [validCategory] = await tx
				.select({ id: category.id })
				.from(category)
				.where(
					and(
						eq(category.id, item.categoryId),
						eq(category.workspaceId, context.workspaceId),
						eq(category.isArchived, false)
					)
				)
				.limit(1);
			if (!validCategory)
				throw error(
					409,
					translate(context.locale, 'Restore the expense category before restoring this expense.')
				);

			await assertActiveCatalogReferences(tx, context, item);
			if (item.sourceRecurringExpenseId) {
				const [replacement] = await tx
					.select({ id: expense.id })
					.from(expense)
					.where(
						and(
							eq(expense.workspaceId, context.workspaceId),
							eq(expense.sourceRecurringExpenseId, item.sourceRecurringExpenseId),
							eq(expense.expenseDate, item.expenseDate),
							isNull(expense.deletedAt)
						)
					)
					.limit(1);
				if (replacement)
					throw error(
						409,
						translate(context.locale, 'A newer recurring expense already exists for this date.')
					);
			}

			const attachments = await tx
				.select({
					id: expenseAttachment.id,
					storageKey: expenseAttachment.storageKey,
					sizeBytes: expenseAttachment.sizeBytes,
					sha256: expenseAttachment.sha256,
					deletedAt: expenseAttachment.deletedAt,
					deletionId: attachmentDeletion.id,
					deletionStatus: attachmentDeletion.status,
					deletionReason: attachmentDeletion.reason
				})
				.from(expenseAttachment)
				.leftJoin(attachmentDeletion, eq(attachmentDeletion.attachmentId, expenseAttachment.id))
				.where(
					and(
						eq(expenseAttachment.expenseId, item.id),
						eq(expenseAttachment.workspaceId, context.workspaceId)
					)
				)
				.for('update', { of: expenseAttachment });

			const restorable = attachments.filter(
				(attachment) => attachment.deletionReason === 'expense_trash'
			);
			if (
				attachments.some(
					(attachment) =>
						attachment.deletionReason !== 'expense_trash' &&
						attachment.deletionReason !== 'attachment_deleted'
				)
			) {
				throw error(
					409,
					translate(context.locale, 'An attachment is no longer available for restore.')
				);
			}
			for (const attachment of restorable) {
				if (
					!attachment.deletedAt ||
					!attachment.deletionId ||
					attachment.deletionStatus !== 'pending'
				) {
					throw error(
						409,
						translate(context.locale, 'An attachment is no longer available for restore.')
					);
				}
				await assertAttachmentIntegrity(context, attachment);
			}

			const restorableIds = restorable.map((attachment) => attachment.id);
			const deletionIds = restorable.flatMap((attachment) =>
				attachment.deletionId ? [attachment.deletionId] : []
			);
			if (deletionIds.length > 0) {
				const removed = await tx
					.delete(attachmentDeletion)
					.where(
						and(
							inArray(attachmentDeletion.id, deletionIds),
							eq(attachmentDeletion.workspaceId, context.workspaceId),
							eq(attachmentDeletion.reason, 'expense_trash'),
							eq(attachmentDeletion.status, 'pending')
						)
					)
					.returning({ id: attachmentDeletion.id });
				if (removed.length !== deletionIds.length)
					throw error(
						409,
						translate(context.locale, 'An attachment is no longer available for restore.')
					);
			}
			if (restorableIds.length > 0) {
				await tx
					.update(expenseAttachment)
					.set({ deletedAt: null })
					.where(
						and(
							inArray(expenseAttachment.id, restorableIds),
							eq(expenseAttachment.workspaceId, context.workspaceId)
						)
					);
			}

			await options.onBeforeRestoreUpdate?.();
			const [restored] = await tx
				.update(expense)
				.set({ deletedAt: null, trashExpiresAt: null })
				.where(
					and(
						eq(expense.id, item.id),
						eq(expense.workspaceId, context.workspaceId),
						eq(expense.deletedAt, item.deletedAt),
						eq(expense.trashExpiresAt, item.trashExpiresAt)
					)
				)
				.returning({ id: expense.id });
			if (!restored)
				throw error(409, translate(context.locale, 'Expense was modified. Reload and try again.'));

			await insertAuditEvent(tx, {
				workspaceId: context.workspaceId,
				actorUserId: context.userId,
				action: 'expense.restored',
				entityType: 'expense',
				entityId: item.id,
				metadata: { restoredAttachmentCount: restorableIds.length }
			});
			return restored;
		});
	} catch (restoreError) {
		if (isUniqueViolation(restoreError))
			throw error(
				409,
				translate(context.locale, 'A newer recurring expense already exists for this date.')
			);
		throw restoreError;
	}
}

type TrashPurgeOptions = {
	now?: Date;
	limit?: number;
	workspaceId?: number;
	expenseId?: number;
	actorUserId?: string;
};

export async function runExpenseTrashPurgeWorker(options: TrashPurgeOptions = {}) {
	const now = options.now ?? new Date();
	const limit = Math.max(
		1,
		Math.min(options.limit ?? expenseTrashPurgeBatchSize, expenseTrashPurgeBatchSize)
	);
	const reserved = await advisoryLockClient.reserve();
	try {
		const [lock] = await reserved<{ acquired: boolean }[]>`
			select pg_try_advisory_lock(${expenseTrashPurgeLockKey}) as acquired
		`;
		if (!lock?.acquired) return { purged: 0, skipped: true };
		try {
			const purged = await db.transaction(async (tx) => {
				const candidates = await tx.execute<{ id: number; workspace_id: number }>(sql`
					select id, workspace_id
					from expense
					where deleted_at is not null
						and trash_expires_at is not null
						and trash_expires_at <= ${now.toISOString()}::timestamptz
						${options.workspaceId == null ? sql`` : sql`and workspace_id = ${options.workspaceId}`}
						${options.expenseId == null ? sql`` : sql`and id = ${options.expenseId}`}
					order by trash_expires_at asc, id asc
					for update skip locked
					limit ${limit}
				`);
				if (candidates.length === 0) return 0;
				const ids = candidates.map((candidate) => Number(candidate.id));
				// A hard delete cascades attachment metadata, so first guarantee a durable
				// deletion intent exists for every artifact. This also repairs legacy trash
				// rows created before attachment tombstones were introduced.
				await tx.execute(sql`
					insert into attachment_deletion (
						attachment_id, workspace_id, expense_id, entity_type, entity_id,
						storage_key, size_bytes, sha256, status, reason, not_before,
						next_attempt_at, created_at, updated_at
					)
					select a.id, a.workspace_id, a.expense_id, 'expense_attachment', a.id::text,
						a.storage_key, a.size_bytes, a.sha256, 'pending', 'expense_trash',
						e.trash_expires_at + interval '48 hours',
						e.trash_expires_at + interval '48 hours', ${now.toISOString()}::timestamptz,
						${now.toISOString()}::timestamptz
					from expense_attachment a
					join expense e on e.id = a.expense_id and e.workspace_id = a.workspace_id
					left join attachment_deletion d on d.attachment_id = a.id
					where a.expense_id in (${sql.join(
						ids.map((id) => sql`${id}`),
						sql`, `
					)})
						and d.id is null
					on conflict do nothing
				`);
				await tx.execute(sql`
					update expense_attachment
					set deleted_at = coalesce(deleted_at, ${now.toISOString()}::timestamptz)
					where expense_id in (${sql.join(
						ids.map((id) => sql`${id}`),
						sql`, `
					)})
				`);
				const [integrity] = await tx.execute<{ missing: number }>(sql`
					select count(*)::int as missing
					from expense_attachment a
					left join attachment_deletion d on d.attachment_id = a.id
					where a.expense_id in (${sql.join(
						ids.map((id) => sql`${id}`),
						sql`, `
					)})
						and d.id is null
				`);
				if (Number(integrity?.missing ?? 0) !== 0)
					throw new Error('expense_trash: attachment deletion intent repair failed');
				await tx.insert(auditEvent).values(
					candidates.map((candidate) => ({
						workspaceId: Number(candidate.workspace_id),
						actorUserId: options.actorUserId ?? null,
						action: 'expense.purged',
						entityType: 'expense',
						entityId: String(candidate.id),
						metadata: { expiredAt: now.toISOString() }
					}))
				);
				const removed = await tx
					.delete(expense)
					.where(
						and(
							inArray(expense.id, ids),
							isNotNull(expense.deletedAt),
							isNotNull(expense.trashExpiresAt),
							lte(expense.trashExpiresAt, now)
						)
					)
					.returning({ id: expense.id });
				return removed.length;
			});
			return { purged, skipped: false };
		} finally {
			await reserved`select pg_advisory_unlock(${expenseTrashPurgeLockKey})`;
		}
	} finally {
		reserved.release();
	}
}

export async function purgeTrashedExpense(context: WorkspaceContext, id: number, now = new Date()) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	const [item] = await db
		.select({
			expiresAt: expense.trashExpiresAt,
			reviewStatus: expense.reviewStatus,
			paymentStatus: expense.paymentStatus
		})
		.from(expense)
		.where(
			and(
				eq(expense.id, id),
				eq(expense.workspaceId, context.workspaceId),
				isNotNull(expense.deletedAt)
			)
		)
		.limit(1);
	if (!item) throw error(404, translate(context.locale, 'Trashed expense not found.'));
	if (item.reviewStatus !== 'pending' && !canReviewExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	if (item.paymentStatus !== 'unpaid' && !canReconcileExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	if (!item.expiresAt || item.expiresAt.getTime() > now.getTime())
		throw error(
			409,
			translate(context.locale, 'This expense is still within its recovery period.')
		);
	const result = await runExpenseTrashPurgeWorker({
		now,
		workspaceId: context.workspaceId,
		expenseId: id,
		actorUserId: context.userId,
		limit: 1
	});
	if (result.skipped || result.purged === 0)
		throw error(409, translate(context.locale, 'Expense was modified. Reload and try again.'));
	return result;
}

async function assertActiveCatalogReferences(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	context: WorkspaceContext,
	item: typeof expense.$inferSelect
) {
	const refs = [
		[item.paymentMethodId, paymentMethod, 'paymentMethod'],
		[item.vendorId, vendor, 'vendor'],
		[item.costCenterId, costCenter, 'costCenter']
	] as const;
	for (const [id, table, kind] of refs) {
		if (!id) continue;
		const rows = await tx.execute<{ id: number }>(sql`
			select id from ${table}
			where id = ${id} and workspace_id = ${context.workspaceId} and is_archived = false
			limit 1
		`);
		if (rows.length === 0)
			throw error(
				409,
				translate(context.locale, 'Restore the referenced {kind} before restoring this expense.', {
					kind: translate(context.locale, catalogKindLabel(kind as ExpenseCatalogKind))
				})
			);
	}
}

async function assertAttachmentIntegrity(
	context: WorkspaceContext,
	attachment: { storageKey: string; sizeBytes: number; sha256: string }
) {
	const filePath = safeStoragePath(getUploadDir(), attachment.storageKey, context.locale);
	const fileStats = await stat(filePath).catch(() => null);
	if (!fileStats?.isFile() || fileStats.size !== attachment.sizeBytes)
		throw error(
			409,
			translate(context.locale, 'An attachment is no longer available for restore.')
		);
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(filePath)) hash.update(chunk);
	if (hash.digest('hex') !== attachment.sha256)
		throw error(
			409,
			translate(context.locale, 'An attachment is corrupted and cannot be restored.')
		);
}

function isUniqueViolation(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	if ('code' in value && value.code === '23505') return true;
	return 'cause' in value && isUniqueViolation(value.cause);
}
