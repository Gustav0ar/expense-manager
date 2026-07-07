import { error, isHttpError, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from './+page.server';

const mocks = vi.hoisted(() => ({
	archiveCategory: vi.fn(),
	createCategory: vi.fn(),
	createExpenseCatalogItem: vi.fn(),
	requireWorkspaceContext: vi.fn(),
	updateCategory: vi.fn(),
	context: {
		workspaceId: 12,
		userId: 'user-1',
		role: 'owner',
		locale: 'pt-BR'
	}
}));

vi.mock('$lib/server/services/categories', () => ({
	archiveCategory: mocks.archiveCategory,
	createCategory: mocks.createCategory,
	listCategories: vi.fn(),
	updateCategory: mocks.updateCategory
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

function createEvent(
	fields: Record<string, string>,
	locale = 'pt-BR',
	enhanced = true,
	action = 'createCatalog'
) {
	const formData = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		formData.set(key, value);
	}
	const headers = new Headers();
	if (enhanced) headers.set('x-sveltekit-action', 'true');

	return {
		request: new Request(`http://localhost/app/expenses?/${action}`, {
			method: 'POST',
			body: formData,
			headers
		}),
		locals: { locale }
	} as Parameters<NonNullable<typeof actions.createCatalog>>[0];
}

function createHttpError(status: 400 | 403, message: string) {
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
	return action(createEvent(fields, locale, enhanced, 'createCatalog'));
}

async function createCategory(fields: Record<string, string>, locale = 'pt-BR', enhanced = true) {
	const action = actions.createCategory;
	if (!action) throw new Error('createCategory action is not registered');
	return action(createEvent(fields, locale, enhanced, 'createCategory'));
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

	it('preserves permission errors as HTTP errors', async () => {
		mocks.createExpenseCatalogItem.mockRejectedValue(createHttpError(403, 'Permissão negada.'));

		try {
			await createCatalog({
				kind: 'vendor',
				name: 'Viewer Vendor',
				returnTo: '/app/expenses'
			});
			throw new Error('Expected createCatalog to throw');
		} catch (catalogError) {
			expect(isHttpError(catalogError, 403)).toBe(true);
			expect(catalogError).toMatchObject({
				status: 403,
				body: { message: 'Permissão negada.' }
			});
		}
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

describe('expenses page createCategory action', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireWorkspaceContext.mockResolvedValue(mocks.context);
	});

	it('returns success data for the enhanced category dialog instead of redirecting', async () => {
		mocks.createCategory.mockResolvedValue({ id: 55 });

		const result = await createCategory({
			name: ' Categoria Dialog ',
			color: '#0f766e',
			icon: '🧾',
			returnTo: '/app/expenses'
		});

		expect(mocks.createCategory).toHaveBeenCalledWith(mocks.context, {
			name: 'Categoria Dialog',
			color: '#0f766e',
			icon: '🧾'
		});
		expect(result).toEqual({
			categoryAction: 'createCategory',
			categoryMessage: 'Categoria criada com sucesso.'
		});
	});

	it('returns category-scoped validation errors for the dialog notification', async () => {
		const result = await createCategory({
			name: 'A',
			color: 'blue',
			icon: '❌',
			returnTo: '/app/expenses'
		});

		expect(mocks.createCategory).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			status: 400,
			data: {
				message: 'Confira os dados da categoria.',
				categoryAction: 'createCategory',
				categoryMessage: 'Confira os dados da categoria.'
			}
		});
	});

	it('preserves category permission errors as HTTP errors', async () => {
		mocks.createCategory.mockRejectedValue(createHttpError(403, 'Permissão negada.'));

		try {
			await createCategory({
				name: 'Viewer Category',
				color: '#2563eb',
				icon: '💼',
				returnTo: '/app/expenses'
			});
			throw new Error('Expected createCategory to throw');
		} catch (categoryError) {
			expect(isHttpError(categoryError, 403)).toBe(true);
			expect(categoryError).toMatchObject({
				status: 403,
				body: { message: 'Permissão negada.' }
			});
		}
	});

	it('redirects category creation after native form posts', async () => {
		mocks.createCategory.mockResolvedValue({ id: 55 });

		try {
			await createCategory(
				{
					name: 'Operacional',
					color: '#2563eb',
					icon: '🧰',
					returnTo: '/app/expenses?from=2026-07-01'
				},
				'pt-BR',
				false
			);
			throw new Error('Expected createCategory to redirect');
		} catch (redirectError) {
			expect(isRedirect(redirectError)).toBe(true);
			expect(redirectError).toMatchObject({
				status: 303,
				location: '/app/expenses?from=2026-07-01'
			});
		}
	});
});
