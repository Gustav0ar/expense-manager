import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	handleServiceError,
	expenseFormValues,
	localizedFormFieldErrors
} from '$lib/server/action-utils';
import {
	createCategory as createCategoryService,
	listCategories,
	removeCategory as removeCategoryService,
	unarchiveCategory as unarchiveCategoryService,
	updateCategory as updateCategoryService
} from '$lib/server/services/categories';
import {
	createExpenseCatalogItem,
	listExpenseCatalogs,
	removeExpenseCatalogItem,
	updateExpenseCatalogItem
} from '$lib/server/services/expense-catalogs';
import {
	createExpense,
	deleteExpense,
	getExpenseListSummary,
	listExpenses,
	reviewExpense,
	bulkReviewExpenses,
	updateExpense,
	updateExpensePaymentStatus
} from '$lib/server/services/expenses';
import { saveExpenseAttachment, deleteExpenseAttachment } from '$lib/server/services/attachments';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import {
	expenseFilterSchema,
	categorySchema,
	expenseCatalogArchiveSchema,
	expenseCatalogSchema,
	expenseCatalogUpdateSchema,
	expensePaymentSchema,
	expenseReviewSchema,
	expenseSchema,
	idSchema,
	parseForm
} from '$lib/server/validation';
import { canReconcileExpenses, canReviewExpenses } from '$lib/server/security/roles';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	const parsedFilters = expenseFilterSchema.safeParse(
		Object.fromEntries(event.url.searchParams.entries())
	);
	if (!parsedFilters.success)
		throw error(400, translate(event.locals.locale, 'Filters are invalid.'));

	const [categories, catalogs, expenses, expenseSummary] = await Promise.all([
		listCategories(context, true),
		listExpenseCatalogs(context),
		listExpenses(context, parsedFilters.data),
		getExpenseListSummary(context, parsedFilters.data)
	]);

	return {
		categories,
		catalogs,
		expenses,
		expenseSummary,
		filters: parsedFilters.data,
		permissions: {
			canReview: canReviewExpenses(context.role),
			canReconcile: canReconcileExpenses(context.role)
		},
		returnTo: `${event.url.pathname}${event.url.search}`
	};
};

