import { error } from '@sveltejs/kit';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { translate } from '$lib/i18n';
import { db } from '$lib/server/db';
import {
	attachmentDeletion,
	auditEvent,
	category,
	expense,
	expenseAttachment,
	importBatch,
	importPreview,
	type ImportBatchFailedRow,
	type ImportPreviewAnalysis,
	type ImportPreviewRow
} from '$lib/server/db/schema';
import { canReviewExpenses, canWriteExpenses } from '$lib/server/security/roles';
import { sha256 } from '$lib/server/utils/crypto';
import {
	parseExpenseImport,
	type ExpenseImportParseResult,
	type ExpenseImportSource
} from '$lib/server/utils/import';
import { parseCurrencyToCents } from '$lib/server/utils/money';
import { attachmentDeletionGraceMs, buildAttachmentDeletionRows } from './attachment-deletion';
import { expenseTrashDates } from './expense-trash';
import { getActiveRules, matchCategoryRuleFromRules } from './category-rules';
import {
	assertCatalogName,
	catalogKindLabel,
	catalogLookupKey,
	getOrCreateCatalogItems,
	normalizeCatalogName,
	type ExpenseCatalogItem,
	type ExpenseCatalogKind
} from './expense-catalogs';
import {
	chunkImportValues,
	classifyImportExpenseRows,
	importCatalogUpsertChunkSize,
	importDuplicateLookupChunkSize,
	importInsertChunkSize,
	uniqueImportExpenseIdentities,
	type ImportExpenseIdentity
} from './import-batching';
import type { WorkspaceContext } from './workspaces';
import { lockWorkspaceCurrency } from './workspace-currency';

const maxImportBytes = 1 * 1024 * 1024;
const maxImportRows = 500;
export const importPreviewTtlMs = 15 * 60 * 1000;
export const confirmedImportPreviewRetentionMs = 24 * 60 * 60 * 1000;
export const importPreviewCleanupBatchSize = 1000;
const importLockNamespace = 'expense-manager:workspace-import:v1';
const importPreviewCleanupLockName = 'expense-manager:import-preview-cleanup:v1';

export type ImportExpensesInput = {
	sourceType: ExpenseImportSource;
	defaultCategoryId?: number;
	file: File;
};

export type FailedImportRow = ImportBatchFailedRow;

type ActiveCategory = { id: number; name: string; isArchived: boolean };
type CategoryRule = Awaited<ReturnType<typeof getActiveRules>>[number];
type NormalizedPreviewRow = Omit<ImportPreviewRow, 'categoryName' | 'isDuplicate'>;
export type ImportExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function listImportBatches(context: WorkspaceContext) {
	return db
		.select({
			id: importBatch.id,
			sourceType: importBatch.sourceType,
			fileName: importBatch.fileName,
			rowCount: importBatch.rowCount,
			importedCount: importBatch.importedCount,
			duplicateCount: importBatch.duplicateCount,
			failedCount: importBatch.failedCount,
			failedRows: importBatch.failedRows,
			undoneCount: importBatch.undoneCount,
			undoSkippedCount: importBatch.undoSkippedCount,
			undoneAt: importBatch.undoneAt,
			createdAt: importBatch.createdAt
		})
		.from(importBatch)
		.where(eq(importBatch.workspaceId, context.workspaceId))
		.orderBy(desc(importBatch.createdAt))
		.limit(20);
}

