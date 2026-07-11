import { error } from '@sveltejs/kit';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import {
	auditEvent,
	category,
	expense,
	importBatch,
	type ImportBatchFailedRow
} from '$lib/server/db/schema';
import { canReviewExpenses, canWriteExpenses } from '$lib/server/security/roles';
import {
	parseExpenseImport,
	type ExpenseImportSource,
	type ImportedExpenseRow
} from '$lib/server/utils/import';
import { parseCurrencyToCents } from '$lib/server/utils/money';
import type { WorkspaceContext } from './workspaces';
import { getActiveRules, matchCategoryRuleFromRules } from './category-rules';
import { translate } from '$lib/i18n';
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

const maxImportBytes = 1 * 1024 * 1024;
const maxImportRows = 500;

const importLockNamespace = 'expense-manager:workspace-import:v1';

export type ImportExpensesInput = {
	sourceType: ExpenseImportSource;
	defaultCategoryId?: number;
	file: File;
};

export type FailedImportRow = ImportBatchFailedRow;

export async function listImportBatches(context: WorkspaceContext) {
	return db
		.select({
			id: importBatch.id,
			sourceType: importBatch.sourceType,
			fileName: importBatch.fileName,
			rowCount: importBatch.rowCount,
			importedCount: importBatch.importedCount,
			failedCount: importBatch.failedCount,
			failedRows: importBatch.failedRows,
			createdAt: importBatch.createdAt
		})
		.from(importBatch)
		.where(eq(importBatch.workspaceId, context.workspaceId))
		.orderBy(desc(importBatch.createdAt))
		.limit(20);
}

