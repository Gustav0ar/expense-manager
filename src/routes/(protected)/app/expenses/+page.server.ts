import { error, fail, isHttpError, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	archiveCategory as archiveCategoryService,
	createCategory as createCategoryService,
	listCategories,
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
		if (!parsed.success) {
			const fieldErrors: Record<string, string> = {};
			for (const [field, errors] of Object.entries(parsed.error.flatten().fieldErrors)) {
				fieldErrors[field] = errors[0] ?? 'Invalid';
			}
			return fail(400, {
				message: translate(event.locals.locale, 'Check expense data.'),
				fieldErrors,
				values: {
					description: (formData.get('description') as string) ?? '',
					amount: (formData.get('amount') as string) ?? '',
					expenseDate: (formData.get('expenseDate') as string) ?? '',
					categoryId: (formData.get('categoryId') as string) ?? '',
					paymentMethodId: (formData.get('paymentMethodId') as string) ?? '',
					vendorId: formData.get('vendorId') ? Number(formData.get('vendorId')) : null,
					costCenterId: formData.get('costCenterId') ? Number(formData.get('costCenterId')) : null,
					competencyMonth: (formData.get('competencyMonth') as string) ?? '',
					installments: (formData.get('installments') as string) ?? '1',
					notes: (formData.get('notes') as string) ?? ''
				}
			});
		}

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
			if (isHttpError(catalogError) && catalogError.status < 500 && catalogError.status !== 403) {
				return fail(catalogError.status, {
					message: catalogError.body.message,
					catalogAction: 'createCatalog',
					catalogKind: parsed.data.kind,
					catalogMessage: catalogError.body.message
				});
			}
			throw catalogError;
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
			if (
				isHttpError(categoryError) &&
				categoryError.status < 500 &&
				categoryError.status !== 403
			) {
				return fail(categoryError.status, {
					message: categoryError.body.message,
					categoryAction: 'createCategory',
					categoryMessage: categoryError.body.message
				});
			}
			throw categoryError;
		}
	},
	updateCategory: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		const parsed = parseForm(formData, categorySchema);
		if (!id.success || !parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check category data.') });

		try {
			await updateCategoryService(context, id.data, parsed.data);
		} catch (categoryError) {
			if (isHttpError(categoryError) && categoryError.status < 500) {
				return fail(categoryError.status, { message: categoryError.body.message });
			}
			throw categoryError;
		}
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	},
	archiveCategory: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid category.') });

		try {
			await archiveCategoryService(context, id.data);
		} catch (categoryError) {
			if (isHttpError(categoryError) && categoryError.status < 500) {
				return fail(categoryError.status, { message: categoryError.body.message });
			}
			throw categoryError;
		}
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
			if (isHttpError(err) && err.status < 500) {
				return fail(err.status, { message: err.body.message });
			}
			throw err;
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
			if (isHttpError(err) && err.status < 500) {
				return fail((err as { status: number }).status, {
					message: (err as { body: { message: string } }).body.message
				});
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

function isEnhancedAction(event: { request: Request }) {
	return event.request.headers.get('x-sveltekit-action') === 'true';
}
