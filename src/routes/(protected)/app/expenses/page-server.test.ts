import { error, isHttpError, isRedirect } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { actions } from './+page.server';

const mocks = vi.hoisted(() => ({
	createCategory: vi.fn(),
	createExpenseCatalogItem: vi.fn(),
	removeExpenseCatalogItem: vi.fn(),
	removeCategory: vi.fn(),
	requireWorkspaceContext: vi.fn(),
	saveExpenseAttachment: vi.fn(),
	unarchiveCategory: vi.fn(),
	updateExpenseCatalogItem: vi.fn(),
	updateCategory: vi.fn(),
	context: {
		workspaceId: 12,
		userId: 'user-1',
		role: 'owner',
		locale: 'pt-BR'
	}
}));

vi.mock('$lib/server/services/categories', () => ({
	createCategory: mocks.createCategory,
	listCategories: vi.fn(),
	removeCategory: mocks.removeCategory,
	unarchiveCategory: mocks.unarchiveCategory,
	updateCategory: mocks.updateCategory
}));

vi.mock('$lib/server/services/expense-catalogs', () => ({
	createExpenseCatalogItem: mocks.createExpenseCatalogItem,
	listExpenseCatalogs: vi.fn(),
	removeExpenseCatalogItem: mocks.removeExpenseCatalogItem,
	updateExpenseCatalogItem: mocks.updateExpenseCatalogItem
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
	saveExpenseAttachment: mocks.saveExpenseAttachment
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

async function removeCategory(fields: Record<string, string>, locale = 'pt-BR', enhanced = true) {
	const action = actions.removeCategory;
	if (!action) throw new Error('removeCategory action is not registered');
	return action(createEvent(fields, locale, enhanced, 'removeCategory'));
}

async function updateCategory(fields: Record<string, string>, locale = 'pt-BR', enhanced = true) {
	const action = actions.updateCategory;
	if (!action) throw new Error('updateCategory action is not registered');
	return action(createEvent(fields, locale, enhanced, 'updateCategory'));
}

async function updateCatalog(fields: Record<string, string>, locale = 'pt-BR', enhanced = true) {
	const action = actions.updateCatalog;
	if (!action) throw new Error('updateCatalog action is not registered');
	return action(createEvent(fields, locale, enhanced, 'updateCatalog'));
}

async function removeCatalog(fields: Record<string, string>, locale = 'pt-BR', enhanced = true) {
	const action = actions.removeCatalog;
	if (!action) throw new Error('removeCatalog action is not registered');
	return action(createEvent(fields, locale, enhanced, 'removeCatalog'));
}

async function unarchiveCategory(
	fields: Record<string, string>,
	locale = 'pt-BR',
	enhanced = true
) {
	const action = actions.unarchiveCategory;
	if (!action) throw new Error('unarchiveCategory action is not registered');
	return action(createEvent(fields, locale, enhanced, 'unarchiveCategory'));
}

async function attachExpense(file: File, fields: Record<string, string> = {}, locale = 'pt-BR') {
	const action = actions.attach;
	if (!action) throw new Error('attach action is not registered');

	const formData = new FormData();
	formData.set('id', fields.id ?? '123');
	formData.set('returnTo', fields.returnTo ?? '/app/expenses');
	formData.set('attachment', file);

	return action({
		request: new Request('http://localhost/app/expenses?/attach', {
			method: 'POST',
			body: formData,
			headers: new Headers({ 'x-sveltekit-action': 'true' })
		}),
		locals: { locale }
	} as Parameters<NonNullable<typeof actions.attach>>[0]);
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
				catalogKind: 'vendor'
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

describe('expenses page category management actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireWorkspaceContext.mockResolvedValue(mocks.context);
	});

	it('keeps enhanced category deletion inside the dialog', async () => {
		mocks.removeCategory.mockResolvedValue({
			mode: 'deleted',
			item: { id: 77, name: 'Sem uso' }
		});

		const result = await removeCategory({
			id: '77',
			returnTo: '/app/expenses?categoryId=3'
		});

		expect(mocks.removeCategory).toHaveBeenCalledWith(mocks.context, 77);
		expect(result).toEqual({
			categoryAction: 'removeCategory',
			categoryMessage: 'Categoria excluída com sucesso.'
		});
	});

	it('keeps enhanced category restoration inside the dialog', async () => {
		mocks.unarchiveCategory.mockResolvedValue(undefined);

		const result = await unarchiveCategory({
			id: '88',
			returnTo: '/app/expenses'
		});

		expect(mocks.unarchiveCategory).toHaveBeenCalledWith(mocks.context, 88);
		expect(result).toEqual({
			categoryAction: 'unarchiveCategory',
			categoryMessage: 'Categoria restaurada com sucesso.'
		});
	});

	it('updates categories without closing the enhanced dialog', async () => {
		mocks.updateCategory.mockResolvedValue(undefined);

		const result = await updateCategory({
			id: '91',
			name: 'Categoria revisada',
			color: '#2563eb',
			icon: '🧰',
			returnTo: '/app/expenses'
		});

		expect(mocks.updateCategory).toHaveBeenCalledWith(mocks.context, 91, {
			name: 'Categoria revisada',
			color: '#2563eb',
			icon: '🧰'
		});
		expect(result).toEqual({
			categoryAction: 'updateCategory',
			categoryMessage: 'Categoria atualizada com sucesso.'
		});
	});

	it('retains redirects for native category mutation forms', async () => {
		mocks.removeCategory.mockResolvedValue({
			mode: 'archived',
			item: { id: 77, name: 'Em uso' }
		});

		try {
			await removeCategory({ id: '77', returnTo: '/app/expenses?categoryId=3' }, 'pt-BR', false);
			throw new Error('Expected removeCategory to redirect');
		} catch (redirectError) {
			expect(isRedirect(redirectError)).toBe(true);
			expect(redirectError).toMatchObject({
				status: 303,
				location: '/app/expenses?categoryId=3'
			});
		}
	});

	it('maps category restore conflicts to form failures', async () => {
		mocks.unarchiveCategory.mockRejectedValue(createHttpError(400, 'Categoria já existe.'));

		const result = await unarchiveCategory({
			id: '88',
			returnTo: '/app/expenses'
		});

		expect(result).toMatchObject({
			status: 400,
			data: {
				message: 'Categoria já existe.',
				categoryAction: 'unarchiveCategory'
			}
		});
	});
});

describe('expenses page catalog management actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireWorkspaceContext.mockResolvedValue(mocks.context);
	});

	it('updates catalog items without closing the enhanced dialog', async () => {
		mocks.updateExpenseCatalogItem.mockResolvedValue({ id: 21, name: 'Fornecedor novo' });

		const result = await updateCatalog({
			kind: 'vendor',
			id: '21',
			name: 'Fornecedor novo',
			returnTo: '/app/expenses'
		});

		expect(mocks.updateExpenseCatalogItem).toHaveBeenCalledWith(mocks.context, {
			kind: 'vendor',
			id: 21,
			name: 'Fornecedor novo'
		});
		expect(result).toEqual({
			catalogAction: 'updateCatalog',
			catalogKind: 'vendor',
			catalogMessage: 'Item atualizado com sucesso.'
		});
	});

	it.each([
		['archived', 'Item arquivado com sucesso.'],
		['deleted', 'Item excluído com sucesso.']
	] as const)('reports enhanced catalog %s results inside the dialog', async (mode, message) => {
		mocks.removeExpenseCatalogItem.mockResolvedValue({ mode, item: { id: 21 } });

		const result = await removeCatalog({
			kind: 'vendor',
			id: '21',
			returnTo: '/app/expenses'
		});

		expect(result).toEqual({
			catalogAction: 'removeCatalog',
			catalogKind: 'vendor',
			catalogMessage: message
		});
	});
});

describe('expenses page attachment actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.requireWorkspaceContext.mockResolvedValue(mocks.context);
	});

	it('maps oversized attachment service errors to form failures', async () => {
		mocks.saveExpenseAttachment.mockRejectedValue(createHttpError(400, 'Anexo acima de 2 MB.'));

		const result = await attachExpense(
			new File(['receipt'], 'recibo.txt', {
				type: 'text/plain'
			})
		);

		expect(mocks.saveExpenseAttachment).toHaveBeenCalledWith(mocks.context, 123, expect.any(File));
		expect(result).toMatchObject({
			status: 400,
			data: {
				message: 'Anexo acima de 2 MB.'
			}
		});
	});
});