export async function importExpenses(context: WorkspaceContext, input: ImportExpensesInput) {
	if (!canWriteExpenses(context.role))
		throw error(403, translate(context.locale, 'Permission denied.'));
	if (!input.file || input.file.size === 0)
		throw error(400, translate(context.locale, 'File is required.'));
	if (input.file.size > maxImportBytes)
		throw error(400, translate(context.locale, 'File is larger than 1 MB.'));

	const content = await input.file.text();
	const parsed = parseExpenseImport(input.sourceType, content, context.locale);
	if (parsed.rows.length > maxImportRows) {
		throw error(
			400,
			translate(context.locale, 'Import at most {count} rows at a time.', { count: maxImportRows })
		);
	}

	const categories = await db
		.select({
			id: category.id,
			name: category.name,
			isArchived: category.isArchived
		})
		.from(category)
		.where(eq(category.workspaceId, context.workspaceId));

	const activeCategories = categories.filter((item) => !item.isArchived);
	const categoriesByName = new Map(
		activeCategories.map((item) => [normalizeCatalogName(item.name).toLowerCase(), item.id])
	);
	const defaultCategory = input.defaultCategoryId
		? activeCategories.find((item) => item.id === input.defaultCategoryId)
		: null;

	if (input.defaultCategoryId && !defaultCategory)
		throw error(400, translate(context.locale, 'Default category is invalid.'));

	const rules = await getActiveRules(context.workspaceId);
	const failedRows: FailedImportRow[] = parsed.errors.map((message) => ({
		rowNumber: 0,
		message
	}));
	const validRows: Array<ImportedExpenseRow & { categoryId: number }> = [];

	for (const row of parsed.rows) {
		const categoryId =
			(row.categoryName
				? categoriesByName.get(normalizeCatalogName(row.categoryName).toLowerCase())
				: undefined) ??
			matchCategoryRuleFromRules(rules, {
				description: row.description,
				vendor: row.vendor,
				paymentMethod: row.paymentMethod
			}) ??
			defaultCategory?.id;

		if (!categoryId) {
			failedRows.push({
				rowNumber: row.rowNumber,
				message: translate(
					context.locale,
					'Category not found and no default category was selected.'
				)
			});
			continue;
		}

		try {
			parseCurrencyToCents(row.amount);
		} catch {
			failedRows.push({
				rowNumber: row.rowNumber,
				message: translate(context.locale, 'Amount is invalid.')
			});
			continue;
		}

		try {
			validRows.push({
				...row,
				paymentMethod: normalizeOptionalImportedCatalogName('paymentMethod', row.paymentMethod),
				vendor: normalizeOptionalImportedCatalogName('vendor', row.vendor),
				costCenter: normalizeOptionalImportedCatalogName('costCenter', row.costCenter),
				categoryId
			});
		} catch (catalogError) {
			failedRows.push({
				rowNumber: row.rowNumber,
				message:
					catalogError instanceof Error
						? translateCatalogError(context.locale, catalogError.message)
						: translate(context.locale, 'Invalid auxiliary catalog.')
			});
		}
	}

	const reviewStatus = canReviewExpenses(context.role) ? 'approved' : 'pending';
	const reviewedByUserId = reviewStatus === 'approved' ? context.userId : null;
	const reviewedAt = reviewStatus === 'approved' ? new Date() : null;
	let duplicateCount = 0;
	let insertedCount = 0;

	const result = await db.transaction(async (tx) => {
		// Serialize concurrent imports of the SAME workspace. pg_advisory_xact_lock is
		// bound to this transaction and auto-releases on commit/rollback, and it runs on
		// the transaction's own connection. This closes the TOCTOU window in the
		// SELECT-then-INSERT dedup below: two concurrent imports of the same file can no
		// longer both pass the duplicate check and insert the same row. Imports of
		// different workspaces use different lock keys and never block each other.
		// Hash the namespaced bigint workspace ID to one signed 64-bit lock key. This
		// supports the full bigserial range used by the schema instead of truncating
		// workspace IDs to PostgreSQL's two-argument lock form (int4, int4).
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${importLockNamespace}:${context.workspaceId}`}, 0))`
		);

		// Create the import batch record first so we can reference its id on each expense row.
		const [batch] = await tx
			.insert(importBatch)
			.values({
				workspaceId: context.workspaceId,
				uploadedByUserId: context.userId,
				sourceType: input.sourceType,
				fileName: input.file.name.slice(0, 180) || `import.${input.sourceType}`,
				rowCount: parsed.rows.length + parsed.errors.length,
				// importedCount will be updated after the dedup loop; use 0 for now
				importedCount: 0,
				failedCount: failedRows.length,
				failedRows
			})
			.returning({ id: importBatch.id });

		if (validRows.length > 0) {
			const [paymentMethods, vendors, costCenters] = await Promise.all([
				buildCatalogLookup(
					tx,
					context.workspaceId,
					'paymentMethod',
					validRows.map((row) => row.paymentMethod),
					context.locale
				),
				buildCatalogLookup(
					tx,
					context.workspaceId,
					'vendor',
					validRows.map((row) => row.vendor),
					context.locale
				),
				buildCatalogLookup(
					tx,
					context.workspaceId,
					'costCenter',
					validRows.map((row) => row.costCenter),
					context.locale
				)
			]);

			const preparedRows = validRows.map((row) => ({
				...row,
				amountCents: parseCurrencyToCents(row.amount)
			}));
			const existingRows: ImportExpenseIdentity[] = [];
			const uniqueIdentities = uniqueImportExpenseIdentities(preparedRows);

			// Each chunk uses at most 301 bind parameters (workspace plus three per
			// identity), comfortably below PostgreSQL's parameter limit. DISTINCT and
			// LIMIT bound the result to one exact triple per requested identity even if
			// historical data itself contains duplicates.
			for (const identityChunk of chunkImportValues(
				uniqueIdentities,
				importDuplicateLookupChunkSize
			)) {
				const candidates = await tx
					.selectDistinct({
						amountCents: expense.amountCents,
						expenseDate: expense.expenseDate,
						description: expense.description
					})
					.from(expense)
					.where(
						and(
							eq(expense.workspaceId, context.workspaceId),
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

			// Compare every occurrence against the snapshot taken after acquiring the
			// workspace lock. Thus a pre-existing triple skips every matching file row,
			// while repeated rows that are new in this file are all retained.
			const classification = classifyImportExpenseRows(preparedRows, existingRows);
			duplicateCount = classification.duplicateCount;
			const expenseValues: Array<typeof expense.$inferInsert> = [];

			for (const row of classification.acceptedRows) {
				const importedPaymentMethod = lookupCatalogItem(paymentMethods, row.paymentMethod);
				const importedVendor = lookupCatalogItem(vendors, row.vendor);
				const importedCostCenter = lookupCatalogItem(costCenters, row.costCenter);

				expenseValues.push({
					workspaceId: context.workspaceId,
					categoryId: row.categoryId,
					createdByUserId: context.userId,
					description: row.description,
					amountCents: row.amountCents,
					currency: context.currency,
					expenseDate: row.expenseDate,
					paymentMethodId: importedPaymentMethod?.id ?? null,
					paymentMethod: importedPaymentMethod?.name ?? null,
					vendorId: importedVendor?.id ?? null,
					vendor: importedVendor?.name ?? null,
					costCenterId: importedCostCenter?.id ?? null,
					costCenter: importedCostCenter?.name ?? null,
					notes: row.notes || null,
					importBatchId: batch.id,
					reviewStatus,
					reviewedByUserId,
					reviewedAt
				});
			}

			// At the current 18 populated columns this binds at most 1,800 values per
			// statement, keeping query text and parameters predictably bounded.
			for (const insertChunk of chunkImportValues(expenseValues, importInsertChunkSize)) {
				await tx.insert(expense).values(insertChunk);
			}
			insertedCount = expenseValues.length;

			// Update the batch with the real imported count now that we know it.
			await tx
				.update(importBatch)
				.set({ importedCount: insertedCount })
				.where(eq(importBatch.id, batch.id));
		}

		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: insertedCount > 0 ? 'expense_import.completed' : 'expense_import.failed',
			entityType: 'import_batch',
			entityId: String(batch.id),
			metadata: {
				sourceType: input.sourceType,
				importedCount: insertedCount,
				duplicateCount,
				failedCount: failedRows.length,
				rowCount: parsed.rows.length + parsed.errors.length,
				reviewStatus
			}
		});

		return batch;
	});

	return {
		importBatchId: result.id,
		importedCount: insertedCount,
		duplicateCount,
		failedCount: failedRows.length,
		failedRows
	};
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
	for (const name of names) {
		if (name) uniqueNamesByKey.set(catalogLookupKey(name), name);
	}

	for (const nameChunk of chunkImportValues(
		[...uniqueNamesByKey.values()],
		importCatalogUpsertChunkSize
	)) {
		const items = await getOrCreateCatalogItems(executor, workspaceId, kind, nameChunk, locale);
		for (const item of items) lookup.set(catalogLookupKey(item.name), item);
	}

	return lookup;
}

function lookupCatalogItem(lookup: Map<string, ExpenseCatalogItem>, name: string | undefined) {
	return name ? (lookup.get(catalogLookupKey(name)) ?? null) : null;
}

function translateCatalogError(locale: string, message: string) {
	for (const kind of ['Payment method', 'Vendor', 'Cost center']) {
		if (message === `${kind} is invalid.`) {
			return translate(locale, '{kind} is invalid.', { kind: translate(locale, kind) });
		}
		if (message === `${kind} must be at least 2 characters.`) {
			return translate(locale, '{kind} must be at least 2 characters.', {
				kind: translate(locale, kind)
			});
		}
		const maxMatch = new RegExp(`^${kind} must be at most (\\d+) characters\\.$`).exec(message);
		if (maxMatch) {
			return translate(locale, '{kind} must be at most {count} characters.', {
				kind: translate(locale, kind),
				count: maxMatch[1]
			});
		}
		if (message === `${kind} contains invalid characters.`) {
			return translate(locale, '{kind} contains invalid characters.', {
				kind: translate(locale, kind)
			});
		}
	}

	return message;
}