export async function pruneExpiredImportPreviews(now = new Date()) {
	const confirmedCutoff = new Date(now.getTime() - confirmedImportPreviewRetentionMs);
	const nowIso = now.toISOString();
	const confirmedCutoffIso = confirmedCutoff.toISOString();
	return db.transaction(async (tx) => {
		const [lock] = await tx.execute<{ acquired: boolean }>(sql`
			select pg_try_advisory_xact_lock(
				hashtextextended(${importPreviewCleanupLockName}, 0)
			) as acquired
		`);
		if (!lock?.acquired) return { deletedPreviews: 0, skipped: true };

		const deleted = await tx.execute<{ id: number }>(sql`
			with expired as (
				select ${importPreview.id}
				from ${importPreview}
				where (
					${importPreview.status} = 'pending'
					and ${importPreview.expiresAt} <= ${nowIso}::timestamptz
				) or (
					${importPreview.status} = 'confirmed'
					and ${importPreview.expiresAt} <= ${confirmedCutoffIso}::timestamptz
				)
				order by ${importPreview.expiresAt}, ${importPreview.id}
				limit ${importPreviewCleanupBatchSize}
				for update skip locked
			)
			delete from ${importPreview}
			where ${importPreview.id} in (select id from expired)
			returning ${importPreview.id} as id
		`);
		return { deletedPreviews: deleted.length };
	});
}

/** Pure import analysis. All database-derived inputs are explicit and the returned rows are stable. */
export function analyzeExpenseImport(input: {
	sourceType: ExpenseImportSource;
	parsed: ExpenseImportParseResult;
	categories: ActiveCategory[];
	rules: CategoryRule[];
	defaultCategoryId?: number;
	existingRows: ImportExpenseIdentity[];
	locale?: string;
}): ImportPreviewAnalysis {
	const locale = input.locale ?? 'en';
	const activeCategories = input.categories.filter((item) => !item.isArchived);
	const categoriesByName = new Map(
		activeCategories.map((item) => [normalizeCatalogName(item.name).toLowerCase(), item])
	);
	const categoriesById = new Map(activeCategories.map((item) => [item.id, item]));
	const defaultCategory = input.defaultCategoryId
		? categoriesById.get(input.defaultCategoryId)
		: undefined;

	if (input.defaultCategoryId && !defaultCategory)
		throw error(400, translate(locale, 'Default category is invalid.'));

	const failedRows: FailedImportRow[] = input.parsed.errors.map((message) => ({
		rowNumber: 0,
		message
	}));
	const normalizedRows: NormalizedPreviewRow[] = [];

	for (const row of input.parsed.rows) {
		const proposedCategory =
			(row.categoryName
				? categoriesByName.get(normalizeCatalogName(row.categoryName).toLowerCase())
				: undefined) ??
			categoriesById.get(
				matchCategoryRuleFromRules(input.rules, {
					description: row.description,
					vendor: row.vendor,
					paymentMethod: row.paymentMethod
				}) ?? -1
			) ??
			defaultCategory;

		if (!proposedCategory) {
			failedRows.push({
				rowNumber: row.rowNumber,
				message: translate(locale, 'Category not found and no default category was selected.')
			});
			continue;
		}

		let amountCents: number;
		try {
			amountCents = parseCurrencyToCents(row.amount);
		} catch {
			failedRows.push({
				rowNumber: row.rowNumber,
				message: translate(locale, 'Amount is invalid.')
			});
			continue;
		}

		try {
			normalizedRows.push({
				sourceRowId: `${input.sourceType}:${row.rowNumber}`,
				rowNumber: row.rowNumber,
				expenseDate: row.expenseDate,
				description: row.description,
				amountCents,
				paymentMethod: normalizeOptionalImportedCatalogName('paymentMethod', row.paymentMethod),
				vendor: normalizeOptionalImportedCatalogName('vendor', row.vendor),
				costCenter: normalizeOptionalImportedCatalogName('costCenter', row.costCenter),
				notes: row.notes,
				categoryId: proposedCategory.id
			});
		} catch (catalogError) {
			failedRows.push({
				rowNumber: row.rowNumber,
				message:
					catalogError instanceof Error
						? translateCatalogError(locale, catalogError.message)
						: translate(locale, 'Invalid auxiliary catalog.')
			});
		}
	}

	const duplicateKeys = new Set(input.existingRows.map(importIdentityKey));
	return {
		rows: normalizedRows.map((row) => ({
			...row,
			categoryName: categoriesById.get(row.categoryId)?.name ?? '',
			isDuplicate: duplicateKeys.has(importIdentityKey(row))
		})),
		failedRows
	};
}

