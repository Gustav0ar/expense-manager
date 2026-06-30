import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { user } from '$lib/server/db/auth.schema';
import {
	auditEvent,
	category,
	categoryBudget,
	categoryRule,
	expense,
	expenseAttachment,
	importBatch,
	paymentMethod,
	recurringExpense,
	vendor,
	workspace,
	workspaceInvitation,
	workspaceMember
} from '$lib/server/db/schema';
import { db } from '$lib/server/db';
import { sha256 } from '$lib/server/utils/crypto';
import { formatCents } from '$lib/utils/format';
import { getAttachmentForDownload, maxAttachmentBytes, saveExpenseAttachment } from './attachments';
import {
	archiveCategoryRule,
	createCategoryRule,
	getActiveRules,
	listCategoryRules,
	matchCategoryRule,
	matchCategoryRuleFromRules
} from './category-rules';
import {
	deleteBudget,
	getBudgetSummary,
	listBudgetStatus,
	sendBudgetAlerts,
	upsertBudget
} from './budgets';
import { acceptInvitation, getPendingInvitation } from './invitations';
import {
	createExpense,
	deleteExpense,
	getDashboard,
	getExpenseListSummary,
	getReport,
	listExpenses,
	reviewExpense,
	updateExpense,
	updateExpensePaymentStatus
} from './expenses';
import {
	getOrCreateCatalogItem,
	listExpenseCatalogs,
	removeExpenseCatalogItem,
	updateExpenseCatalogItem
} from './expense-catalogs';
import { importExpenses, listImportBatches } from './imports';
import { inviteMember, type WorkspaceContext } from './workspaces';

const workspaceIds: number[] = [];
const userIds: string[] = [];
const uploadDirs: string[] = [];

