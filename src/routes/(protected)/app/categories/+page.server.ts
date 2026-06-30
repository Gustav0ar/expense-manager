import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	archiveCategory,
	createCategory,
	listCategories,
	updateCategory
} from '$lib/server/services/categories';
import {
	archiveCategoryRule,
	createCategoryRule,
	listCategoryRules
} from '$lib/server/services/category-rules';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { categoryRuleSchema, categorySchema, idSchema, parseForm } from '$lib/server/validation';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	const [categories, categoryRules] = await Promise.all([
		listCategories(context, true),
		listCategoryRules(context)
	]);
	return {
		categories,
		categoryRules
	};
};

export const actions: Actions = {
	create: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), categorySchema);
		if (!parsed.success) return fail(400, { message: 'Confira os dados da categoria.' });

		await createCategory(context, parsed.data);
		throw redirect(303, '/app/categories');
	},
	update: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		const parsed = parseForm(formData, categorySchema);
		if (!id.success || !parsed.success)
			return fail(400, { message: 'Confira os dados da categoria.' });

		await updateCategory(context, id.data, parsed.data);
		throw redirect(303, '/app/categories');
	},
	archive: async (event) => {
		const context = await requireWorkspaceContext(event);
		const id = idSchema.safeParse((await event.request.formData()).get('id'));
		if (!id.success) return fail(400, { message: 'Categoria invalida.' });

		await archiveCategory(context, id.data);
		throw redirect(303, '/app/categories');
	},
	createRule: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), categoryRuleSchema);
		if (!parsed.success) return fail(400, { message: 'Confira os dados da regra.' });

		await createCategoryRule(context, parsed.data);
		throw redirect(303, '/app/categories');
	},
	archiveRule: async (event) => {
		const context = await requireWorkspaceContext(event);
		const id = idSchema.safeParse((await event.request.formData()).get('id'));
		if (!id.success) return fail(400, { message: 'Regra invalida.' });

		await archiveCategoryRule(context, id.data);
		throw redirect(303, '/app/categories');
	}
};