export async function previewImportExpenses(
	context: WorkspaceContext,
	input: ImportExpensesInput,
	options: { now?: Date } = {}
) {
	assertImportInput(context, input);
	const content = await input.file.text();
	const parsed = parseExpenseImport(input.sourceType, content, context.locale);
	if (parsed.rows.length > maxImportRows) {
		throw error(
			400,
			translate(context.locale, 'Import at most {count} rows at a time.', { count: maxImportRows })
		);
	}

	const [categories, rules] = await Promise.all([
		listWorkspaceCategories(context.workspaceId),
		getActiveRules(context.workspaceId)
	]);
	const provisional = analyzeExpenseImport({
		sourceType: input.sourceType,
		parsed,
		categories,
		rules,
		defaultCategoryId: input.defaultCategoryId,
		existingRows: [],
		locale: context.locale
	});
	const existingRows = await findExistingExpenseIdentities(
		db,
		context.workspaceId,
		provisional.rows
	);
	const analysis = analyzeExpenseImport({
		sourceType: input.sourceType,
		parsed,
		categories,
		rules,
		defaultCategoryId: input.defaultCategoryId,
		existingRows,
		locale: context.locale
	});
	const now = options.now ?? new Date();
	const sourceChecksum = sha256(content);
	const preview = await db.transaction(async (tx) => {
		await lockWorkspaceCurrency(tx, context.workspaceId);
		const [created] = await tx
			.insert(importPreview)
			.values({
				workspaceId: context.workspaceId,
				uploadedByUserId: context.userId,
				sourceType: input.sourceType,
				fileName: input.file.name.slice(0, 180) || `import.${input.sourceType}`,
				sourceChecksum,
				rowCount: parsed.rows.length + parsed.errors.length,
				analysis,
				expiresAt: new Date(now.getTime() + importPreviewTtlMs),
				createdAt: now
			})
			.returning({ id: importPreview.id, expiresAt: importPreview.expiresAt });
		return created;
	});

	return {
		previewId: preview.id,
		sourceChecksum,
		expiresAt: preview.expiresAt,
		rowCount: parsed.rows.length + parsed.errors.length,
		proposedCount: analysis.rows.filter((row) => !row.isDuplicate).length,
		duplicateCount: analysis.rows.filter((row) => row.isDuplicate).length,
		failedCount: analysis.failedRows.length,
		rows: analysis.rows,
		failedRows: analysis.failedRows
	};
}

