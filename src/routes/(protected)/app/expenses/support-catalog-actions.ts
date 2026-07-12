import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { translate } from '$lib/i18n';
import { handleServiceError } from '$lib/server/action-utils';
import {
	createCategory as createCategoryService,
	removeCategory as removeCategoryService,
	unarchiveCategory as unarchiveCategoryService,
	updateCategory as updateCategoryService
} from '$lib/server/services/categories';
import {
	createExpenseCatalogItem,
	removeExpenseCatalogItem,
	updateExpenseCatalogItem
} from '$lib/server/services/expense-catalogs';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import {
	categorySchema,
	expenseCatalogArchiveSchema,
	expenseCatalogSchema,
	expenseCatalogUpdateSchema,
	idSchema,
	parseForm
} from '$lib/server/validation';
import { isEnhancedAction, safeExpensesReturnTo } from './expense-action-helpers';

type SupportCatalogActions = Pick<
	Actions,
	| 'createCatalog'
	| 'createCategory'
	| 'updateCategory'
	| 'removeCategory'
	| 'unarchiveCategory'
	| 'updateCatalog'
	| 'removeCatalog'
>;

function redirectAfterNativeSubmission(event: { request: Request }, formData: FormData) {
	if (!isEnhancedAction(event)) {
		throw redirect(303, safeExpensesReturnTo(formData.get('returnTo')));
	}
}

export function createSupportCatalogActions(): SupportCatalogActions {
	return {
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
				redirectAfterNativeSubmission(event, formData);

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
				redirectAfterNativeSubmission(event, formData);

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
				redirectAfterNativeSubmission(event, formData);
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
				redirectAfterNativeSubmission(event, formData);
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
				redirectAfterNativeSubmission(event, formData);
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
				redirectAfterNativeSubmission(event, formData);
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
				redirectAfterNativeSubmission(event, formData);
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
		}
	};
}
