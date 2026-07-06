import { error, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from './+page.server';

const mocks = vi.hoisted(() => ({
	createExpenseCatalogItem: vi.fn(),
	requireWorkspaceContext: vi.fn(),
	context: {
		workspaceId: 12,
		userId: 'user-1',
		role: 'owner',
		locale: 'pt-BR'
	}
}));

vi.mock('$lib/server/services/categories', () => ({
	listCategories: vi.fn()
}));

vi.mock('$lib/server/services/expense-catalogs', () => ({
	createExpenseCatalogItem: mocks.createExpenseCatalogItem,
	listExpenseCatalogs: vi.fn(),
	removeExpenseCatalogItem: vi.fn(),
	updateExpenseCatalogItem: vi.fn()
}));

vi.mock('$lib/server/services/expenses', () => ({
	bulkReviewExpenses: vi.fn(),
	createExpense: vi.fn(),
	deleteExpense: vi.fn(),
	getExpenseListSummary: vi.fn(),
	listExpenses: vi.fn(),
	reviewExpense: vi.fn(),
	updateExpense: vi.fn(),
	updateExpensePaymentStatus: vi.fn()
}));

vi.mock('$lib/server/services/attachments', () => ({
	deleteExpenseAttachment: vi.fn(),
	saveExpenseAttachment: vi.fn()
}));

vi.mock('$lib/server/services/workspaces', () => ({
	requireWorkspaceContext: mocks.requireWorkspaceContext
}));

function createEvent(fields: Record<string, string>, locale = 'pt-BR', enhanced = true) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		formData.set(key, value);
	}
	const headers = new Headers();
	if (enhanced) headers.set('x-sveltekit-action', 'true');

	return {
		request: new Request('http://localhost/app/expenses?/createCatalog', {
			method: 'POST',
			body: formData,
			headers
		}),
		locals: { locale }
	} as Parameters<NonNullable<typeof actions.createCatalog>>[0];
}

function createHttpError(status: 400, message: string) {
	try {
		error(status, message);
	} catch (httpError) {
		return httpError;
	}
	throw new Error('Expected SvelteKit error() to throw');
}

async function createCatalog(fields: Record<string, string>, locale = 'pt-BR', enhanced = true) {
	const action = actions.createCatalog;
	if (!action) throw new Error('createCatalog action is not registered');
	return action(createEvent(fields, locale, enhanced));
}

describe('expenses page createCatalog action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireWorkspaceContext.mockResolvedValue(mocks.context);
	});

	it('returns success data for the enhanced dialog instead of redirecting', async () => {
		mocks.createExpenseCatalogItem.mockResolvedValue({ id: 42, name: 'ACME Serviços' });

		const result = await createCatalog({
			kind: 'vendor',
			name: ' ACME   Serviços ',
			returnTo: '/app/expenses'
		});

		expect(mocks.createExpenseCatalogItem).toHaveBeenCalledWith(mocks.context, {
			kind: 'vendor',
			name: 'ACME Serviços'
		});
		expect(result).toEqual({
			catalogAction: 'createCatalog',
			catalogKind: 'vendor',
			catalogName: 'ACME Serviços',
			catalogMessage: 'Item adicionado ao cadastro com sucesso.'
		});
	});

	it('returns catalog-scoped validation errors for the dialog notification', async () => {
		const result = await createCatalog({
			kind: 'vendor',
			name: 'A',
			returnTo: '/app/expenses'
		});

		expect(mocks.createExpenseCatalogItem).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: 400,
			data: {
				message: 'Confira o cadastro auxiliar.',
				catalogAction: 'createCatalog',
				catalogMessage: 'Confira o cadastro auxiliar.'
			}
		});
	});

	it('returns catalog-scoped service errors for the dialog notification', async () => {
		mocks.createExpenseCatalogItem.mockRejectedValue(createHttpError(400, 'Fornecedor já existe.'));

		const result = await createCatalog({
			kind: 'vendor',
			name: 'Fornecedor Original',
			returnTo: '/app/expenses'
		});

		expect(result).toMatchObject({
			status: 400,
			data: {
				message: 'Fornecedor já existe.',
				catalogAction: 'createCatalog',
				catalogKind: 'vendor',
				catalogMessage: 'Fornecedor já existe.'
			}
		});
	});

	it('redirects after native form posts to preserve the non-enhanced fallback', async () => {
		mocks.createExpenseCatalogItem.mockResolvedValue({ id: 42, name: 'Pix' });

		try {
			await createCatalog(
				{
					kind: 'paymentMethod',
					name: 'Pix',
					returnTo: '/app/expenses?from=2026-07-01'
				},
				'pt-BR',
				false
			);
			throw new Error('Expected createCatalog to redirect');
		} catch (redirectError) {
			expect(isRedirect(redirectError)).toBe(true);
			expect(redirectError).toMatchObject({
				status: 303,
				location: '/app/expenses?from=2026-07-01'
			});
		}
	});
});
