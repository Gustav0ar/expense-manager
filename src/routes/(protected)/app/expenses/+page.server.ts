import { error, fail, isHttpError, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listCategories } from '$lib/server/services/categories';
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
	updateExpense,
	updateExpensePaymentStatus
} from '$lib/server/services/expenses';
import { saveExpenseAttachment } from '$lib/server/services/attachments';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import {
	expenseFilterSchema,
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
		listCategories(context),
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
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check expense data.') });

		try {
			await createExpense(context, parsed.data);
		} catch (err) {
			if (isHttpError(err) && err.status === 409) {
				return fail(409, { message: err.body.message });
			}
			throw err;
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	createCatalog: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expenseCatalogSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check auxiliary catalog.') });

		await createExpenseCatalogItem(context, parsed.data);
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	updateCatalog: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expenseCatalogUpdateSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check auxiliary catalog.') });

		try {
			await updateExpenseCatalogItem(context, parsed.data);
		} catch (catalogError) {
			if (isHttpError(catalogError) && catalogError.status < 500) {
				return fail(catalogError.status, { message: catalogError.body.message });
			}
			throw catalogError;
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	removeCatalog: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expenseCatalogArchiveSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid auxiliary catalog.') });

		try {
			await removeExpenseCatalogItem(context, parsed.data);
		} catch (catalogError) {
			if (isHttpError(catalogError) && catalogError.status < 500) {
				return fail(catalogError.status, { message: catalogError.body.message });
			}
			throw catalogError;
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
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
			if (isHttpError(err) && err.status === 409) {
				return fail(409, { message: err.body.message });
			}
			throw err;
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
			if (isHttpError(err) && err.status === 409) {
				return fail(409, { message: err.body.message });
			}
			throw err;
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
			if (isHttpError(err) && err.status === 409) {
				return fail(409, { message: err.body.message });
			}
			throw err;
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
			if (isHttpError(err) && err.status === 409) {
				return fail(409, { message: err.body.message });
			}
			throw err;
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
			if (isHttpError(err) && err.status === 409) {
				return fail(409, { message: err.body.message });
			}
			throw err;
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	}
};

function safeExpensesReturnTo(value: FormDataEntryValue | null) {
	const path = value?.toString() || '/app/expenses';
	return path.startsWith('/app/expenses') && !path.startsWith('//') ? path : '/app/expenses';
}