export async function confirmImportPreview(
	context: WorkspaceContext,
	input: { previewId: number; sourceChecksum: string; selectedSourceRowIds?: string[] },
	options: { now?: Date } = {}
) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	const now = options.now ?? new Date();

	return db.transaction(async (tx) => {
		await lockWorkspaceImport(tx, context.workspaceId);
		const currentCurrency = await lockWorkspaceCurrency(tx, context.workspaceId);
		const currentContext = { ...context, currency: currentCurrency };
		const [preview] = await tx
			.select()
			.from(importPreview)
			.where(
				and(
					eq(importPreview.id, input.previewId),
					eq(importPreview.workspaceId, context.workspaceId),
					eq(importPreview.uploadedByUserId, context.userId)
				)
			)
			.limit(1)
			.for('update');
		if (!preview) throw error(404, translate(context.locale, 'Import preview not found.'));
		if (preview.sourceChecksum !== input.sourceChecksum)
			throw error(409, translate(context.locale, 'Import preview checksum does not match.'));
		if (preview.status === 'confirmed' && preview.confirmedBatchId) {
			return loadConfirmedBatchResult(
				tx,
				preview.confirmedBatchId,
				context.workspaceId,
				context.locale
			);
		}
		if (preview.expiresAt <= now)
			throw error(410, translate(context.locale, 'Import preview expired. Upload the file again.'));

		const selectableIds = new Set(preview.analysis.rows.map((row) => row.sourceRowId));
		const selectedIds = new Set(
			input.selectedSourceRowIds ?? preview.analysis.rows.map((row) => row.sourceRowId)
		);
		if ([...selectedIds].some((id) => !selectableIds.has(id)))
			throw error(400, translate(context.locale, 'Import row selection is invalid.'));
		const selectedRows = preview.analysis.rows.filter((row) => selectedIds.has(row.sourceRowId));
		const categoryIds = [...new Set(selectedRows.map((row) => row.categoryId))];
		const activeCategories =
			categoryIds.length === 0
				? []
				: await tx
						.select({ id: category.id })
						.from(category)
						.where(
							and(
								eq(category.workspaceId, context.workspaceId),
								eq(category.isArchived, false),
								inArray(category.id, categoryIds)
							)
						);
		if (activeCategories.length !== categoryIds.length)
			throw error(409, translate(context.locale, 'A proposed category is no longer available.'));

		const existingRows = await findExistingExpenseIdentities(tx, context.workspaceId, selectedRows);
		const classification = classifyImportExpenseRows(selectedRows, existingRows);
		const acceptedRows = classification.acceptedRows;
		const duplicateCount =
			classification.duplicateCount +
			preview.analysis.rows.filter((row) => row.isDuplicate && !selectedIds.has(row.sourceRowId))
				.length;
		const reviewStatus = canReviewExpenses(context.role) ? 'approved' : 'pending';
		const reviewedByUserId = reviewStatus === 'approved' ? context.userId : null;
		const reviewedAt = reviewStatus === 'approved' ? now : null;
		const [batch] = await tx
			.insert(importBatch)
			.values({
				workspaceId: context.workspaceId,
				uploadedByUserId: context.userId,
				sourceType: preview.sourceType,
				fileName: preview.fileName,
				rowCount: preview.rowCount,
				importedCount: acceptedRows.length,
				duplicateCount,
				failedCount: preview.analysis.failedRows.length,
				failedRows: preview.analysis.failedRows,
				createdAt: now
			})
			.returning({ id: importBatch.id });

		await insertImportedExpenseRows(tx, currentContext, {
			rows: acceptedRows,
			batchId: batch.id,
			now,
			reviewStatus,
			reviewedByUserId,
			reviewedAt
		});

		await tx
			.update(importPreview)
			.set({ status: 'confirmed', confirmedBatchId: batch.id, confirmedAt: now })
			.where(eq(importPreview.id, preview.id));
		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: acceptedRows.length > 0 ? 'expense_import.completed' : 'expense_import.failed',
			entityType: 'import_batch',
			entityId: String(batch.id),
			metadata: {
				previewId: preview.id,
				sourceType: preview.sourceType,
				importedCount: acceptedRows.length,
				duplicateCount,
				failedCount: preview.analysis.failedRows.length,
				rowCount: preview.rowCount,
				reviewStatus
			}
		});
		return {
			importBatchId: batch.id,
			importedCount: acceptedRows.length,
			duplicateCount,
			failedCount: preview.analysis.failedRows.length,
			failedRows: preview.analysis.failedRows
		};
	});
}

/**
 * Transaction-aware import insertion shared by preview confirmation and bank
 * reconciliation. Callers own the surrounding transaction and audit record.
 */