describe('server service integration', () => {
	afterEach(async () => {
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

	it('persists failed-only imports with batch counters and failed row details', async () => {
		const fixture = await createWorkspaceFixture();
		const file = new File(['Data;Descricao;Valor\nbad;;abc\n'], 'falhas.csv', {
			type: 'text/csv'
		});

		const result = await importExpenses(fixture.context, { sourceType: 'csv', file });

		expect(result.importBatchId).toBeGreaterThan(0);
		expect(result).toMatchObject({ importedCount: 0, failedCount: 1 });
		expect(result.failedRows[0]?.message).toContain('data, descrição ou valor');

		const [batch] = await db
			.select()
			.from(importBatch)
			.where(eq(importBatch.id, result.importBatchId));
		expect(batch).toMatchObject({
			rowCount: 1,
			importedCount: 0,
			failedCount: 1,
			failedRows: result.failedRows
		});

		const batches = await listImportBatches(fixture.context);
		expect(batches[0]).toMatchObject({
			id: result.importBatchId,
			rowCount: 1,
			importedCount: 0,
			failedCount: 1,
			failedRows: result.failedRows
		});
	});

	it('records valid import rows rejected by business validation', async () => {
		const fixture = await createWorkspaceFixture();
		const file = new File(
			['Data;Descricao;Valor;Categoria\n26/06/2026;Compra;35,50;Inexistente\n'],
			'sem-categoria.csv',
			{
				type: 'text/csv'
			}
		);

		const result = await importExpenses(fixture.context, { sourceType: 'csv', file });

		expect(result).toMatchObject({ importedCount: 0, failedCount: 1 });
		expect(result.failedRows[0]).toMatchObject({
			rowNumber: 2,
			message: 'Categoria não encontrada e nenhuma categoria padrão foi selecionada.'
		});
	});

	it('rejects invalid defaults and import files beyond the row limit', async () => {
		const fixture = await createWorkspaceFixture();
		const rows = Array.from({ length: 501 }, (_, index) => `26/06/2026;Compra ${index};35,50`).join(
			'\n'
		);

		await expect(
			importExpenses(fixture.context, {
				sourceType: 'csv',
				defaultCategoryId: fixture.categoryId + 999_999,
				file: new File(['Data;Descricao;Valor\n26/06/2026;Compra;35,50\n'], 'padrao.csv', {
					type: 'text/csv'
				})
			})
		).rejects.toMatchObject({ status: 400 });

		await expect(
			importExpenses(fixture.context, {
				sourceType: 'csv',
				defaultCategoryId: fixture.categoryId,
				file: new File([`Data;Descricao;Valor\n${rows}\n`], 'muitas.csv', { type: 'text/csv' })
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it('imports valid rows while preserving failed row accounting', async () => {
		const fixture = await createWorkspaceFixture();
		const file = new File(
			['Data;Descricao;Valor\n26/06/2026;Produto limpeza;35,50\nbad;;abc\n'],
			'parcial.csv',
			{ type: 'text/csv' }
		);

		const result = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file
		});

		expect(result).toMatchObject({ importedCount: 1, failedCount: 1 });

		const [batch] = await db
			.select()
			.from(importBatch)
			.where(eq(importBatch.id, result.importBatchId));
		expect(batch.rowCount).toBe(2);

		const createdExpenses = await db
			.select({ description: expense.description, amountCents: expense.amountCents })
			.from(expense)
			.where(eq(expense.importBatchId, result.importBatchId));
		expect(createdExpenses).toEqual([{ description: 'Produto limpeza', amountCents: 3550 }]);
	});

	it('applies automatic category rules during imports and archives them safely', async () => {
		const fixture = await createWorkspaceFixture();
		const [supplyCategory] = await db
			.insert(category)
			.values({
				workspaceId: fixture.context.workspaceId,
				name: 'Insumos',
				color: '#2563eb',
				icon: '📦'
			})
			.returning({ id: category.id });

		const createdRule = await createCategoryRule(fixture.context, {
			name: 'Fornecedor ACME',
			categoryId: supplyCategory.id,
			matchTarget: 'vendor',
			pattern: 'acme',
			priority: 10
		});
		expect(createdRule.id).toBeGreaterThan(0);
		await expect(matchCategoryRule(fixture.context, { vendor: 'ACME Ltda' })).resolves.toBe(
			supplyCategory.id
		);
		await expect(listCategoryRules(fixture.context)).resolves.toMatchObject([
			{
				id: createdRule.id,
				categoryId: supplyCategory.id,
				matchTarget: 'vendor',
				isActive: true
			}
		]);

		const staticRules: Awaited<ReturnType<typeof getActiveRules>> = [
			{
				categoryId: fixture.categoryId,
				matchTarget: 'description',
				pattern: 'limpeza',
				patternNormalized: 'limpeza'
			},
			{
				categoryId: supplyCategory.id,
				matchTarget: 'payment',
				pattern: 'pix',
				patternNormalized: 'pix'
			}
		];
		expect(
			matchCategoryRuleFromRules(staticRules, {
				description: 'Produto de limpeza',
				paymentMethod: 'Boleto'
			})
		).toBe(fixture.categoryId);
		expect(
			matchCategoryRuleFromRules(staticRules.slice(1), {
				description: 'Sem regra',
				paymentMethod: 'Pix'
			})
		).toBe(supplyCategory.id);
		expect(matchCategoryRuleFromRules(staticRules, {})).toBeNull();

		const memberContext = await createMemberContext(fixture, 'member');
		await expect(
			createCategoryRule(memberContext, {
				name: 'Sem permissao',
				categoryId: supplyCategory.id,
				matchTarget: 'description',
				pattern: 'teste',
				priority: 100
			})
		).rejects.toMatchObject({ status: 403 });
		await expect(
			createCategoryRule(fixture.context, {
				name: 'Categoria inválida',
				categoryId: supplyCategory.id + 999_999,
				matchTarget: 'description',
				pattern: 'teste',
				priority: 100
			})
		).rejects.toMatchObject({ status: 400 });
		await expect(
			archiveCategoryRule(fixture.context, createdRule.id + 999_999)
		).rejects.toMatchObject({ status: 404 });

		const file = new File(
			[
				'Data;Descricao;Valor;Fornecedor;Centro de custo\n26/06/2026;Compra fiscal;35,50;ACME Ltda;Operacao\n'
			],
			'regras.csv',
			{ type: 'text/csv' }
		);

		const result = await importExpenses(fixture.context, { sourceType: 'csv', file });

		expect(result).toMatchObject({ importedCount: 1, failedCount: 0 });
		const [createdExpense] = await db
			.select({
				categoryId: expense.categoryId,
				vendorId: expense.vendorId,
				costCenterId: expense.costCenterId,
				vendor: expense.vendor,
				costCenter: expense.costCenter,
				reviewStatus: expense.reviewStatus
			})
			.from(expense)
			.where(eq(expense.importBatchId, result.importBatchId));
		expect(createdExpense).toEqual({
			categoryId: supplyCategory.id,
			vendorId: expect.any(Number),
			costCenterId: expect.any(Number),
			vendor: 'ACME Ltda',
			costCenter: 'Operacao',
			reviewStatus: 'approved'
		});

		await archiveCategoryRule(fixture.context, createdRule.id);
		await expect(matchCategoryRule(fixture.context, { vendor: 'ACME Ltda' })).resolves.toBeNull();
		const [archivedRule] = await db
			.select({ isActive: categoryRule.isActive })
			.from(categoryRule)
			.where(eq(categoryRule.id, createdRule.id));
		expect(archivedRule.isActive).toBe(false);
	});

	it('enforces expense review and payment workflow before reporting totals', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');
		const initialCatalogs = await createExpenseCatalogs(fixture.context, {
			paymentMethod: 'Boleto',
			vendor: 'Fornecedor A',
			costCenter: 'Operacao'
		});
		const updatedCatalogs = await createExpenseCatalogs(fixture.context, {
			paymentMethod: 'Boleto',
			vendor: 'Fornecedor B',
			costCenter: 'Diretoria'
		});

		const created = await createExpense(memberContext, {
			categoryId: fixture.categoryId,
			description: 'Compra para revisar',
			amount: '120,00',
			expenseDate: '2026-06-26',
			...initialCatalogs,
			competencyMonth: '2026-06'
		});
		const expenseId = created.id;

		const pendingList = await listExpenses(fixture.context, { reviewStatus: 'pending' });
		expect(pendingList.items[0]).toMatchObject({
			id: expenseId,
			reviewStatus: 'pending',
			paymentStatus: 'unpaid',
			paymentMethodId: initialCatalogs.paymentMethodId,
			vendorId: initialCatalogs.vendorId,
			costCenterId: initialCatalogs.costCenterId,
			paymentMethod: 'Boleto',
			vendor: 'Fornecedor A',
			costCenter: 'Operacao',
			competencyMonth: '2026-06-01'
		});
		await updateExpense(memberContext, expenseId, {
			categoryId: fixture.categoryId,
			description: 'Compra revisada',
			amount: '130,00',
			expenseDate: '2026-06-26',
			...updatedCatalogs,
			competencyMonth: '2026-06',
			notes: 'Atualizada'
		});
		const updatedPendingList = await listExpenses(fixture.context, { reviewStatus: 'pending' });
		expect(updatedPendingList.items[0]).toMatchObject({
			id: expenseId,
			description: 'Compra revisada',
			amountCents: 13_000,
			vendorId: updatedCatalogs.vendorId,
			costCenterId: updatedCatalogs.costCenterId,
			vendor: 'Fornecedor B',
			costCenter: 'Diretoria',
			notes: 'Atualizada'
		});
		await expect(
			updateExpensePaymentStatus(fixture.context, expenseId, {
				paymentStatus: 'paid',
				paidAt: '2026-06-26'
			})
		).rejects.toMatchObject({ status: 404 });
		await expect(
			reviewExpense(memberContext, expenseId, { reviewStatus: 'approved' })
		).rejects.toMatchObject({ status: 403 });

		let dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(0);

		await reviewExpense(fixture.context, expenseId, { reviewStatus: 'approved' });
		dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(13_000);
		await expect(
			getReport(fixture.context, {
				from: '2026-06-01',
				to: '2026-06-30',
				groupBy: 'payment'
			})
		).resolves.toEqual([
			{
				key: 'Boleto',
				label: 'Boleto',
				color: '#2563eb',
				totalCents: 13_000
			}
		]);

		await updateExpensePaymentStatus(fixture.context, expenseId, {
			paymentStatus: 'reconciled',
			paidAt: '2026-06-27'
		});
		let [workflowRow] = await db
			.select({
				reviewStatus: expense.reviewStatus,
				paymentStatus: expense.paymentStatus,
				paidAt: expense.paidAt,
				reconciledByUserId: expense.reconciledByUserId
			})
			.from(expense)
			.where(eq(expense.id, expenseId));
		expect(workflowRow).toEqual({
			reviewStatus: 'approved',
			paymentStatus: 'reconciled',
			paidAt: '2026-06-27',
			reconciledByUserId: fixture.context.userId
		});

		await reviewExpense(fixture.context, expenseId, {
			reviewStatus: 'rejected',
			reason: 'Duplicada'
		});
		[workflowRow] = await db
			.select({
				reviewStatus: expense.reviewStatus,
				paymentStatus: expense.paymentStatus,
				paidAt: expense.paidAt,
				reconciledByUserId: expense.reconciledByUserId
			})
			.from(expense)
			.where(eq(expense.id, expenseId));
		expect(workflowRow).toEqual({
			reviewStatus: 'rejected',
			paymentStatus: 'unpaid',
			paidAt: null,
			reconciledByUserId: null
		});
		dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(0);

		await deleteExpense(fixture.context, expenseId);
		const afterDelete = await listExpenses(fixture.context, { q: 'Compra revisada' });
		expect(afterDelete.items).toHaveLength(0);
	});

	it('paginates installments and covers expense validation branches', async () => {
		const fixture = await createWorkspaceFixture();
		const viewerContext = await createMemberContext(fixture, 'viewer');
		await expect(
			createExpense(viewerContext, {
				categoryId: fixture.categoryId,
				description: 'Sem permissao',
				amount: '10,00',
				expenseDate: '2026-06-01'
			})
		).rejects.toMatchObject({ status: 403 });

		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Compra parcelada',
			amount: '50,00',
			expenseDate: '2026-06-01',
			competencyMonth: '2026-06',
			installments: 2
		});
		expect(created.ids).toHaveLength(2);

		const firstPage = await listExpenses(fixture.context, { limit: 1 });
		expect(firstPage.items).toHaveLength(1);
		expect(firstPage.items[0]).toMatchObject({
			description: 'Compra parcelada',
			installmentNumber: 2,
			installmentsTotal: 2,
			competencyMonth: '2026-07-01'
		});
		expect(firstPage.nextCursor).toBeTruthy();

		const secondPage = await listExpenses(fixture.context, {
			limit: 1,
			cursor: firstPage.nextCursor ?? undefined
		});
		expect(secondPage.items[0]).toMatchObject({
			description: 'Compra parcelada',
			installmentNumber: 1,
			installmentsTotal: 2,
			competencyMonth: '2026-06-01'
		});

		await updateExpensePaymentStatus(fixture.context, created.id, { paymentStatus: 'paid' });
		let [paymentRow] = await db
			.select({ paymentStatus: expense.paymentStatus, paidAt: expense.paidAt })
			.from(expense)
			.where(eq(expense.id, created.id));
		expect(paymentRow).toEqual({
			paymentStatus: 'paid',
			paidAt: new Date().toISOString().slice(0, 10)
		});
		await updateExpensePaymentStatus(fixture.context, created.id, { paymentStatus: 'unpaid' });
		[paymentRow] = await db
			.select({ paymentStatus: expense.paymentStatus, paidAt: expense.paidAt })
			.from(expense)
			.where(eq(expense.id, created.id));
		expect(paymentRow).toEqual({ paymentStatus: 'unpaid', paidAt: null });

		await expect(
			updateExpense(fixture.context, created.id + 999_999, {
				categoryId: fixture.categoryId,
				description: 'Inexistente',
				amount: '10,00',
				expenseDate: '2026-06-01'
			})
		).rejects.toMatchObject({ status: 404 });
		await expect(
			updateExpense(fixture.context, created.id, {
				categoryId: fixture.categoryId + 999_999,
				description: 'Categoria invalida',
				amount: '10,00',
				expenseDate: '2026-06-01'
			})
		).rejects.toMatchObject({ status: 400 });
		await expect(deleteExpense(fixture.context, created.id + 999_999)).rejects.toMatchObject({
			status: 404
		});

		await expect(
			getReport(fixture.context, {
				from: '2026-01-01',
				to: '2026-12-31',
				groupBy: 'category',
				categoryId: fixture.categoryId
			})
		).resolves.toEqual([
			expect.objectContaining({
				key: String(fixture.categoryId),
				totalCents: 10_000
			})
		]);
		await expect(
			getReport(fixture.context, {
				from: '2026-01-01',
				to: '2026-12-31',
				groupBy: 'year',
				categoryId: fixture.categoryId
			})
		).resolves.toEqual([expect.objectContaining({ totalCents: 10_000 })]);
	});

	it('deduplicates controlled expense catalogs per workspace', async () => {
		const fixture = await createWorkspaceFixture();
		const otherFixture = await createWorkspaceFixture();

		const pix = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'paymentMethod',
			' Pix '
		);
		const pixUpper = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'paymentMethod',
			'PIX'
		);
		const otherPix = await getOrCreateCatalogItem(
			db,
			otherFixture.context.workspaceId,
			'paymentMethod',
			'Pix'
		);
		const supplier = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'vendor',
			'ACME  Servicos'
		);
		const duplicateSupplier = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'vendor',
			'Fornecedor B'
		);
		const department = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'costCenter',
			'Administrativo'
		);

		expect(pixUpper.id).toBe(pix.id);
		expect(otherPix.id).not.toBe(pix.id);
		await expect(listExpenseCatalogs(fixture.context)).resolves.toMatchObject({
			paymentMethods: [expect.objectContaining({ id: pix.id, name: 'PIX' })],
			vendors: [
				expect.objectContaining({ id: supplier.id, name: 'ACME Servicos', expenseCount: 0 }),
				expect.objectContaining({ id: duplicateSupplier.id, name: 'Fornecedor B' })
			],
			costCenters: [expect.objectContaining({ id: department.id, name: 'Administrativo' })]
		});
		await expect(
			updateExpenseCatalogItem(fixture.context, {
				kind: 'vendor',
				id: duplicateSupplier.id,
				name: 'acme servicos'
			})
		).rejects.toMatchObject({ status: 400 });

		await updateExpenseCatalogItem(fixture.context, {
			kind: 'vendor',
			id: supplier.id,
			name: 'ACME Brasil'
		});
		const created = await createExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Fornecedor controlado',
			amount: '10,00',
			expenseDate: '2026-06-10',
			paymentMethodId: pix.id,
			vendorId: supplier.id,
			costCenterId: department.id
		});
		await expect(listExpenses(fixture.context, { q: 'ACME Brasil' })).resolves.toMatchObject({
			items: [expect.objectContaining({ id: created.id, vendor: 'ACME Brasil' })]
		});

		const recurringOnlyPayment = await getOrCreateCatalogItem(
			db,
			fixture.context.workspaceId,
			'paymentMethod',
			'Cartao recorrente'
		);
		const [recurringOnlySchedule] = await db
			.insert(recurringExpense)
			.values({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Assinatura sem despesa',
				amountCents: 10_000,
				frequency: 'monthly',
				intervalCount: 1,
				startDate: '2026-06-01',
				nextRunDate: '2026-06-01',
				paymentMethodId: recurringOnlyPayment.id,
				paymentMethod: recurringOnlyPayment.name
			})
			.returning({ id: recurringExpense.id });
		await expect(
			removeExpenseCatalogItem(fixture.context, {
				kind: 'paymentMethod',
				id: recurringOnlyPayment.id
			})
		).resolves.toMatchObject({
			mode: 'deleted',
			item: expect.objectContaining({ expenseCount: 0, recurringCount: 1 })
		});
		await expect(
			db
				.select({ id: paymentMethod.id })
				.from(paymentMethod)
				.where(eq(paymentMethod.id, recurringOnlyPayment.id))
		).resolves.toEqual([]);
		const [recurringAfterCatalogDelete] = await db
			.select({
				paymentMethodId: recurringExpense.paymentMethodId,
				paymentMethod: recurringExpense.paymentMethod
			})
			.from(recurringExpense)
			.where(eq(recurringExpense.id, recurringOnlySchedule.id));
		expect(recurringAfterCatalogDelete).toEqual({
			paymentMethodId: null,
			paymentMethod: 'Cartao recorrente'
		});

		await expect(
			removeExpenseCatalogItem(fixture.context, { kind: 'vendor', id: duplicateSupplier.id })
		).resolves.toMatchObject({ mode: 'deleted' });
		await expect(
			db.select({ id: vendor.id }).from(vendor).where(eq(vendor.id, duplicateSupplier.id))
		).resolves.toEqual([]);

		await expect(
			removeExpenseCatalogItem(fixture.context, { kind: 'vendor', id: supplier.id })
		).resolves.toMatchObject({
			mode: 'archived',
			item: expect.objectContaining({ expenseCount: 1 })
		});
		const [archivedSupplier] = await db
			.select({ isArchived: vendor.isArchived })
			.from(vendor)
			.where(eq(vendor.id, supplier.id));
		expect(archivedSupplier.isArchived).toBe(true);
		await expect(listExpenseCatalogs(fixture.context)).resolves.toMatchObject({
			vendors: []
		});
		await updateExpense(fixture.context, created.id, {
			categoryId: fixture.categoryId,
			description: 'Fornecedor arquivado preservado',
			amount: '11,00',
			expenseDate: '2026-06-11',
			paymentMethodId: pix.id,
			vendorId: supplier.id,
			costCenterId: department.id
		});
		await expect(
			listExpenses(fixture.context, { q: 'arquivado preservado' })
		).resolves.toMatchObject({
			items: [expect.objectContaining({ id: created.id, vendor: 'ACME Brasil' })]
		});
		await expect(
			createExpense(fixture.context, {
				categoryId: fixture.categoryId,
				description: 'Fornecedor arquivado novo uso',
				amount: '10,00',
				expenseDate: '2026-06-10',
				vendorId: supplier.id
			})
		).rejects.toMatchObject({ status: 400 });
		await expect(
			createExpense(fixture.context, {
				categoryId: fixture.categoryId,
				description: 'Fornecedor controlado',
				amount: '10,00',
				expenseDate: '2026-06-10',
				paymentMethodId: otherPix.id
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it('sends budget alerts from approved spending only', async () => {
		const previousDeliveryMode = process.env.EMAIL_DELIVERY;
		process.env.EMAIL_DELIVERY = 'log';
		const emailLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');

		try {
			const [unsetCategory] = await db
				.insert(category)
				.values({
					workspaceId: fixture.context.workspaceId,
					name: 'Sem meta',
					color: '#64748b',
					icon: '🧾'
				})
				.returning({ id: category.id });
			expect(unsetCategory.id).toBeGreaterThan(0);
			await expect(
				upsertBudget(memberContext, {
					categoryId: fixture.categoryId,
					periodMonth: '2026-06',
					amount: '100,00',
					warningThresholdPct: 80
				})
			).rejects.toMatchObject({ status: 403 });
			await expect(deleteBudget(memberContext, 1)).rejects.toMatchObject({ status: 403 });
			await expect(sendBudgetAlerts(memberContext, '2026-06')).rejects.toMatchObject({
				status: 403
			});
			await expect(
				upsertBudget(fixture.context, {
					categoryId: fixture.categoryId + 999_999,
					periodMonth: '2026-06',
					amount: '100,00',
					warningThresholdPct: 80
				})
			).rejects.toMatchObject({ status: 400 });

			await upsertBudget(fixture.context, {
				categoryId: fixture.categoryId,
				periodMonth: '2026-06',
				amount: '100,00',
				warningThresholdPct: 80
			});
			const [budgetRow] = await db
				.select({ id: categoryBudget.id, periodMonth: categoryBudget.periodMonth })
				.from(categoryBudget)
				.where(eq(categoryBudget.workspaceId, fixture.context.workspaceId));
			expect(budgetRow.periodMonth).toBe('2026-06-01');
			await expect(sendBudgetAlerts(fixture.context, '2026-06')).resolves.toEqual({
				sentCount: 0,
				alertCount: 0
			});
			let budgetStatuses = await listBudgetStatus(fixture.context, '2026-06');
			expect(budgetStatuses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ categoryId: fixture.categoryId, status: 'ok', usagePct: 0 }),
					expect.objectContaining({ categoryId: unsetCategory.id, status: 'unset', usagePct: null })
				])
			);

			await createExpense(fixture.context, {
				categoryId: fixture.categoryId,
				description: 'Gasto aprovado',
				amount: '90,00',
				expenseDate: '2026-06-15'
			});
			await createExpense(memberContext, {
				categoryId: fixture.categoryId,
				description: 'Gasto pendente',
				amount: '1.000,00',
				expenseDate: '2026-06-16'
			});
			budgetStatuses = await listBudgetStatus(fixture.context, '2026-06');
			expect(budgetStatuses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						categoryId: fixture.categoryId,
						status: 'warning',
						usagePct: 90
					})
				])
			);

			const result = await sendBudgetAlerts(fixture.context, '2026-06');

			expect(result).toEqual({ sentCount: 1, alertCount: 1 });
			expect(emailLog).toHaveBeenCalledWith(
				'[email:dev]',
				expect.objectContaining({
					to: expect.stringContaining('@example.com'),
					text: expect.stringContaining(`${formatCents(9000)} de ${formatCents(10000)}`)
				})
			);
			expect(emailLog).not.toHaveBeenCalledWith(
				'[email:dev]',
				expect.objectContaining({
					text: expect.stringContaining(formatCents(109000))
				})
			);

			await createExpense(fixture.context, {
				categoryId: fixture.categoryId,
				description: 'Gasto acima',
				amount: '20,00',
				expenseDate: '2026-06-17'
			});
			budgetStatuses = await listBudgetStatus(fixture.context, '2026-06');
			expect(budgetStatuses).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ categoryId: fixture.categoryId, status: 'over', usagePct: 110 })
				])
			);
			await expect(getBudgetSummary(fixture.context, '2026-06')).resolves.toMatchObject({
				totalBudgetCents: 10_000,
				spentCents: 11_000,
				remainingCents: -1_000,
				usagePct: 110,
				overBudgetCount: 1,
				warningCount: 0
			});

			await deleteBudget(fixture.context, budgetRow.id);
			await expect(deleteBudget(fixture.context, budgetRow.id)).rejects.toMatchObject({
				status: 404
			});
			const remainingBudgets = await db
				.select({ id: categoryBudget.id })
				.from(categoryBudget)
				.where(eq(categoryBudget.workspaceId, fixture.context.workspaceId));
			expect(remainingBudgets).toEqual([]);
		} finally {
			if (previousDeliveryMode === undefined) {
				delete process.env.EMAIL_DELIVERY;
			} else {
				process.env.EMAIL_DELIVERY = previousDeliveryMode;
			}
			emailLog.mockRestore();
		}
	});

	it('accepts an invitation only once under repeated submission', async () => {
		const fixture = await createWorkspaceFixture();
		const invited = await createUser('invited');
		const token = `invite-${randomUUID()}`;
		const [invitation] = await db
			.insert(workspaceInvitation)
			.values({
				workspaceId: fixture.context.workspaceId,
				email: invited.email,
				role: 'viewer',
				tokenHash: sha256(token),
				invitedByUserId: fixture.context.userId,
				expiresAt: new Date(Date.now() + 60_000)
			})
			.returning({ id: workspaceInvitation.id });

		await expect(getPendingInvitation(token)).resolves.toMatchObject({
			id: invitation.id,
			email: invited.email,
			workspaceId: fixture.context.workspaceId
		});
		await expect(acceptInvitation(token, invited.id, invited.email)).resolves.toBe(
			fixture.context.workspaceId
		);
		await expect(getPendingInvitation(token)).resolves.toBeNull();
		await expect(acceptInvitation(token, invited.id, invited.email)).rejects.toMatchObject({
			status: 404
		});

		const [accepted] = await db
			.select({ status: workspaceInvitation.status })
			.from(workspaceInvitation)
			.where(eq(workspaceInvitation.id, invitation.id));
		expect(accepted.status).toBe('accepted');

		const membership = await db
			.select({ role: workspaceMember.role })
			.from(workspaceMember)
			.where(
				and(
					eq(workspaceMember.workspaceId, fixture.context.workspaceId),
					eq(workspaceMember.userId, invited.id)
				)
			);
		expect(membership).toEqual([{ role: 'viewer' }]);

		const auditRows = await db
			.select({ id: auditEvent.id })
			.from(auditEvent)
			.where(
				and(
					eq(auditEvent.workspaceId, fixture.context.workspaceId),
					eq(auditEvent.action, 'workspace_invitation.accepted')
				)
			);
		expect(auditRows).toHaveLength(1);
	});

	it('rejects invitation acceptance when the authenticated email differs', async () => {
		const fixture = await createWorkspaceFixture();
		const invited = await createUser('invited');
		const token = `invite-${randomUUID()}`;
		await db.insert(workspaceInvitation).values({
			workspaceId: fixture.context.workspaceId,
			email: invited.email,
			role: 'viewer',
			tokenHash: sha256(token),
			invitedByUserId: fixture.context.userId,
			expiresAt: new Date(Date.now() + 60_000)
		});

		await expect(acceptInvitation(token, invited.id, 'other@example.com')).rejects.toMatchObject({
			status: 403
		});
	});

	it('renews an existing pending invitation instead of creating duplicates', async () => {
		const previousDeliveryMode = process.env.EMAIL_DELIVERY;
		process.env.EMAIL_DELIVERY = 'log';
		const emailLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		const fixture = await createWorkspaceFixture();
		const email = `invite-${randomUUID()}@example.com`;

		try {
			const first = await inviteMember(fixture.context, { email, role: 'viewer' });
			const second = await inviteMember(fixture.context, { email, role: 'member' });

			expect(second.invitationId).toBe(first.invitationId);
			expect(second.url).not.toBe(first.url);

			const invitations = await db
				.select({
					id: workspaceInvitation.id,
					role: workspaceInvitation.role,
					status: workspaceInvitation.status
				})
				.from(workspaceInvitation)
				.where(
					and(
						eq(workspaceInvitation.workspaceId, fixture.context.workspaceId),
						eq(workspaceInvitation.email, email),
						eq(workspaceInvitation.status, 'pending')
					)
				);

			expect(invitations).toEqual([
				{
					id: first.invitationId,
					role: 'member',
					status: 'pending'
				}
			]);
		} finally {
			if (previousDeliveryMode === undefined) {
				delete process.env.EMAIL_DELIVERY;
			} else {
				process.env.EMAIL_DELIVERY = previousDeliveryMode;
			}
			emailLog.mockRestore();
		}
	});

	it('summarizes filtered expenses without using the current cursor page only', async () => {
		const fixture = await createWorkspaceFixture();
		await db.insert(expense).values([
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Produto limpeza',
				amountCents: 3550,
				expenseDate: '2026-06-26'
			},
			{
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Produto limpeza extra',
				amountCents: 1500,
				expenseDate: '2026-06-27'
			}
		]);

		const summary = await getExpenseListSummary(fixture.context, {
			from: '2026-06-01',
			to: '2026-06-30',
			q: 'limpeza'
		});

		expect(summary).toEqual({ itemCount: 2, totalCents: 5050 });
	});

	it('streams attachments to storage and downloads them from active expenses', async () => {
		const fixture = await createWorkspaceFixture();
		const previousUploadDir = process.env.UPLOAD_DIR;
		const uploadDir = await mkdtemp(path.join(tmpdir(), 'expense-attachments-'));
		uploadDirs.push(uploadDir);
		process.env.UPLOAD_DIR = uploadDir;

		try {
			const [expenseRow] = await db
				.insert(expense)
				.values({
					workspaceId: fixture.context.workspaceId,
					categoryId: fixture.categoryId,
					createdByUserId: fixture.context.userId,
					description: 'Produto limpeza',
					amountCents: 3550,
					expenseDate: '2026-06-26'
				})
				.returning({ id: expense.id });
			const content = 'recibo teste';
			const file = new File([content], 'recibo teste.txt', { type: 'text/plain' });

			const created = await saveExpenseAttachment(fixture.context, expenseRow.id, file);

			expect(created?.id).toBeGreaterThan(0);
			const [stored] = await db
				.select({
					originalName: expenseAttachment.originalName,
					contentType: expenseAttachment.contentType,
					sizeBytes: expenseAttachment.sizeBytes,
					storageKey: expenseAttachment.storageKey
				})
				.from(expenseAttachment)
				.where(eq(expenseAttachment.id, created!.id));
			expect(stored).toMatchObject({
				originalName: 'recibo-teste.txt',
				contentType: 'text/plain',
				sizeBytes: new TextEncoder().encode(content).byteLength
			});
			const attachmentDirectoryEntries = await readdir(
				path.dirname(path.join(uploadDir, stored.storageKey))
			);
			expect(attachmentDirectoryEntries.some((entry) => entry.endsWith('.tmp'))).toBe(false);

			const download = await getAttachmentForDownload(fixture.context, created!.id);
			expect(download.contentLength).toBe(stored.sizeBytes);
			await expect(new Response(download.stream).text()).resolves.toBe(content);

			await db.update(expense).set({ deletedAt: new Date() }).where(eq(expense.id, expenseRow.id));

			await expect(getAttachmentForDownload(fixture.context, created!.id)).rejects.toMatchObject({
				status: 404
			});
		} finally {
			if (previousUploadDir === undefined) {
				delete process.env.UPLOAD_DIR;
			} else {
				process.env.UPLOAD_DIR = previousUploadDir;
			}
		}
	});

	it('rejects unsafe attachment inputs before writing files', async () => {
		const fixture = await createWorkspaceFixture();
		const previousUploadDir = process.env.UPLOAD_DIR;
		const uploadDir = await mkdtemp(path.join(tmpdir(), 'expense-attachments-'));
		uploadDirs.push(uploadDir);
		process.env.UPLOAD_DIR = uploadDir;

		try {
			const [expenseRow] = await db
				.insert(expense)
				.values({
					workspaceId: fixture.context.workspaceId,
					categoryId: fixture.categoryId,
					createdByUserId: fixture.context.userId,
					description: 'Produto limpeza',
					amountCents: 3550,
					expenseDate: '2026-06-26'
				})
				.returning({ id: expense.id });

			await expect(
				saveExpenseAttachment(
					fixture.context,
					expenseRow.id,
					new File(['conteudo'], 'malware.exe', { type: 'application/x-msdownload' })
				)
			).rejects.toMatchObject({ status: 400 });
			await expect(
				saveExpenseAttachment(
					fixture.context,
					expenseRow.id,
					new File([new Uint8Array(maxAttachmentBytes + 1)], 'grande.txt', {
						type: 'text/plain'
					})
				)
			).rejects.toMatchObject({ status: 400 });
			await expect(readdir(uploadDir)).resolves.toEqual([]);
		} finally {
			if (previousUploadDir === undefined) {
				delete process.env.UPLOAD_DIR;
			} else {
				process.env.UPLOAD_DIR = previousUploadDir;
			}
		}
	});
});

