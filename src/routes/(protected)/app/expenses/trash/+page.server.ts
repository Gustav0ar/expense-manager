import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { translate } from '$lib/i18n';
import { handleServiceError } from '$lib/server/action-utils';
import {
	listTrashedExpenses,
	purgeTrashedExpense,
	restoreTrashedExpense
} from '$lib/server/services/expense-trash';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { idSchema } from '$lib/server/validation';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	const trash = await listTrashedExpenses(context, {
		cursor: event.url.searchParams.get('cursor') ?? undefined
	});
	return {
		...trash,
		serverNow: new Date(),
		isCursorPage: event.url.searchParams.has('cursor'),
		returnTo: `${event.url.pathname}${event.url.search}`
	};
};

export const actions: Actions = {
	restore: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success) return fail(400, { message: translate(context.locale, 'Invalid expense.') });
		try {
			await restoreTrashedExpense(context, id.data);
		} catch (restoreError) {
			return handleServiceError(restoreError);
		}
		throw redirect(303, safeTrashReturnTo(formData.get('returnTo')));
	},
	purge: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success) return fail(400, { message: translate(context.locale, 'Invalid expense.') });
		try {
			await purgeTrashedExpense(context, id.data);
		} catch (purgeError) {
			return handleServiceError(purgeError);
		}
		throw redirect(303, safeTrashReturnTo(formData.get('returnTo')));
	}
};

function safeTrashReturnTo(value: FormDataEntryValue | null) {
	const path = value?.toString() || '/app/expenses/trash';
	return (path === '/app/expenses/trash' || path.startsWith('/app/expenses/trash?')) &&
		!path.startsWith('//')
		? path
		: '/app/expenses/trash';
}
