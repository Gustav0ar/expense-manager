import { error } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
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
import { parseBrlToCents } from '$lib/server/utils/money';
import type { WorkspaceContext } from './workspaces';
import { getActiveRules, matchCategoryRuleFromRules } from './category-rules';
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
	if (!canWriteExpenses(context.role)) throw error(403, 'Permissao insuficiente.');
	if (!input.file || input.file.size === 0) throw error(400, 'Arquivo obrigatório.');
	if (input.file.size > maxImportBytes) throw error(400, 'Arquivo acima de 1 MB.');

	const content = await input.file.text();
	const parsed = parseExpenseImport(input.sourceType, content);
	if (parsed.rows.length > maxImportRows) {
		throw error(400, `Importe no maximo ${maxImportRows} linhas por vez.`);
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

	if (input.defaultCategoryId && !defaultCategory) throw error(400, 'Categoria padrão invalida.');

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
			defaultCategory?.id ??
			matchCategoryRuleFromRules(rules, {
				description: row.description,
				vendor: row.vendor,
				paymentMethod: row.paymentMethod
			});

		if (!categoryId) {
			failedRows.push({
				rowNumber: row.rowNumber,
				message: 'Categoria não encontrada e nenhuma categoria padrão foi selecionada.'
			});
			continue;
		}

		try {
			parseBrlToCents(row.amount);
		} catch {
			failedRows.push({ rowNumber: row.rowNumber, message: 'Valor inválido.' });
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
					catalogError instanceof Error ? catalogError.message : 'Cadastro auxiliar inválido.'
			});
		}
	}

	const reviewStatus = canReviewExpenses(context.role) ? 'approved' : 'pending';
	const reviewedByUserId = reviewStatus === 'approved' ? context.userId : null;
	const reviewedAt = reviewStatus === 'approved' ? new Date() : null;

	const result = await db.transaction(async (tx) => {
		const [batch] = await tx
			.insert(importBatch)
			.values({
				workspaceId: context.workspaceId,
				uploadedByUserId: context.userId,
				sourceType: input.sourceType,
				fileName: input.file.name.slice(0, 180) || `import.${input.sourceType}`,
				rowCount: parsed.rows.length + parsed.errors.length,
				importedCount: validRows.length,
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
					validRows.map((row) => row.paymentMethod)
				),
				buildCatalogLookup(
					tx,
					context.workspaceId,
					'vendor',
					validRows.map((row) => row.vendor)
				),
				buildCatalogLookup(
					tx,
					context.workspaceId,
					'costCenter',
					validRows.map((row) => row.costCenter)
				)
			]);

			await tx.insert(expense).values(
				validRows.map((row) => {
					const importedPaymentMethod = lookupCatalogItem(paymentMethods, row.paymentMethod);
					const importedVendor = lookupCatalogItem(vendors, row.vendor);
					const importedCostCenter = lookupCatalogItem(costCenters, row.costCenter);

					return {
						workspaceId: context.workspaceId,
						categoryId: row.categoryId,
						createdByUserId: context.userId,
						description: row.description,
						amountCents: parseBrlToCents(row.amount),
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
					};
				})
			);
		}

		await tx.insert(auditEvent).values({
			workspaceId: context.workspaceId,
			actorUserId: context.userId,
			action: validRows.length > 0 ? 'expense_import.completed' : 'expense_import.failed',
			entityType: 'import_batch',
			entityId: String(batch.id),
			metadata: {
				sourceType: input.sourceType,
				importedCount: validRows.length,
				failedCount: failedRows.length,
				rowCount: parsed.rows.length + parsed.errors.length,
				reviewStatus
			}
		});

		return batch;
	});

	return {
		importBatchId: result.id,
		importedCount: validRows.length,
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
		throw new Error(`${catalogKindLabel(kind)} inválido.`);
	}

	return normalized;
}

async function buildCatalogLookup(
	executor: Parameters<typeof getOrCreateCatalogItem>[0],
	workspaceId: number,
	kind: ExpenseCatalogKind,
	names: Array<string | undefined>
) {
	const lookup = new Map<string, ExpenseCatalogItem>();
	const uniqueNames = Array.from(new Set(names.filter(Boolean) as string[]));

	for (const name of uniqueNames) {
		const item = await getOrCreateCatalogItem(executor, workspaceId, kind, name);
		lookup.set(catalogLookupKey(name), item);
	}

	return lookup;
}

function lookupCatalogItem(lookup: Map<string, ExpenseCatalogItem>, name: string | undefined) {
	return name ? (lookup.get(catalogLookupKey(name)) ?? null) : null;
}