async function createWorkspaceFixture() {
	const owner = await createUser('owner');
	const [workspaceRow] = await db
		.insert(workspace)
		.values({
			name: `Workspace ${randomUUID()}`,
			createdByUserId: owner.id
		})
		.returning({ id: workspace.id, name: workspace.name, weekStartsOn: workspace.weekStartsOn });
	workspaceIds.push(workspaceRow.id);

	await db.insert(workspaceMember).values({
		workspaceId: workspaceRow.id,
		userId: owner.id,
		role: 'owner',
		status: 'active'
	});

	const [categoryRow] = await db
		.insert(category)
		.values({
			workspaceId: workspaceRow.id,
			name: 'Limpeza',
			color: '#0f766e',
			icon: '🧼'
		})
		.returning({ id: category.id });

	const context: WorkspaceContext = {
		userId: owner.id,
		workspaceId: workspaceRow.id,
		workspaceName: workspaceRow.name,
		timezone: 'America/Sao_Paulo',
		weekStartsOn: workspaceRow.weekStartsOn,
		role: 'owner'
	};

	return { context, categoryId: categoryRow.id };
}

async function createMemberContext(
	fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>,
	role: WorkspaceContext['role']
) {
	const member = await createUser(role);
	await db.insert(workspaceMember).values({
		workspaceId: fixture.context.workspaceId,
		userId: member.id,
		role,
		status: 'active'
	});

	return {
		...fixture.context,
		userId: member.id,
		role
	};
}

async function createExpenseCatalogs(
	context: WorkspaceContext,
	input: { paymentMethod?: string; vendor?: string; costCenter?: string }
) {
	const [paymentMethodItem, vendorItem, costCenterItem] = await Promise.all([
		input.paymentMethod
			? getOrCreateCatalogItem(db, context.workspaceId, 'paymentMethod', input.paymentMethod)
			: Promise.resolve(null),
		input.vendor
			? getOrCreateCatalogItem(db, context.workspaceId, 'vendor', input.vendor)
			: Promise.resolve(null),
		input.costCenter
			? getOrCreateCatalogItem(db, context.workspaceId, 'costCenter', input.costCenter)
			: Promise.resolve(null)
	]);

	return {
		paymentMethodId: paymentMethodItem?.id,
		vendorId: vendorItem?.id,
		costCenterId: costCenterItem?.id
	};
}

async function createUser(prefix: string) {
	const id = `${prefix}-${randomUUID()}`;
	const email = `${id}@example.com`;
	await db.insert(user).values({
		id,
		name: prefix,
		email,
		emailVerified: true
	});
	userIds.push(id);
	return { id, email };
}
