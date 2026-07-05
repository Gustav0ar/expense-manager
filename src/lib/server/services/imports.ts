import { error } from '@sveltejs/kit';
import { and, desc, eq, isNull } from 'drizzle-orm';
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
	getOrCreateCatalogItem,
	normalizeCatalogName,
	type ExpenseCatalogItem,
	type ExpenseCatalogKind
} from './expense-catalogs';

const maxImportBytes = 1 * 1024 * 1024;
const maxImportRows = 500;

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

			const seenInBatch = new Set<string>();

			for (const row of validRows) {
				const amountCents = parseCurrencyToCents(row.amount);
				const fp = `${amountCents}|${row.expenseDate}|${row.description}`;

				// Only check the DB for the first occurrence of a fingerprint in this batch.
				// Rows with the same fingerprint already inserted in this batch bypass the DB
				// check so that legitimately identical transactions within one import are all
				// kept (the DB SELECT runs inside the transaction and would otherwise see rows
				// we just inserted, silently dropping genuine duplicates).
				if (!seenInBatch.has(fp)) {
					// NOTE: This SELECT-then-INSERT dedup has a TOCTOU window under concurrent
					// imports from the same workspace. A unique partial index on
					// (workspace_id, amount_cents, expense_date, description) WHERE deleted_at IS NULL
					// would make this race-safe. Without it, concurrent imports of the same file
					// can produce duplicates.
					const [duplicate] = await tx
						.select({ id: expense.id })
						.from(expense)
						.where(
							and(
								eq(expense.workspaceId, context.workspaceId),
								eq(expense.amountCents, amountCents),
								eq(expense.expenseDate, row.expenseDate),
								eq(expense.description, row.description),
								isNull(expense.deletedAt)
							)
						)
						.limit(1);

					if (duplicate) {
						duplicateCount++;
						continue;
					}
				}

				const importedPaymentMethod = lookupCatalogItem(paymentMethods, row.paymentMethod);
				const importedVendor = lookupCatalogItem(vendors, row.vendor);
				const importedCostCenter = lookupCatalogItem(costCenters, row.costCenter);

				await tx.insert(expense).values({
					workspaceId: context.workspaceId,
					categoryId: row.categoryId,
					createdByUserId: context.userId,
					description: row.description,
					amountCents,
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
				seenInBatch.add(fp);
				insertedCount++;
			}

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
	executor: Parameters<typeof getOrCreateCatalogItem>[0],
	workspaceId: number,
	kind: ExpenseCatalogKind,
	names: Array<string | undefined>,
	locale: string = 'en'
) {
	const lookup = new Map<string, ExpenseCatalogItem>();
	const uniqueNames = Array.from(new Set(names.filter(Boolean) as string[]));

	for (const name of uniqueNames) {
		const item = await getOrCreateCatalogItem(executor, workspaceId, kind, name, locale);
		lookup.set(catalogLookupKey(name), item);
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