export async function insertImportedExpenseRows(
	executor: ImportExecutor,
	context: WorkspaceContext,
	input: {
		rows: ImportPreviewRow[];
		batchId: number;
		now: Date;
		reviewStatus: 'pending' | 'approved';
		reviewedByUserId: string | null;
		reviewedAt: Date | null;
	}
) {
	if (input.rows.length === 0) return [];
	const [paymentMethods, vendors, costCenters] = await Promise.all([
		buildCatalogLookup(
			executor,
			context.workspaceId,
			'paymentMethod',
			input.rows.map((row) => row.paymentMethod),
			context.locale
		),
		buildCatalogLookup(
			executor,
			context.workspaceId,
			'vendor',
			input.rows.map((row) => row.vendor),
			context.locale
		),
		buildCatalogLookup(
			executor,
			context.workspaceId,
			'costCenter',
			input.rows.map((row) => row.costCenter),
			context.locale
		)
	]);
	const values: Array<typeof expense.$inferInsert> = input.rows.map((row) => {
		const payment = lookupCatalogItem(paymentMethods, row.paymentMethod);
		const importedVendor = lookupCatalogItem(vendors, row.vendor);
		const importedCostCenter = lookupCatalogItem(costCenters, row.costCenter);
		const material = {
			categoryId: row.categoryId,
			description: row.description,
			amountCents: row.amountCents,
			currency: context.currency,
			expenseDate: row.expenseDate,
			paymentMethodId: payment?.id ?? null,
			paymentMethod: payment?.name ?? null,
			vendorId: importedVendor?.id ?? null,
			vendor: importedVendor?.name ?? null,
			costCenterId: importedCostCenter?.id ?? null,
			costCenter: importedCostCenter?.name ?? null,
			competencyMonth: null,
			notes: row.notes || null,
			status: 'posted',
			reviewStatus: input.reviewStatus,
			reviewedByUserId: input.reviewedByUserId,
			reviewedAt: input.reviewedAt,
			reviewRejectionReason: null
		};
		return {
			workspaceId: context.workspaceId,
			createdByUserId: context.userId,
			importBatchId: input.batchId,
			...material,
			importBaselineHash: importMaterialHash(material),
			createdAt: input.now,
			updatedAt: input.now
		};
	});
	const inserted: Array<{ id: number }> = [];
	for (const chunk of chunkImportValues(values, importInsertChunkSize)) {
		inserted.push(...(await executor.insert(expense).values(chunk).returning({ id: expense.id })));
	}
	return inserted;
}

/** Compatibility service for non-UI callers; the upload action itself only creates a preview. */
export async function importExpenses(context: WorkspaceContext, input: ImportExpensesInput) {
	const preview = await previewImportExpenses(context, input);
	return confirmImportPreview(context, {
		previewId: preview.previewId,
		sourceChecksum: preview.sourceChecksum
	});
}