export const actions: Actions = {
	create: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expenseSchema);
		if (!parsed.success) {
			return fail(400, {
				message: translate(event.locals.locale, 'Check expense data.'),
				fieldErrors: localizedFormFieldErrors(parsed.error, event.locals.locale),
				values: expenseFormValues(formData)
			});
		}

		try {
			await createExpense(context, parsed.data);
		} catch (err) {
			return handleServiceError(err, {}, { only409: true });
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	createCatalog: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expenseCatalogSchema);
		if (!parsed.success) {
			const message = translate(event.locals.locale, 'Check auxiliary catalog.');
			return fail(400, {
				message,
				catalogAction: 'createCatalog',
				catalogMessage: message
			});
		}

		try {
			const item = await createExpenseCatalogItem(context, parsed.data);
			if (!isEnhancedAction(event)) {
				throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
			}

			return {
				catalogAction: 'createCatalog',
				catalogKind: parsed.data.kind,
				catalogName: item.name,
				catalogMessage: translate(event.locals.locale, 'Catalog item added successfully.')
			};
		} catch (catalogError) {
			return handleServiceError(
				catalogError,
				{ catalogAction: 'createCatalog', catalogKind: parsed.data.kind },
				{ exclude403: true }
			);
		}
	},
	createCategory: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, categorySchema);
		if (!parsed.success) {
			const message = translate(event.locals.locale, 'Check category data.');
			return fail(400, {
				message,
				categoryAction: 'createCategory',
				categoryMessage: message
			});
		}

		try {
			await createCategoryService(context, parsed.data);
			if (!isEnhancedAction(event)) {
				throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
			}

			return {
				categoryAction: 'createCategory',
				categoryMessage: translate(event.locals.locale, 'Category created successfully.')
			};
		} catch (categoryError) {
			return handleServiceError(
				categoryError,
				{ categoryAction: 'createCategory' },
				{ exclude403: true }
			);
		}
	},
	updateCategory: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		const parsed = parseForm(formData, categorySchema);
		if (!id.success || !parsed.success) {
			const message = translate(event.locals.locale, 'Check category data.');
			return fail(400, {
				message,
				categoryAction: 'updateCategory',
				categoryMessage: message
			});
		}

		try {
			await updateCategoryService(context, id.data, parsed.data);
			if (!isEnhancedAction(event)) {
				throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
			}
			return {
				categoryAction: 'updateCategory',
				categoryMessage: translate(event.locals.locale, 'Category updated successfully.')
			};
		} catch (categoryError) {
			return handleServiceError(categoryError, { categoryAction: 'updateCategory' });
		}
	},
	removeCategory: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success) {
			const message = translate(event.locals.locale, 'Invalid category.');
			return fail(400, {
				message,
				categoryAction: 'removeCategory',
				categoryMessage: message
			});
		}

		try {
			const removed = await removeCategoryService(context, id.data);
			if (!isEnhancedAction(event)) {
				throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
			}
			return {
				categoryAction: 'removeCategory',
				categoryMessage: translate(
					event.locals.locale,
					removed.mode === 'archived'
						? 'Category archived successfully.'
						: 'Category deleted successfully.'
				)
			};
		} catch (categoryError) {
			return handleServiceError(categoryError, { categoryAction: 'removeCategory' });
		}
	},
	unarchiveCategory: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success) {
			const message = translate(event.locals.locale, 'Invalid category.');
			return fail(400, {
				message,
				categoryAction: 'unarchiveCategory',
				categoryMessage: message
			});
		}

		try {
			await unarchiveCategoryService(context, id.data);
			if (!isEnhancedAction(event)) {
				throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
			}
			return {
				categoryAction: 'unarchiveCategory',
				categoryMessage: translate(event.locals.locale, 'Category restored successfully.')
			};
		} catch (categoryError) {
			return handleServiceError(categoryError, { categoryAction: 'unarchiveCategory' });
		}
	},
	updateCatalog: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expenseCatalogUpdateSchema);
		if (!parsed.success) {
			const message = translate(event.locals.locale, 'Check auxiliary catalog.');
			return fail(400, {
				message,
				catalogAction: 'updateCatalog',
				catalogMessage: message
			});
		}

		try {
			await updateExpenseCatalogItem(context, parsed.data);
			if (!isEnhancedAction(event)) {
				throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
			}
			return {
				catalogAction: 'updateCatalog',
				catalogKind: parsed.data.kind,
				catalogMessage: translate(event.locals.locale, 'Catalog item updated successfully.')
			};
		} catch (catalogError) {
			return handleServiceError(catalogError, {
				catalogAction: 'updateCatalog',
				catalogKind: parsed.data.kind
			});
		}
	},
	removeCatalog: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expenseCatalogArchiveSchema);
		if (!parsed.success) {
			const message = translate(event.locals.locale, 'Invalid auxiliary catalog.');
			return fail(400, {
				message,
				catalogAction: 'removeCatalog',
				catalogMessage: message
			});
		}

		try {
			const removed = await removeExpenseCatalogItem(context, parsed.data);
			if (!isEnhancedAction(event)) {
				throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
			}
			return {
				catalogAction: 'removeCatalog',
				catalogKind: parsed.data.kind,
				catalogMessage: translate(
					event.locals.locale,
					removed.mode === 'archived'
						? 'Catalog item archived successfully.'
						: 'Catalog item deleted successfully.'
				)
			};
		} catch (catalogError) {
			return handleServiceError(catalogError, {
				catalogAction: 'removeCatalog',
				catalogKind: parsed.data.kind
			});
		}
	},
	update: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		const parsed = parseForm(formData, expenseSchema);
		if (!id.success || !parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check expense data.') });

		try {
			await updateExpense(context, id.data, parsed.data);
		} catch (err) {
			// 409 means a concurrent modification was detected between the SELECT
			// and the UPDATE; surface it as an inline form message so the user can
			// reload and retry without losing context.
			return handleServiceError(err, {}, { only409: true });
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	delete: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid expense.') });

		try {
			await deleteExpense(context, id.data);
		} catch (err) {
			return handleServiceError(err, {}, { only409: true });
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	review: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expenseReviewSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check review data.') });

		try {
			await reviewExpense(context, parsed.data.id, parsed.data);
		} catch (err) {
			return handleServiceError(err, {}, { only409: true });
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	payment: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expensePaymentSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check payment data.') });

		try {
			await updateExpensePaymentStatus(context, parsed.data.id, parsed.data);
		} catch (err) {
			return handleServiceError(err, {}, { only409: true });
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	attach: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		const file = formData.get('attachment');
		if (!id.success || !(file instanceof File) || file.size === 0) {
			return fail(400, { message: translate(event.locals.locale, 'Invalid attachment.') });
		}

		try {
			await saveExpenseAttachment(context, id.data, file);
		} catch (err) {
			return handleServiceError(err, {}, { exclude403: true });
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	deleteAttachment: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid attachment.') });

		try {
			await deleteExpenseAttachment(context, id.data);
		} catch (err) {
			return handleServiceError(err);
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	bulkReview: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const ids = formData.getAll('id').map(Number).filter(Boolean);
		const decision = formData.get('decision') as string;
		if (decision !== 'approved' && decision !== 'rejected') {
			return fail(400, { message: translate(event.locals.locale, 'Invalid decision.') });
		}
		if (ids.length === 0) {
			return fail(400, { message: translate(event.locals.locale, 'No expenses selected.') });
		}

		try {
			await bulkReviewExpenses(context, ids, decision);
		} catch (err) {
			return handleServiceError(err);
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	}
};

function safeExpensesReturnTo(value: FormDataEntryValue | null) {
	const path = value?.toString() || '/app/expenses';
	return path.startsWith('/app/expenses') && !path.startsWith('//') ? path : '/app/expenses';
}

function isEnhancedAction(event: { request: Request }) {
	return event.request.headers.get('x-sveltekit-action') === 'true';
}
