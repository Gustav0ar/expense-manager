import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { emailVerificationThrottle, user } from '$lib/server/db/auth.schema';
import {
	auditEvent,
	budgetAlertDelivery,
	budgetAlertPreference,
	category,
	categoryBudget,
	categoryRule,
	emailDeliveryEvent,
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
import { client, db } from '$lib/server/db';
import { sendBudgetAlertEmail } from '$lib/server/email';
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
import { createCategory, listCategories, removeCategory, unarchiveCategory } from './categories';
import {
	deleteBudget,
	getBudgetAlertPreference,
	getBudgetSummary,
	listBudgetStatus,
	runAutomaticBudgetAlertScheduler,
	sendBudgetAlerts,
	setBudgetAlertPreference,
	upsertBudget
} from './budgets';
import { acceptInvitation, getPendingInvitation } from './invitations';
import {
	createExpense,
	bulkReviewExpenses,
	deleteExpense,
	getAnalyticalExpenseReport,
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
import {
	parseMailjetWebhookPayload,
	pruneEmailDeliveryEvents,
	recordMailjetDeliveryEvents
} from './email-delivery-events';
import {
	createRecurringExpense,
	materializeDueRecurringExpenses,
	runRecurringExpenseScheduler,
	setRecurringExpenseStatus
} from './recurring';
import {
	pruneExpiredUnverifiedRegistrations,
	requestVerificationEmail
} from './email-verification';
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

	it('throttles verification email resends for unverified accounts', async () => {
		const unverifiedUser = await createUser('verify-cooldown', { emailVerified: false });
		const send = vi.fn().mockResolvedValue(undefined);
		const now = new Date('2026-06-01T12:00:00.000Z');

		await expect(
			requestVerificationEmail({ email: unverifiedUser.email, send, now })
		).resolves.toMatchObject({ status: 'sent', sentCount: 1 });
		await expect(
			requestVerificationEmail({
				email: unverifiedUser.email,
				send,
				now: new Date(now.getTime() + 60_000)
			})
		).resolves.toMatchObject({
			status: 'cooldown',
			retryAt: new Date('2026-06-01T12:02:00.000Z')
		});
		expect(send).toHaveBeenCalledTimes(1);
	});

	it('caps verification emails at five attempts and expires stale unverified accounts', async () => {
		const unverifiedUser = await createUser('verify-limit', { emailVerified: false });
		const send = vi.fn().mockResolvedValue(undefined);
		const now = new Date('2026-06-01T12:00:00.000Z');

		for (let attempt = 0; attempt < 5; attempt += 1) {
			await expect(
				requestVerificationEmail({
					email: unverifiedUser.email,
					send,
					now: new Date(now.getTime() + attempt * 121_000)
				})
			).resolves.toMatchObject({ status: 'sent', sentCount: attempt + 1 });
		}

		const [throttle] = await db
			.select()
			.from(emailVerificationThrottle)
			.where(eq(emailVerificationThrottle.userId, unverifiedUser.id));
		expect(throttle).toMatchObject({
			sentCount: 5,
			limitReachedAt: new Date('2026-06-01T12:08:04.000Z'),
			deleteAfter: new Date('2026-06-01T13:08:04.000Z')
		});

		await expect(
			requestVerificationEmail({
				email: unverifiedUser.email,
				send,
				now: new Date('2026-06-01T12:11:00.000Z')
			})
		).resolves.toMatchObject({
			status: 'limit',
			deleteAfter: new Date('2026-06-01T13:08:04.000Z')
		});
		expect(send).toHaveBeenCalledTimes(5);

		await expect(
			pruneExpiredUnverifiedRegistrations(new Date('2026-06-01T13:08:05.000Z'))
		).resolves.toEqual({ deletedUsers: 1 });
		await expect(findUserById(unverifiedUser.id)).resolves.toBeNull();
	});

	it('removes workspaces owned by expired unverified users', async () => {
		const unverifiedUser = await createUser('verify-expired-workspace', { emailVerified: false });
		const [workspaceRow] = await db
			.insert(workspace)
			.values({
				name: `Expired ${randomUUID()}`,
				createdByUserId: unverifiedUser.id,
				currency: 'USD'
			})
			.returning({ id: workspace.id });
		workspaceIds.push(workspaceRow.id);
		await db.insert(emailVerificationThrottle).values({
			userId: unverifiedUser.id,
			email: unverifiedUser.email,
			sentCount: 5,
			lastSentAt: new Date('2026-06-01T12:00:00.000Z'),
			limitReachedAt: new Date('2026-06-01T12:00:00.000Z'),
			deleteAfter: new Date('2026-06-01T13:00:00.000Z')
		});

		await expect(
			pruneExpiredUnverifiedRegistrations(new Date('2026-06-01T13:00:01.000Z'))
		).resolves.toEqual({ deletedUsers: 1 });
		await expect(findWorkspaceById(workspaceRow.id)).resolves.toBeNull();
		await expect(findUserById(unverifiedUser.id)).resolves.toBeNull();
	});

	it('skips verification cleanup while another instance owns the advisory lock', async () => {
		const reserved = await client.reserve();
		try {
			await reserved`
				SELECT pg_advisory_lock(
					hashtextextended('expense-manager:email-verification-cleanup:v1', 0)
				)
			`;
			await expect(pruneExpiredUnverifiedRegistrations()).resolves.toEqual({
				deletedUsers: 0,
				skipped: true
			});
		} finally {
			await reserved`
				SELECT pg_advisory_unlock(
					hashtextextended('expense-manager:email-verification-cleanup:v1', 0)
				)
			`;
			reserved.release();
		}
	});

	it('persists failed-only imports with batch counters and failed row details', async () => {
		const fixture = await createWorkspaceFixture();
		const file = new File(['Data;Descrição;Valor\nbad;;abc\n'], 'falhas.csv', {
			type: 'text/csv'
		});

		const result = await importExpenses(fixture.context, { sourceType: 'csv', file });

		expect(result.importBatchId).toBeGreaterThan(0);
		expect(result).toMatchObject({ importedCount: 0, failedCount: 1 });
		expect(result.failedRows[0]?.message).toContain('date, description or amount');

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
			['Data;Descrição;Valor;Categoria\n26/06/2026;Compra;35,50;Inexistente\n'],
			'sem-categoria.csv',
			{
				type: 'text/csv'
			}
		);

		const result = await importExpenses(fixture.context, { sourceType: 'csv', file });

		expect(result).toMatchObject({ importedCount: 0, failedCount: 1 });
		expect(result.failedRows[0]).toMatchObject({
			rowNumber: 2,
			message: 'Category not found and no default category was selected.'
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
				file: new File(['Data;Descrição;Valor\n26/06/2026;Compra;35,50\n'], 'padrão.csv', {
					type: 'text/csv'
				})
			})
		).rejects.toMatchObject({ status: 400 });

		await expect(
			importExpenses(fixture.context, {
				sourceType: 'csv',
				defaultCategoryId: fixture.categoryId,
				file: new File([`Data;Descrição;Valor\n${rows}\n`], 'muitas.csv', { type: 'text/csv' })
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it('imports valid rows while preserving failed row accounting', async () => {
		const fixture = await createWorkspaceFixture();
		const file = new File(
			['Data;Descrição;Valor\n26/06/2026;Produto limpeza;35,50\nbad;;abc\n'],
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

	it('deduplicates rows against existing DB expenses but allows genuinely identical within-batch rows', async () => {
		const fixture = await createWorkspaceFixture();

		// Re-import a file: same row as an existing expense → duplicateCount 1
		const csvRow = 'Data;Descrição;Valor\n26/06/2026;Café;10,00\n';
		const firstImport = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File([csvRow], 'first.csv', { type: 'text/csv' })
		});
		expect(firstImport.importedCount).toBe(1);

		const reimport = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File([csvRow], 'reimport.csv', { type: 'text/csv' })
		});
		expect(reimport.importedCount).toBe(0);
		expect(reimport.duplicateCount).toBe(1);

		// Two identical rows in the same file: both should be imported (genuine duplicates)
		const twoRows =
			'Data;Descrição;Valor\n27/06/2026;Dois cafés;5,00\n27/06/2026;Dois cafés;5,00\n';
		const batchImport = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: new File([twoRows], 'dois.csv', { type: 'text/csv' })
		});
		expect(batchImport.importedCount).toBe(2);
		expect(batchImport.duplicateCount).toBe(0);
	});

	it('serializes concurrent imports in the same workspace', async () => {
		const fixture = await createWorkspaceFixture();
		const csv = 'Data;Descrição;Valor\n28/06/2026;Importação concorrente;12,50\n';

		const results = await Promise.all(
			['first.csv', 'second.csv'].map((name) =>
				importExpenses(fixture.context, {
					sourceType: 'csv',
					defaultCategoryId: fixture.categoryId,
					file: new File([csv], name, { type: 'text/csv' })
				})
			)
		);

		expect(results.reduce((total, result) => total + result.importedCount, 0)).toBe(1);
		expect(results.reduce((total, result) => total + result.duplicateCount, 0)).toBe(1);
	});

	it('does not import positive OFX credits as expenses', async () => {
		const fixture = await createWorkspaceFixture();
		const file = new File(
			[
				`<OFX><BANKTRANLIST>
					<STMTTRN><DTPOSTED>20260625120000[-3:BRT]<TRNAMT>42.35<NAME>Estorno</STMTTRN>
					<STMTTRN><DTPOSTED>20260626120000[-3:BRT]<TRNAMT>-21.10<NAME>Despesa OFX</STMTTRN>
				</BANKTRANLIST></OFX>`
			],
			'extrato.ofx',
			{ type: 'application/x-ofx' }
		);

		const result = await importExpenses(fixture.context, {
			sourceType: 'ofx',
			defaultCategoryId: fixture.categoryId,
			file
		});

		expect(result).toMatchObject({ importedCount: 1, failedCount: 1 });
		expect(result.failedRows[0]?.message).toContain('OFX transaction 1');
		const createdExpenses = await db
			.select({ description: expense.description, amountCents: expense.amountCents })
			.from(expense)
			.where(eq(expense.importBatchId, result.importBatchId));
		expect(createdExpenses).toEqual([{ description: 'Despesa OFX', amountCents: 2110 }]);
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
				name: 'Sem permissão',
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
				'Data;Descrição;Valor;Fornecedor;Centro de custo\n26/06/2026;Compra fiscal;35,50;ACME Ltda;Operação\n'
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
			costCenter: 'Operação',
			reviewStatus: 'approved'
		});

		const fallbackFile = new File(
			['Data;Descrição;Valor;Fornecedor\n27/06/2026;Compra com padrão;40,00;ACME Ltda\n'],
			'regras-com-padrao.csv',
			{ type: 'text/csv' }
		);
		const fallbackResult = await importExpenses(fixture.context, {
			sourceType: 'csv',
			defaultCategoryId: fixture.categoryId,
			file: fallbackFile
		});
		const [fallbackExpense] = await db
			.select({
				categoryId: expense.categoryId,
				description: expense.description
			})
			.from(expense)
			.where(eq(expense.importBatchId, fallbackResult.importBatchId));
		expect(fallbackExpense).toEqual({
			categoryId: supplyCategory.id,
			description: 'Compra com padrão'
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
			costCenter: 'Operação'
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
			costCenter: 'Operação',
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
		const pendingAnalytics = await getAnalyticalExpenseReport(
			fixture.context,
			{
				from: '2026-06-01',
				to: '2026-06-30',
				reviewStatus: 'pending',
				q: 'Diretoria'
			},
			{ limit: 10 }
		);
		expect(pendingAnalytics).toMatchObject({
			summary: {
				itemCount: 1,
				totalCents: 13_000,
				approvedCents: 0,
				pendingCents: 13_000,
				rejectedCents: 0,
				unpaidCents: 13_000
			},
			truncated: false
		});
		expect(pendingAnalytics.items[0]).toMatchObject({
			id: expenseId,
			expenseDate: '2026-06-26',
			competencyMonth: '2026-06-01',
			description: 'Compra revisada',
			categoryName: 'Limpeza',
			categoryIcon: '🧼',
			amountCents: 13_000,
			paymentMethod: 'Boleto',
			vendor: 'Fornecedor B',
			costCenter: 'Diretoria',
			reviewStatus: 'pending',
			paymentStatus: 'unpaid',
			notes: 'Atualizada',
			attachmentCount: 0
		});
		await expect(
			listExpenses(fixture.context, {
				vendorId: updatedCatalogs.vendorId,
				costCenterId: updatedCatalogs.costCenterId,
				competencyMonth: '2026-06-01'
			})
		).resolves.toMatchObject({
			items: [
				expect.objectContaining({
					id: expenseId,
					vendorId: updatedCatalogs.vendorId,
					costCenterId: updatedCatalogs.costCenterId,
					competencyMonth: '2026-06-01'
				})
			],
			nextCursor: null
		});
		await expect(
			getExpenseListSummary(fixture.context, {
				vendorId: updatedCatalogs.vendorId,
				costCenterId: updatedCatalogs.costCenterId,
				competencyMonth: '2026-06-01'
			})
		).resolves.toEqual({ itemCount: 1, totalCents: 13_000 });
		await expect(
			listExpenses(fixture.context, {
				vendorId: initialCatalogs.vendorId,
				competencyMonth: '2026-06-01'
			})
		).resolves.toMatchObject({ items: [] });
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

		await updateExpense(memberContext, expenseId, {
			categoryId: fixture.categoryId,
			description: 'Compra revisada',
			amount: '130,00',
			expenseDate: '2026-06-26',
			...updatedCatalogs,
			competencyMonth: '2026-06',
			notes: 'Reenviada'
		});
		let [workflowRow] = await db
			.select({
				reviewStatus: expense.reviewStatus,
				reviewedByUserId: expense.reviewedByUserId,
				reviewedAt: expense.reviewedAt,
				reviewRejectionReason: expense.reviewRejectionReason,
				paymentStatus: expense.paymentStatus,
				paidAt: expense.paidAt,
				reconciledByUserId: expense.reconciledByUserId
			})
			.from(expense)
			.where(eq(expense.id, expenseId));
		expect(workflowRow).toEqual({
			reviewStatus: 'pending',
			reviewedByUserId: null,
			reviewedAt: null,
			reviewRejectionReason: null,
			paymentStatus: 'unpaid',
			paidAt: null,
			reconciledByUserId: null
		});
		dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(0);

		await reviewExpense(fixture.context, expenseId, { reviewStatus: 'approved' });
		await expect(deleteExpense(memberContext, expenseId)).rejects.toMatchObject({ status: 403 });
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
		await expect(
			getReport(fixture.context, {
				from: '2026-06-01',
				to: '2026-06-30',
				groupBy: 'payment',
				vendorId: updatedCatalogs.vendorId,
				costCenterId: updatedCatalogs.costCenterId,
				competencyMonth: '2026-06-01'
			})
		).resolves.toEqual([
			{
				key: 'Boleto',
				label: 'Boleto',
				color: '#2563eb',
				totalCents: 13_000
			}
		]);
		await expect(
			getReport(fixture.context, {
				from: '2026-06-01',
				to: '2026-06-30',
				groupBy: 'payment',
				vendorId: initialCatalogs.vendorId,
				competencyMonth: '2026-06-01'
			})
		).resolves.toEqual([]);

		await updateExpensePaymentStatus(fixture.context, expenseId, {
			paymentStatus: 'reconciled',
			paidAt: '2026-06-27'
		});
		await expect(
			updateExpense(memberContext, expenseId, {
				categoryId: fixture.categoryId,
				description: 'Compra paga alterada',
				amount: '140,00',
				expenseDate: '2026-06-26',
				...updatedCatalogs,
				competencyMonth: '2026-06'
			})
		).rejects.toMatchObject({ status: 403 });
		[workflowRow] = await db
			.select({
				reviewStatus: expense.reviewStatus,
				reviewedByUserId: expense.reviewedByUserId,
				reviewedAt: expense.reviewedAt,
				reviewRejectionReason: expense.reviewRejectionReason,
				paymentStatus: expense.paymentStatus,
				paidAt: expense.paidAt,
				reconciledByUserId: expense.reconciledByUserId
			})
			.from(expense)
			.where(eq(expense.id, expenseId));
		expect(workflowRow).toEqual({
			reviewStatus: 'approved',
			reviewedByUserId: fixture.context.userId,
			reviewedAt: expect.any(Date),
			reviewRejectionReason: null,
			paymentStatus: 'reconciled',
			paidAt: '2026-06-27',
			reconciledByUserId: fixture.context.userId
		});
		await expect(
			reviewExpense(fixture.context, expenseId, {
				reviewStatus: 'rejected',
				reason: ''
			})
		).rejects.toMatchObject({ status: 400 });
		await expect(
			getAnalyticalExpenseReport(fixture.context, {
				from: '2026-06-01',
				to: '2026-06-30',
				paymentStatus: 'reconciled'
			})
		).resolves.toMatchObject({
			summary: {
				itemCount: 1,
				totalCents: 13_000,
				approvedCents: 13_000,
				reconciledCents: 13_000
			},
			items: [
				expect.objectContaining({
					id: expenseId,
					paidAt: '2026-06-27',
					paymentStatus: 'reconciled'
				})
			]
		});

		await reviewExpense(fixture.context, expenseId, {
			reviewStatus: 'rejected',
			reason: 'Duplicada'
		});
		[workflowRow] = await db
			.select({
				reviewStatus: expense.reviewStatus,
				reviewedByUserId: expense.reviewedByUserId,
				reviewedAt: expense.reviewedAt,
				reviewRejectionReason: expense.reviewRejectionReason,
				paymentStatus: expense.paymentStatus,
				paidAt: expense.paidAt,
				reconciledByUserId: expense.reconciledByUserId
			})
			.from(expense)
			.where(eq(expense.id, expenseId));
		expect(workflowRow).toEqual({
			reviewStatus: 'rejected',
			reviewedByUserId: fixture.context.userId,
			reviewedAt: expect.any(Date),
			reviewRejectionReason: 'Duplicada',
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

	it('guards payment state-machine transitions and preserves paidAt when reconciling', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');
		const viewerContext = await createMemberContext(fixture, 'viewer');

		// Create as a member so the expense starts in 'pending' review state
		const created = await createExpense(memberContext, {
			categoryId: fixture.categoryId,
			description: 'Despesa para transições',
			amount: '50,00',
			expenseDate: '2026-06-10'
		});
		const id = created.id;

		// Cannot pay/reconcile before approval (WHERE reviewStatus='approved' fails)
		await expect(
			updateExpensePaymentStatus(fixture.context, id, { paymentStatus: 'paid' })
		).rejects.toMatchObject({ status: 404 });

		// Member lacks reconcile rights — 403 on any payment status change
		await expect(
			updateExpensePaymentStatus(memberContext, id, { paymentStatus: 'paid' })
		).rejects.toMatchObject({ status: 403 });

		// Viewer cannot delete an expense
		await expect(deleteExpense(viewerContext, id)).rejects.toMatchObject({ status: 403 });

		// Cannot reject a reconciled expense without reconcile rights (member role)
		await reviewExpense(fixture.context, id, { reviewStatus: 'approved' });
		await updateExpensePaymentStatus(fixture.context, id, {
			paymentStatus: 'reconciled',
			paidAt: '2026-06-10'
		});
		await expect(
			reviewExpense(memberContext, id, { reviewStatus: 'rejected', reason: 'Teste' })
		).rejects.toMatchObject({ status: 403 });

		// Member cannot delete an approved+paid expense (paymentStatus !== 'unpaid' guard)
		await expect(deleteExpense(memberContext, id)).rejects.toMatchObject({ status: 403 });

		// Cannot downgrade reconciled → paid
		await expect(
			updateExpensePaymentStatus(fixture.context, id, { paymentStatus: 'paid' })
		).rejects.toMatchObject({ status: 400 });

		// Can reset to unpaid (reconcilers may undo reconciliation)
		await updateExpensePaymentStatus(fixture.context, id, { paymentStatus: 'unpaid' });

		// Re-approve and mark paid with a specific date; then reconcile without supplying
		// paidAt — the service should preserve the original payment date.
		await reviewExpense(fixture.context, id, { reviewStatus: 'approved' });
		await updateExpensePaymentStatus(fixture.context, id, {
			paymentStatus: 'paid',
			paidAt: '2026-06-12'
		});
		await updateExpensePaymentStatus(fixture.context, id, { paymentStatus: 'reconciled' });
		const [row] = await db
			.select({ paidAt: expense.paidAt, paymentStatus: expense.paymentStatus })
			.from(expense)
			.where(eq(expense.id, id));
		expect(row).toEqual({ paidAt: '2026-06-12', paymentStatus: 'reconciled' });

		// Owner (with reconcile rights) can reject a reconciled expense; payment fields are cleared
		await reviewExpense(fixture.context, id, { reviewStatus: 'rejected', reason: 'Erro' });
		const [afterReject] = await db
			.select({
				reviewStatus: expense.reviewStatus,
				paymentStatus: expense.paymentStatus,
				paidAt: expense.paidAt
			})
			.from(expense)
			.where(eq(expense.id, id));
		expect(afterReject).toEqual({
			reviewStatus: 'rejected',
			paymentStatus: 'unpaid',
			paidAt: null
		});
	});

	it('keeps recurring expenses generated by members pending until approval', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');

		const schedule = await createRecurringExpense(memberContext, {
			categoryId: fixture.categoryId,
			description: 'Recorrência do membro',
			amount: '60,00',
			frequency: 'monthly',
			intervalCount: 1,
			startDate: '2026-06-01'
		});
		await expect(materializeDueRecurringExpenses(memberContext, '2026-06-30')).resolves.toEqual({
			createdCount: 1
		});

		const [generated] = await db
			.select({
				id: expense.id,
				reviewStatus: expense.reviewStatus,
				reviewedByUserId: expense.reviewedByUserId,
				reviewedAt: expense.reviewedAt,
				sourceRecurringExpenseId: expense.sourceRecurringExpenseId
			})
			.from(expense)
			.where(eq(expense.sourceRecurringExpenseId, schedule.id));
		expect(generated).toEqual({
			id: expect.any(Number),
			reviewStatus: 'pending',
			reviewedByUserId: null,
			reviewedAt: null,
			sourceRecurringExpenseId: schedule.id
		});

		let dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(0);
		await reviewExpense(fixture.context, generated.id, { reviewStatus: 'approved' });
		dashboard = await getDashboard(fixture.context, '2026-06-01', '2026-06-30');
		expect(dashboard.totalCents).toBe(6_000);
	});

	it('skips the recurring scheduler when another instance owns its lock', async () => {
		const reserved = await client.reserve();
		try {
			await reserved`SELECT pg_advisory_lock(${7_273_299_171})`;
			await expect(runRecurringExpenseScheduler()).resolves.toEqual({
				processed: 0,
				created: 0,
				errors: 0,
				skipped: true
			});
		} finally {
			await reserved`SELECT pg_advisory_unlock(${7_273_299_171})`;
			reserved.release();
		}
	});

	it('does not reactivate a recurrence paused during materialization', async () => {
		const fixture = await createWorkspaceFixture();
		const schedule = await createRecurringExpense(fixture.context, {
			categoryId: fixture.categoryId,
			description: 'Pause race',
			amount: '25.00',
			frequency: 'monthly',
			intervalCount: 1,
			startDate: '2026-06-01'
		});
		let releaseMaterialization!: () => void;
		let markSchedulesLocked!: () => void;
		const schedulesLocked = new Promise<void>((resolve) => (markSchedulesLocked = resolve));
		const materializationGate = new Promise<void>((resolve) => (releaseMaterialization = resolve));

		const materialization = materializeDueRecurringExpenses(fixture.context, '2026-06-30', {
			afterSchedulesLocked: async () => {
				markSchedulesLocked();
				await materializationGate;
			}
		});
		await schedulesLocked;

		let pauseResolved = false;
		const pause = setRecurringExpenseStatus(fixture.context, schedule.id, 'paused').then(() => {
			pauseResolved = true;
		});
		try {
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(pauseResolved).toBe(false);
		} finally {
			releaseMaterialization();
		}
		await expect(materialization).resolves.toEqual({ createdCount: 1 });
		await pause;

		const [storedSchedule] = await db
			.select({ status: recurringExpense.status, nextRunDate: recurringExpense.nextRunDate })
			.from(recurringExpense)
			.where(eq(recurringExpense.id, schedule.id));
		expect(storedSchedule).toEqual({ status: 'paused', nextRunDate: '2026-07-01' });
	});

	it('paginates installments and covers expense validation branches', async () => {
		const fixture = await createWorkspaceFixture();
		const viewerContext = await createMemberContext(fixture, 'viewer');
		await expect(
			createExpense(viewerContext, {
				categoryId: fixture.categoryId,
				description: 'Sem permissão',
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

		const limitedAnalytics = await getAnalyticalExpenseReport(
			fixture.context,
			{
				from: '2026-06-01',
				to: '2026-07-31'
			},
			{ limit: 1 }
		);
		expect(limitedAnalytics).toMatchObject({
			summary: {
				itemCount: 2,
				totalCents: 10_000
			},
			limit: 1,
			truncated: true
		});
		expect(limitedAnalytics.items).toHaveLength(1);

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
				description: 'Categoria inválida',
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

	it('groups report by vendor and cost center', async () => {
		const fixture = await createWorkspaceFixture();
		await createExpense(fixture.context, {
			description: 'Vendor test',
			amount: '50,00',
			expenseDate: '2026-06-15',
			categoryId: fixture.categoryId
		});

		const byVendor = await getReport(fixture.context, {
			from: '2026-01-01',
			to: '2026-12-31',
			groupBy: 'vendor'
		});
		expect(byVendor).toEqual([expect.objectContaining({ totalCents: 5_000 })]);

		const byCostCenter = await getReport(fixture.context, {
			from: '2026-01-01',
			to: '2026-12-31',
			groupBy: 'costCenter'
		});
		expect(byCostCenter).toEqual([expect.objectContaining({ totalCents: 5_000 })]);
	});

	it('bulk-reviews pending expenses and scopes by workspace', async () => {
		const fixture = await createWorkspaceFixture();
		// Create expenses as a member so reviewStatus is 'pending'
		const memberContext = await createMemberContext(fixture, 'member');
		const e1 = await createExpense(memberContext, {
			description: 'Bulk one',
			amount: '10,00',
			expenseDate: '2026-06-01',
			categoryId: fixture.categoryId
		});
		const e2 = await createExpense(memberContext, {
			description: 'Bulk two',
			amount: '20,00',
			expenseDate: '2026-06-02',
			categoryId: fixture.categoryId
		});

		const result = await bulkReviewExpenses(fixture.context, [e1.ids[0], e2.ids[0]], 'approved');
		expect(result.count).toBe(2);

		const listed = await listExpenses(fixture.context, {});
		for (const exp of listed.items) {
			expect(exp.reviewStatus).toBe('approved');
		}

		// IDs from another workspace must not be touched
		const other = await createWorkspaceFixture();
		const otherMember = await createMemberContext(other, 'member');
		const e3 = await createExpense(otherMember, {
			description: 'Other ws',
			amount: '5,00',
			expenseDate: '2026-06-03',
			categoryId: other.categoryId
		});
		const crossResult = await bulkReviewExpenses(fixture.context, [e3.ids[0]], 'rejected');
		expect(crossResult.count).toBe(0);
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
			'ACME  Serviços'
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
				expect.objectContaining({ id: supplier.id, name: 'ACME Serviços', expenseCount: 0 }),
				expect.objectContaining({ id: duplicateSupplier.id, name: 'Fornecedor B' })
			],
			costCenters: [expect.objectContaining({ id: department.id, name: 'Administrativo' })]
		});
		await expect(
			updateExpenseCatalogItem(fixture.context, {
				kind: 'vendor',
				id: duplicateSupplier.id,
				name: 'acme serviços'
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
			'Cartão recorrente'
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
			mode: 'archived',
			item: expect.objectContaining({ expenseCount: 0, recurringCount: 1 })
		});
		await expect(
			db
				.select({ id: paymentMethod.id, isArchived: paymentMethod.isArchived })
				.from(paymentMethod)
				.where(eq(paymentMethod.id, recurringOnlyPayment.id))
		).resolves.toEqual([{ id: recurringOnlyPayment.id, isArchived: true }]);
		const [recurringAfterCatalogDelete] = await db
			.select({
				paymentMethodId: recurringExpense.paymentMethodId,
				paymentMethod: recurringExpense.paymentMethod
			})
			.from(recurringExpense)
			.where(eq(recurringExpense.id, recurringOnlySchedule.id));
		expect(recurringAfterCatalogDelete).toEqual({
			paymentMethodId: recurringOnlyPayment.id,
			paymentMethod: 'Cartão recorrente'
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

	it('deletes unused categories, archives used categories and restores archived categories', async () => {
		const fixture = await createWorkspaceFixture();
		const unused = await createCategory(fixture.context, {
			name: 'Sem uso',
			color: '#2563eb',
			icon: '💼'
		});
		const used = await createCategory(fixture.context, {
			name: 'Com despesas',
			color: '#dc2626',
			icon: '🧮'
		});

		await expect(removeCategory(fixture.context, unused.id)).resolves.toMatchObject({
			mode: 'deleted',
			item: expect.objectContaining({ id: unused.id, associationCount: 0 })
		});
		await expect(
			db.select({ id: category.id }).from(category).where(eq(category.id, unused.id))
		).resolves.toEqual([]);

		await createExpense(fixture.context, {
			categoryId: used.id,
			description: 'Imposto vinculado',
			amount: '10,00',
			expenseDate: '2026-06-10'
		});

		await expect(removeCategory(fixture.context, used.id)).resolves.toMatchObject({
			mode: 'archived',
			item: expect.objectContaining({ id: used.id, associationCount: 1, expenseCount: 1 })
		});
		await expect(listCategories(fixture.context)).resolves.not.toEqual(
			expect.arrayContaining([expect.objectContaining({ id: used.id })])
		);
		await expect(listCategories(fixture.context, true)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: used.id, isArchived: true, associationCount: 1 })
			])
		);

		await unarchiveCategory(fixture.context, used.id);
		await expect(listCategories(fixture.context)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: used.id, isArchived: false, associationCount: 1 })
			])
		);
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
				upsertBudget(
					{ ...fixture.context, locale: 'pt-BR' },
					{
						categoryId: fixture.categoryId + 999_999,
						periodMonth: '2026-06',
						amount: '100,00',
						warningThresholdPct: 80
					}
				)
			).rejects.toMatchObject({
				status: 400,
				body: { message: 'Categoria inválida.' }
			});

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
			await expect(sendBudgetAlerts(fixture.context, '2026-06')).resolves.toEqual(
				expect.objectContaining({ sentCount: 0, alertCount: 0 })
			);
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

			expect(result).toEqual(expect.objectContaining({ sentCount: 1, alertCount: 1 }));
			expect(emailLog).toHaveBeenCalledWith(
				'[email:dev]',
				expect.objectContaining({
					to: expect.stringContaining('@example.com'),
					text: expect.stringContaining(`${formatCents(9000)} of ${formatCents(10000)}`)
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

	it('retries only failed budget-alert recipients after partial provider failure', async () => {
		const fixture = await createWorkspaceFixture();
		const adminContext = await createMemberContext(fixture, 'admin');
		await seedWarningBudget(fixture);
		const [owner, admin] = await Promise.all([
			db.select({ email: user.email }).from(user).where(eq(user.id, fixture.context.userId)),
			db.select({ email: user.email }).from(user).where(eq(user.id, adminContext.userId))
		]);
		const ownerEmail = owner[0].email;
		const adminEmail = admin[0].email;
		const providerError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const firstSend = vi.fn(async (to: string) => {
			if (to === adminEmail) throw new Error('temporary provider failure');
		});

		try {
			await expect(
				sendBudgetAlerts(fixture.context, '2026-06', { send: firstSend })
			).resolves.toMatchObject({ sentCount: 1, failedCount: 1, alreadySent: false });
			expect(firstSend).toHaveBeenCalledTimes(2);

			const retrySend = vi.fn(async () => {});
			await expect(
				sendBudgetAlerts(fixture.context, '2026-06', { send: retrySend })
			).resolves.toMatchObject({ sentCount: 1, failedCount: 0, alreadySent: false });
			expect(retrySend).toHaveBeenCalledTimes(1);
			expect(retrySend).toHaveBeenCalledWith(
				adminEmail,
				expect.any(String),
				'2026-06-01',
				expect.any(Array),
				'en',
				expect.stringMatching(
					/^budget-alert:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
				)
			);
			expect(retrySend).not.toHaveBeenCalledWith(
				ownerEmail,
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything()
			);

			const deliveries = await db
				.select({
					recipientEmail: budgetAlertDelivery.recipientEmail,
					status: budgetAlertDelivery.status,
					attemptCount: budgetAlertDelivery.attemptCount
				})
				.from(budgetAlertDelivery)
				.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));
			expect(deliveries).toEqual(
				expect.arrayContaining([
					{ recipientEmail: ownerEmail, status: 'sent', attemptCount: 1 },
					{ recipientEmail: adminEmail, status: 'sent', attemptCount: 2 }
				])
			);

			const completionEvents = await db
				.select({ id: auditEvent.id })
				.from(auditEvent)
				.where(
					and(
						eq(auditEvent.workspaceId, fixture.context.workspaceId),
						eq(auditEvent.action, 'budget.alerts_sent')
					)
				);
			expect(completionEvents).toHaveLength(1);
		} finally {
			providerError.mockRestore();
		}
	});

	it('reconciles replay-safe Mailjet feedback to the exact budget-alert delivery', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		const [owner] = await db
			.select({ email: user.email })
			.from(user)
			.where(eq(user.id, fixture.context.userId));
		let customId = '';
		const send = vi.fn(async (...args: Parameters<typeof sendBudgetAlertEmail>) => {
			customId = String(args[5]);
			return {
				provider: 'mailjet' as const,
				messageId: '19421777835146490',
				messageUuid: '1ab23cd4-e567-8901-2345-6789f0gh1i2j'
			};
		});

		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 1,
			failedCount: 0
		});
		expect(customId).toMatch(/^budget-alert:[0-9a-f-]{36}$/);
		await db
			.update(budgetAlertDelivery)
			.set({ status: 'failed', sentAt: null })
			.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));

		const eventPayload = {
			event: 'sent',
			time: 1_771_588_800,
			email: owner.email,
			CustomID: customId,
			mj_message_id: '19421777835146490',
			Message_GUID: '1ab23cd4-e567-8901-2345-6789f0gh1i2j'
		};
		const parsed = parseMailjetWebhookPayload(eventPayload, new Date('2026-02-20T12:05:00.000Z'));
		await expect(recordMailjetDeliveryEvents(parsed)).resolves.toEqual({
			accepted: 1,
			duplicates: 0,
			matched: 1
		});
		await expect(recordMailjetDeliveryEvents(parsed)).resolves.toEqual({
			accepted: 0,
			duplicates: 1,
			matched: 0
		});

		const [delivery] = await db
			.select({
				id: budgetAlertDelivery.id,
				status: budgetAlertDelivery.status,
				sentAt: budgetAlertDelivery.sentAt,
				provider: budgetAlertDelivery.provider,
				providerMessageId: budgetAlertDelivery.providerMessageId,
				providerMessageUuid: budgetAlertDelivery.providerMessageUuid,
				lastProviderEvent: budgetAlertDelivery.lastProviderEvent,
				lastProviderEventAt: budgetAlertDelivery.lastProviderEventAt
			})
			.from(budgetAlertDelivery)
			.where(eq(budgetAlertDelivery.workspaceId, fixture.context.workspaceId));
		expect(delivery).toEqual({
			id: expect.any(Number),
			status: 'sent',
			sentAt: new Date('2026-02-20T12:00:00.000Z'),
			provider: 'mailjet',
			providerMessageId: '19421777835146490',
			providerMessageUuid: '1ab23cd4-e567-8901-2345-6789f0gh1i2j',
			lastProviderEvent: 'sent',
			lastProviderEventAt: new Date('2026-02-20T12:00:00.000Z')
		});
		await expect(
			db
				.select({ eventType: emailDeliveryEvent.eventType })
				.from(emailDeliveryEvent)
				.where(eq(emailDeliveryEvent.budgetAlertDeliveryId, delivery.id))
		).resolves.toHaveLength(1);
		await db
			.update(emailDeliveryEvent)
			.set({ receivedAt: new Date('2026-01-01T00:00:00.000Z') })
			.where(eq(emailDeliveryEvent.budgetAlertDeliveryId, delivery.id));
		await expect(pruneEmailDeliveryEvents(new Date('2026-04-02T00:00:00.000Z'))).resolves.toEqual({
			deletedEvents: 1
		});
	});

	it('runs automatic budget alerts only for opted-in workspaces', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');
		await seedWarningBudget(fixture);
		await expect(getBudgetAlertPreference(fixture.context)).resolves.toEqual({
			isEnabled: false,
			locale: 'en'
		});
		await expect(setBudgetAlertPreference(memberContext, true)).rejects.toMatchObject({
			status: 403
		});

		await setBudgetAlertPreference({ ...fixture.context, locale: 'pt-BR' }, true);
		await expect(getBudgetAlertPreference(fixture.context)).resolves.toEqual({
			isEnabled: true,
			locale: 'pt-BR'
		});
		const [storedPreference] = await db
			.select({
				isEnabled: budgetAlertPreference.isEnabled,
				locale: budgetAlertPreference.locale,
				updatedByUserId: budgetAlertPreference.updatedByUserId
			})
			.from(budgetAlertPreference)
			.where(eq(budgetAlertPreference.workspaceId, fixture.context.workspaceId));
		expect(storedPreference).toEqual({
			isEnabled: true,
			locale: 'pt-BR',
			updatedByUserId: fixture.context.userId
		});

		const send = vi.fn(async () => {});
		const schedulerLog = vi.spyOn(console, 'info').mockImplementation(() => {});
		try {
			const firstCycle = await runAutomaticBudgetAlertScheduler({
				now: new Date('2026-06-20T12:00:00.000Z'),
				send
			});
			expect(firstCycle).toMatchObject({ sent: 1, failed: 0, errors: 0 });
			expect(firstCycle.processed).toBeGreaterThanOrEqual(1);
			expect(send).toHaveBeenCalledWith(
				expect.stringContaining('@example.com'),
				fixture.context.workspaceName,
				'2026-06-01',
				expect.any(Array),
				'pt-BR',
				expect.stringMatching(/^budget-alert:[0-9a-f-]{36}$/)
			);

			const secondCycle = await runAutomaticBudgetAlertScheduler({
				now: new Date('2026-06-20T13:00:00.000Z'),
				send
			});
			expect(secondCycle).toMatchObject({ sent: 0, failed: 0, errors: 0 });
			expect(secondCycle.processed).toBeGreaterThanOrEqual(1);
			expect(send).toHaveBeenCalledTimes(1);

			await setBudgetAlertPreference(fixture.context, false);
			await expect(
				runAutomaticBudgetAlertScheduler({
					now: new Date('2026-07-20T12:00:00.000Z'),
					send
				})
			).resolves.toMatchObject({ sent: 0, failed: 0, errors: 0 });
		} finally {
			schedulerLog.mockRestore();
		}
	});

	it('skips automatic budget alerts when another instance owns the scheduler lock', async () => {
		const reserved = await client.reserve();
		try {
			await reserved`SELECT pg_advisory_lock(${7_273_299_172})`;
			await expect(runAutomaticBudgetAlertScheduler()).resolves.toEqual({
				processed: 0,
				sent: 0,
				failed: 0,
				errors: 0,
				skipped: true
			});
		} finally {
			await reserved`SELECT pg_advisory_unlock(${7_273_299_172})`;
			reserved.release();
		}
	});

	it('atomically claims budget-alert recipients across concurrent requests', async () => {
		const fixture = await createWorkspaceFixture();
		await seedWarningBudget(fixture);
		let releaseSend!: () => void;
		let markSendStarted!: () => void;
		const sendStarted = new Promise<void>((resolve) => (markSendStarted = resolve));
		const sendGate = new Promise<void>((resolve) => (releaseSend = resolve));
		const send = vi.fn(async () => {
			markSendStarted();
			await sendGate;
		});

		const first = sendBudgetAlerts(fixture.context, '2026-06', { send });
		await sendStarted;
		await expect(sendBudgetAlerts(fixture.context, '2026-06', { send })).resolves.toMatchObject({
			sentCount: 0,
			failedCount: 0,
			inProgress: true
		});
		expect(send).toHaveBeenCalledTimes(1);
		releaseSend();
		await expect(first).resolves.toMatchObject({ sentCount: 1, failedCount: 0 });
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
			await expect(listExpenses(fixture.context, { q: 'Produto limpeza' })).resolves.toMatchObject({
				items: [
					expect.objectContaining({
						id: expenseRow.id,
						attachments: [
							expect.objectContaining({
								id: created!.id,
								originalName: 'recibo-teste.txt',
								contentType: 'text/plain',
								sizeBytes: stored.sizeBytes
							})
						]
					})
				]
			});

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

	it('limits expense attachments to 2 MiB', () => {
		expect(maxAttachmentBytes).toBe(2 * 1024 * 1024);
	});

	it('deletes attachments from DB and disk when expense is deleted', async () => {
		const fixture = await createWorkspaceFixture();
		const previousUploadDir = process.env.UPLOAD_DIR;
		const uploadDir = await mkdtemp(path.join(tmpdir(), 'attach-delete-'));
		process.env.UPLOAD_DIR = uploadDir;
		try {
			const [expenseRow] = await db
				.insert(expense)
				.values({
					workspaceId: fixture.context.workspaceId,
					categoryId: fixture.categoryId,
					createdByUserId: fixture.context.userId,
					description: 'To delete',
					amountCents: 1_000,
					expenseDate: '2026-06-26'
				})
				.returning({ id: expense.id });

			const file = new File(['receipt'], 'receipt.txt', { type: 'text/plain' });
			const att = await saveExpenseAttachment(fixture.context, expenseRow.id, file);
			expect(att?.id).toBeGreaterThan(0);

			// deleteExpense should clean up the attachment from DB and disk
			await deleteExpense(fixture.context, expenseRow.id);

			const remaining = await db
				.select()
				.from(expenseAttachment)
				.where(eq(expenseAttachment.id, att!.id));
			expect(remaining).toHaveLength(0);
		} finally {
			if (previousUploadDir === undefined) {
				delete process.env.UPLOAD_DIR;
			} else {
				process.env.UPLOAD_DIR = previousUploadDir;
			}
			await rm(uploadDir, { recursive: true, force: true });
		}
	});

	it('bulk-rejects expenses and resets payment status', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');
		const e1 = await createExpense(memberContext, {
			description: 'To reject',
			amount: '30,00',
			expenseDate: '2026-06-10',
			categoryId: fixture.categoryId
		});

		const result = await bulkReviewExpenses(fixture.context, [e1.ids[0]], 'rejected');
		expect(result.count).toBe(1);

		const listed = await listExpenses(fixture.context, {});
		const rejected = listed.items.find((e) => e.id === e1.ids[0]);
		expect(rejected?.reviewStatus).toBe('rejected');
		expect(rejected?.paymentStatus).toBe('unpaid');

		// Member role cannot bulk review
		await expect(bulkReviewExpenses(memberContext, [e1.ids[0]], 'approved')).rejects.toMatchObject({
			status: 403
		});

		// Empty ids list is rejected
		await expect(bulkReviewExpenses(fixture.context, [], 'approved')).rejects.toMatchObject({
			status: 400
		});
	});

	it('bulk-reject only affects pending, unpaid expenses', async () => {
		const fixture = await createWorkspaceFixture();
		const memberContext = await createMemberContext(fixture, 'member');

		// Pending + unpaid — the only state bulk review can act on.
		const ePending = await createExpense(memberContext, {
			description: 'Pending unpaid',
			amount: '20,00',
			expenseDate: '2026-06-10',
			categoryId: fixture.categoryId
		});

		// Approved + paid — outside bulk review's reviewStatus='pending' filter.
		const eApprovedPaid = await createExpense(memberContext, {
			description: 'Approved and paid',
			amount: '50,00',
			expenseDate: '2026-06-10',
			categoryId: fixture.categoryId
		});
		await reviewExpense(fixture.context, eApprovedPaid.ids[0], { reviewStatus: 'approved' });
		await updateExpensePaymentStatus(fixture.context, eApprovedPaid.ids[0], {
			paymentStatus: 'paid'
		});

		// Defensive legacy state: the service layer does not create pending+paid
		// rows, but the schema permits one and bulk review must not erase its payment.
		const [ePendingPaid] = await db
			.insert(expense)
			.values({
				workspaceId: fixture.context.workspaceId,
				categoryId: fixture.categoryId,
				createdByUserId: fixture.context.userId,
				description: 'Pending but paid',
				amountCents: 7500,
				expenseDate: '2026-06-10',
				reviewStatus: 'pending',
				paymentStatus: 'paid',
				paidAt: '2026-06-10'
			})
			.returning({ id: expense.id });

		// Only the pending+unpaid expense is eligible.
		const result = await bulkReviewExpenses(
			fixture.context,
			[ePending.ids[0], eApprovedPaid.ids[0], ePendingPaid.id],
			'rejected'
		);
		expect(result.count).toBe(1);

		const listed = await listExpenses(fixture.context, {});
		const rejected = listed.items.find((e) => e.id === ePending.ids[0]);
		expect(rejected?.reviewStatus).toBe('rejected');
		expect(rejected?.paymentStatus).toBe('unpaid');

		// The approved+paid expense is untouched: still approved, still paid.
		const untouched = listed.items.find((e) => e.id === eApprovedPaid.ids[0]);
		expect(untouched?.reviewStatus).toBe('approved');
		expect(untouched?.paymentStatus).toBe('paid');

		const protectedPayment = listed.items.find((e) => e.id === ePendingPaid.id);
		expect(protectedPayment?.reviewStatus).toBe('pending');
		expect(protectedPayment?.paymentStatus).toBe('paid');
	});

	it('rejects unsafe attachment inputs before writing files', async () => {
		const fixture = await createWorkspaceFixture();
		const uploadDirs: string[] = [];
		afterEach(async () => {
			for (const d of uploadDirs) await rm(d, { recursive: true, force: true });
		});
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
					new File(['conteúdo'], 'malware.exe', { type: 'application/x-msdownload' })
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
			createdByUserId: owner.id,
			currency: 'USD'
		})
		.returning({
			id: workspace.id,
			name: workspace.name,
			weekStartsOn: workspace.weekStartsOn,
			currency: workspace.currency
		});
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
		weekStartsOn: workspaceRow.weekStartsOn,
		currency: workspaceRow.currency,
		locale: 'en',
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

async function seedWarningBudget(fixture: Awaited<ReturnType<typeof createWorkspaceFixture>>) {
	await upsertBudget(fixture.context, {
		categoryId: fixture.categoryId,
		periodMonth: '2026-06',
		amount: '100.00',
		warningThresholdPct: 80
	});
	await createExpense(fixture.context, {
		categoryId: fixture.categoryId,
		description: `Budget alert ${randomUUID()}`,
		amount: '90.00',
		expenseDate: '2026-06-15'
	});
}

async function createUser(prefix: string, options: { emailVerified?: boolean } = {}) {
	const id = `${prefix}-${randomUUID()}`;
	const email = `${id}@example.com`;
	await db.insert(user).values({
		id,
		name: prefix,
		email,
		emailVerified: options.emailVerified ?? true
	});
	userIds.push(id);
	return { id, email };
}

async function findUserById(userId: string) {
	const [row] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
	return row ?? null;
}

async function findWorkspaceById(workspaceId: number) {
	const [row] = await db
		.select({ id: workspace.id })
		.from(workspace)
		.where(eq(workspace.id, workspaceId))
		.limit(1);
	return row ?? null;
}