export async function undoImportBatch(context: WorkspaceContext, batchId: number) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	return db.transaction(async (tx) => {
		const [batch] = await tx
			.select()
			.from(importBatch)
			.where(and(eq(importBatch.id, batchId), eq(importBatch.workspaceId, context.workspaceId)))
			.limit(1)
			.for('update');
		if (!batch) throw error(404, translate(context.locale, 'Import batch not found.'));
		if (batch.undoneAt) {
			return { undoneCount: batch.undoneCount, skippedCount: batch.undoSkippedCount };
		}

		const rows = await tx
			.select({
				id: expense.id,
				categoryId: expense.categoryId,
				description: expense.description,
				amountCents: expense.amountCents,
				currency: expense.currency,
				expenseDate: expense.expenseDate,
				paymentMethodId: expense.paymentMethodId,
				paymentMethod: expense.paymentMethod,
				vendorId: expense.vendorId,
				vendor: expense.vendor,
				costCenterId: expense.costCenterId,
				costCenter: expense.costCenter,
				competencyMonth: expense.competencyMonth,
				notes: expense.notes,
				status: expense.status,
				reviewStatus: expense.reviewStatus,
				reviewedByUserId: expense.reviewedByUserId,
				reviewedAt: expense.reviewedAt,
				reviewRejectionReason: expense.reviewRejectionReason,
				paymentStatus: expense.paymentStatus,
				reconciledAt: expense.reconciledAt,
				deletedAt: expense.deletedAt,
				importBaselineHash: expense.importBaselineHash
			})
			.from(expense)
			.where(and(eq(expense.workspaceId, context.workspaceId), eq(expense.importBatchId, batch.id)))
			.for('update');
		const eligibleIds = rows
			.filter(
				(row) =>
					row.deletedAt === null &&
					row.paymentStatus === 'unpaid' &&
					row.reconciledAt === null &&
					row.importBaselineHash !== null &&
					row.importBaselineHash === importMaterialHash(row)
			)
			.map((row) => row.id);
		const { deletedAt, trashExpiresAt } = expenseTrashDates();
		if (eligibleIds.length > 0) {
			await tx
				.update(expense)
				.set({ deletedAt, trashExpiresAt })
				.where(
					and(
						eq(expense.workspaceId, context.workspaceId),
						eq(expense.importBatchId, batch.id),
						inArray(expense.id, eligibleIds),
						isNull(expense.deletedAt),
						eq(expense.paymentStatus, 'unpaid'),
						isNull(expense.reconciledAt)
					)
				);
			const attachments = await tx
				.update(expenseAttachment)
				.set({ deletedAt })
				.where(
					and(
						inArray(expenseAttachment.expenseId, eligibleIds),
						isNull(expenseAttachment.deletedAt)
					)
				)
				.returning({
					id: expenseAttachment.id,
					workspaceId: expenseAttachment.workspaceId,
					expenseId: expenseAttachment.expenseId,
					storageKey: expenseAttachment.storageKey,
					sizeBytes: expenseAttachment.sizeBytes,
					sha256: expenseAttachment.sha256
				});
			if (attachments.length > 0) {
				await tx.insert(attachmentDeletion).values(
					buildAttachmentDeletionRows(attachments, deletedAt, {
						reason: 'expense_trash',
						notBefore: new Date(trashExpiresAt.getTime() + attachmentDeletionGraceMs)
					})
				);
				await tx.insert(auditEvent).values(
					attachments.map((attachment) => ({
						workspaceId: context.workspaceId,
						actorUserId: context.userId,
						action: 'expense_attachment.deleted',
						entityType: 'expense_attachment',
						entityId: String(attachment.id),
						metadata: { expenseId: attachment.expenseId, reason: 'import_batch_undone' }
					}))
				);
			}
		}
		const skippedCount = rows.length - eligibleIds.length;
		await tx
			.update(importBatch)
			.set({
				undoneCount: eligibleIds.length,
				undoSkippedCount: skippedCount,
				undoneByUserId: context.userId,
				undoneAt: deletedAt
			})
			.where(eq(importBatch.id, batch.id));
		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: 'expense_import.undone',
			entityType: 'import_batch',
			entityId: String(batch.id),
			metadata: { undoneCount: eligibleIds.length, skippedCount }
		});
		return { undoneCount: eligibleIds.length, skippedCount };
	});
}

function assertImportInput(context: WorkspaceContext, input: ImportExpensesInput) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	if (!input.file || input.file.size === 0)
		throw error(400, translate(context.locale, 'File is required.'));
	if (input.file.size > maxImportBytes)
		throw error(400, translate(context.locale, 'File is larger than 1 MB.'));
}

function listWorkspaceCategories(workspaceId: number) {
	return db
		.select({ id: category.id, name: category.name, isArchived: category.isArchived })
		.from(category)
		.where(eq(category.workspaceId, workspaceId));
}

async function lockWorkspaceImport(executor: ImportExecutor, workspaceId: number) {
	await executor.execute(
		sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${importLockNamespace}:${workspaceId}`}, 0))`
	);
}

async function findExistingExpenseIdentities(
	executor: ImportExecutor,
	workspaceId: number,
	rows: ImportExpenseIdentity[]
) {
	const existingRows: ImportExpenseIdentity[] = [];
	const identities = uniqueImportExpenseIdentities(rows);
	for (const identityChunk of chunkImportValues(identities, importDuplicateLookupChunkSize)) {
		if (identityChunk.length === 0) continue;
		const candidates = await executor
			.selectDistinct({
				amountCents: expense.amountCents,
				expenseDate: expense.expenseDate,
				description: expense.description
			})
			.from(expense)
			.where(
				and(
					eq(expense.workspaceId, workspaceId),
					isNull(expense.deletedAt),
					or(
						...identityChunk.map((identity) =>
							and(
								eq(expense.amountCents, identity.amountCents),
								eq(expense.expenseDate, identity.expenseDate),
								eq(expense.description, identity.description)
							)
						)
					)
				)
			)
			.limit(identityChunk.length);
		existingRows.push(...candidates);
	}
	return existingRows;
}

