import { isHttpError } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { load } from './+page.server';

const mocks = vi.hoisted(() => ({
	requireWorkspaceContext: vi.fn(),
	listCategories: vi.fn(),
	listExpenseCatalogs: vi.fn(),
	listBudgetStatus: vi.fn(),
	getBudgetAlertPreference: vi.fn(),
	listBudgetAlertEligibleRecipients: vi.fn(),
	listBudgetAlertDeliveryHistory: vi.fn(),
	listRecurringExpenses: vi.fn(),
	listImportBatches: vi.fn(),
	listReconciliationQueue: vi.fn(),
	context: {
		workspaceId: 12,
		userId: 'user-1',
		role: 'owner',
		locale: 'en'
	}
}));

vi.mock('$lib/server/services/workspaces', () => ({
	requireWorkspaceContext: mocks.requireWorkspaceContext
}));

vi.mock('$lib/server/services/categories', () => ({
	listCategories: mocks.listCategories
}));

vi.mock('$lib/server/services/expense-catalogs', () => ({
	createExpenseCatalogItem: vi.fn(),
	listExpenseCatalogs: mocks.listExpenseCatalogs
}));

vi.mock('$lib/server/services/budgets', () => ({
	deleteBudget: vi.fn(),
	getBudgetAlertPreference: mocks.getBudgetAlertPreference,
	listBudgetAlertDeliveryHistory: mocks.listBudgetAlertDeliveryHistory,
	listBudgetAlertEligibleRecipients: mocks.listBudgetAlertEligibleRecipients,
	listBudgetStatus: mocks.listBudgetStatus,
	retryBudgetAlertDelivery: vi.fn(),
	sendBudgetAlerts: vi.fn(),
	setBudgetAlertPreference: vi.fn(),
	upsertBudget: vi.fn()
}));

vi.mock('$lib/server/services/recurring', () => ({
	createRecurringExpense: vi.fn(),
	listRecurringExpenses: mocks.listRecurringExpenses,
	materializeDueRecurringExpenses: vi.fn(),
	setRecurringExpenseStatus: vi.fn()
}));

vi.mock('$lib/server/services/imports', () => ({
	confirmImportPreview: vi.fn(),
	listImportBatches: mocks.listImportBatches,
	previewImportExpenses: vi.fn(),
	undoImportBatch: vi.fn()
}));

vi.mock('$lib/server/services/reconciliation', () => ({
	decideBankTransaction: vi.fn(),
	listReconciliationQueue: mocks.listReconciliationQueue,
	stageOfxTransactions: vi.fn()
}));

function event(path: string) {
	return {
		url: new URL(`http://localhost${path}`),
		locals: { locale: 'en' }
	} as Parameters<NonNullable<typeof load>>[0];
}

describe('planning page workflow loader', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireWorkspaceContext.mockResolvedValue(mocks.context);
		mocks.listCategories.mockResolvedValue([]);
		mocks.listExpenseCatalogs.mockResolvedValue({
			paymentMethods: [],
			vendors: [],
			costCenters: []
		});
		mocks.listBudgetStatus.mockResolvedValue([]);
		mocks.getBudgetAlertPreference.mockResolvedValue({
			isEnabled: false,
			recipientMode: 'all_managers',
			escalateOverBudget: false,
			recipientUserIds: [],
			locale: 'en'
		});
		mocks.listBudgetAlertEligibleRecipients.mockResolvedValue([]);
		mocks.listBudgetAlertDeliveryHistory.mockResolvedValue({ items: [], nextCursor: null });
		mocks.listRecurringExpenses.mockResolvedValue([]);
		mocks.listImportBatches.mockResolvedValue([]);
		mocks.listReconciliationQueue.mockResolvedValue([]);
	});

	it('loads only budget data for the default workflow', async () => {
		const result = await load(event('/app/planning?periodMonth=2026-06'));

		expect(result).toMatchObject({ section: 'budgets', periodMonth: '2026-06-01' });
		expect(mocks.listBudgetStatus).toHaveBeenCalledOnce();
		expect(mocks.getBudgetAlertPreference).toHaveBeenCalledOnce();
		expect(mocks.listRecurringExpenses).not.toHaveBeenCalled();
		expect(mocks.listImportBatches).not.toHaveBeenCalled();
		expect(mocks.listReconciliationQueue).not.toHaveBeenCalled();
	});

	it('loads only recurrence data for explicit and named-action URLs', async () => {
		for (const path of ['/app/planning?section=recurring', '/app/planning?/createRecurring']) {
			vi.clearAllMocks();
			mocks.requireWorkspaceContext.mockResolvedValue(mocks.context);
			mocks.listCategories.mockResolvedValue([]);
			mocks.listExpenseCatalogs.mockResolvedValue({
				paymentMethods: [],
				vendors: [],
				costCenters: []
			});
			mocks.listRecurringExpenses.mockResolvedValue([]);

			const result = await load(event(path));

			expect(result).toMatchObject({ section: 'recurring' });
			expect(mocks.listExpenseCatalogs).toHaveBeenCalledOnce();
			expect(mocks.listRecurringExpenses).toHaveBeenCalledOnce();
			expect(mocks.listBudgetStatus).not.toHaveBeenCalled();
			expect(mocks.listImportBatches).not.toHaveBeenCalled();
		}
	});

	it('loads only import and reconciliation data for the import workflow', async () => {
		const result = await load(event('/app/planning?section=imports'));

		expect(result).toMatchObject({ section: 'imports' });
		expect(mocks.listImportBatches).toHaveBeenCalledOnce();
		expect(mocks.listReconciliationQueue).toHaveBeenCalledOnce();
		expect(mocks.listBudgetStatus).not.toHaveBeenCalled();
		expect(mocks.listRecurringExpenses).not.toHaveBeenCalled();
	});

	it('rejects unknown workflow names', async () => {
		try {
			await load(event('/app/planning?section=unknown'));
			expect.fail('Expected the loader to reject an invalid section');
		} catch (loadError) {
			expect(isHttpError(loadError, 400)).toBe(true);
		}
	});
});
