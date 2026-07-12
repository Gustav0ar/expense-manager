import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	handleServiceError,
	expenseFormValues,
	localizedFormFieldErrors
} from '$lib/server/action-utils';
import { listCategories } from '$lib/server/services/categories';
import { listExpenseCatalogs } from '$lib/server/services/expense-catalogs';
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
	expensePaymentSchema,
	expenseReviewSchema,
	expenseSchema,
	idSchema,
	parseForm
} from '$lib/server/validation';
import { canReconcileExpenses, canReviewExpenses } from '$lib/server/security/roles';
import { translate } from '$lib/i18n';
import { safeExpensesReturnTo } from './expense-action-helpers';
import { createSupportCatalogActions } from './support-catalog-actions';

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
	...createSupportCatalogActions(),
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