async function loadConfirmedBatchResult(
	executor: ImportExecutor,
	id: number,
	workspaceId: number,
	locale: string
) {
	const [batch] = await executor
		.select({
			id: importBatch.id,
			importedCount: importBatch.importedCount,
			duplicateCount: importBatch.duplicateCount,
			failedCount: importBatch.failedCount,
			failedRows: importBatch.failedRows
		})
		.from(importBatch)
		.where(and(eq(importBatch.id, id), eq(importBatch.workspaceId, workspaceId)))
		.limit(1);
	if (!batch) throw error(409, translate(locale, 'Confirmed import batch is unavailable.'));
	return {
		importBatchId: batch.id,
		importedCount: batch.importedCount,
		duplicateCount: batch.duplicateCount,
		failedCount: batch.failedCount,
		failedRows: batch.failedRows
	};
}

function importMaterialHash(value: Record<string, unknown>) {
	const fields = [
		'categoryId',
		'description',
		'amountCents',
		'currency',
		'expenseDate',
		'paymentMethodId',
		'paymentMethod',
		'vendorId',
		'vendor',
		'costCenterId',
		'costCenter',
		'competencyMonth',
		'notes',
		'status',
		'reviewStatus',
		'reviewedByUserId',
		'reviewedAt',
		'reviewRejectionReason'
	];
	return sha256(
		JSON.stringify(
			fields.map((field) => {
				const current = value[field];
				return current instanceof Date ? current.toISOString() : (current ?? null);
			})
		)
	);
}

function importIdentityKey(row: ImportExpenseIdentity) {
	return JSON.stringify([row.amountCents, row.expenseDate, row.description]);
}

function normalizeOptionalImportedCatalogName(kind: ExpenseCatalogKind, value?: string | null) {
	if (!value) return undefined;
	const normalized = normalizeCatalogName(value);
	if (!normalized) return undefined;
	try {
		assertCatalogName(kind, normalized);
	} catch {
		throw new Error(`${catalogKindLabel(kind)} is invalid.`);
	}
	return normalized;
}

async function buildCatalogLookup(
	executor: Parameters<typeof getOrCreateCatalogItems>[0],
	workspaceId: number,
	kind: ExpenseCatalogKind,
	names: Array<string | undefined>,
	locale: string = 'en'
) {
	const lookup = new Map<string, ExpenseCatalogItem>();
	const uniqueNamesByKey = new Map<string, string>();
	for (const name of names) if (name) uniqueNamesByKey.set(catalogLookupKey(name), name);
	for (const chunk of chunkImportValues(
		[...uniqueNamesByKey.values()],
		importCatalogUpsertChunkSize
	)) {
		const items = await getOrCreateCatalogItems(executor, workspaceId, kind, chunk, locale);
		for (const item of items) lookup.set(catalogLookupKey(item.name), item);
	}
	return lookup;
}

function lookupCatalogItem(lookup: Map<string, ExpenseCatalogItem>, name: string | undefined) {
	return name ? (lookup.get(catalogLookupKey(name)) ?? null) : null;
}

function translateCatalogError(locale: string, message: string) {
	for (const kind of ['Payment method', 'Vendor', 'Cost center']) {
		if (message === `${kind} is invalid.`)
			return translate(locale, '{kind} is invalid.', { kind: translate(locale, kind) });
		if (message === `${kind} must be at least 2 characters.`)
			return translate(locale, '{kind} must be at least 2 characters.', {
				kind: translate(locale, kind)
			});
		const maxMatch = new RegExp(`^${kind} must be at most (\\d+) characters\\.$`).exec(message);
		if (maxMatch)
			return translate(locale, '{kind} must be at most {count} characters.', {
				kind: translate(locale, kind),
				count: maxMatch[1]
			});
		if (message === `${kind} contains invalid characters.`)
			return translate(locale, '{kind} contains invalid characters.', {
				kind: translate(locale, kind)
			});
	}
	return message;
}
