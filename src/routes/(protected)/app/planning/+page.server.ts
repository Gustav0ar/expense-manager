import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { listCategories } from '$lib/server/services/categories';
import {
	deleteBudget,
	listBudgetStatus,
	sendBudgetAlerts,
	upsertBudget
} from '$lib/server/services/budgets';
import { importExpenses, listImportBatches } from '$lib/server/services/imports';
import {
	createExpenseCatalogItem,
	listExpenseCatalogs
} from '$lib/server/services/expense-catalogs';
import {
	createRecurringExpense,
	listRecurringExpenses,
	materializeDueRecurringExpenses,
	setRecurringExpenseStatus
} from '$lib/server/services/recurring';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { firstDayOfMonth } from '$lib/server/utils/date';
import {
	budgetSchema,
	budgetAlertSchema,
	idSchema,
	expenseCatalogSchema,
	importExpenseSchema,
	parseForm,
	planningFilterSchema,
	recurringExpenseSchema
} from '$lib/server/validation';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	const filters = planningFilterSchema.safeParse({
		periodMonth: event.url.searchParams.get('periodMonth') || undefined
	});
	if (!filters.success) throw error(400, 'Filtros invalidos.');
	const periodMonth = filters.data.periodMonth || firstDayOfMonth(new Date(), context.timezone);

	const [categories, catalogs, budgets, recurringExpenses, importBatches] = await Promise.all([
		listCategories(context),
		listExpenseCatalogs(context),
		listBudgetStatus(context, periodMonth),
		listRecurringExpenses(context),
		listImportBatches(context)
	]);

	return {
		categories,
		catalogs,
		periodMonth,
		budgets,
		recurringExpenses,
		importBatches
	};
};

export const actions: Actions = {
	upsertBudget: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), budgetSchema);
		if (!parsed.success) return fail(400, { message: 'Confira os dados do orcamento.' });

		await upsertBudget(context, parsed.data);
		throw redirect(303, `/app/planning?periodMonth=${parsed.data.periodMonth}`);
	},
	deleteBudget: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success) return fail(400, { message: 'Orcamento invalido.' });

		await deleteBudget(context, id.data);
		throw redirect(303, planningPath(formData));
	},
	sendBudgetAlerts: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, budgetAlertSchema);
		if (!parsed.success) return fail(400, { message: 'Mes invalido para alertas.' });

		const result = await sendBudgetAlerts(context, parsed.data.periodMonth);
		return {
			tone: 'success',
			message:
				result.alertCount > 0
					? `${result.alertCount} alertas enviados para ${result.sentCount} destinatarios.`
					: 'Nenhum alerta de orcamento para enviar.'
		};
	},
	createRecurring: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, recurringExpenseSchema);
		if (!parsed.success) return fail(400, { message: 'Confira os dados da recorrencia.' });

		await createRecurringExpense(context, parsed.data);
		await materializeDueRecurringExpenses(context);
		throw redirect(303, planningPath(formData));
	},
	createCatalog: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expenseCatalogSchema);
		if (!parsed.success) return fail(400, { message: 'Confira o cadastro auxiliar.' });

		await createExpenseCatalogItem(context, parsed.data);
		throw redirect(303, planningPath(formData));
	},
	pauseRecurring: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success) return fail(400, { message: 'Recorrencia invalida.' });

		await setRecurringExpenseStatus(context, id.data, 'paused');
		throw redirect(303, planningPath(formData));
	},
	resumeRecurring: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success) return fail(400, { message: 'Recorrencia invalida.' });

		await setRecurringExpenseStatus(context, id.data, 'active');
		await materializeDueRecurringExpenses(context);
		throw redirect(303, planningPath(formData));
	},
	syncRecurring: async (event) => {
		const context = await requireWorkspaceContext(event);
		const result = await materializeDueRecurringExpenses(context);
		return {
			tone: 'success',
			message:
				result.createdCount > 0
					? `${result.createdCount} despesas recorrentes geradas.`
					: 'Nenhuma recorrencia vencida para gerar.'
		};
	},
	importExpenses: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, importExpenseSchema);
		const file = formData.get('file');
		if (!parsed.success || !(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Confira arquivo e formato.' });
		}

		const result = await importExpenses(context, { ...parsed.data, file });
		return {
			message:
				result.importedCount > 0
					? `${result.importedCount} despesas importadas.`
					: 'Nenhuma despesa importada.',
			importResult: result
		};
	}
};

function planningPath(formData: FormData) {
	const parsed = planningFilterSchema.safeParse({
		periodMonth: formData.get('periodMonth')?.toString() || undefined
	});
	return parsed.success && parsed.data.periodMonth
		? `/app/planning?periodMonth=${parsed.data.periodMonth}`
		: '/app/planning';
}
