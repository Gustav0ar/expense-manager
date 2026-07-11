import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	budgetFormValues,
	handleServiceError,
	localizedFormFieldErrors
} from '$lib/server/action-utils';
import { listCategories } from '$lib/server/services/categories';
import {
	deleteBudget,
	getBudgetAlertPreference,
	listBudgetAlertDeliveryHistory,
	listBudgetAlertEligibleRecipients,
	listBudgetStatus,
	retryBudgetAlertDelivery,
	sendBudgetAlerts,
	setBudgetAlertPreference,
	upsertBudget
} from '$lib/server/services/budgets';
import {
	confirmImportPreview,
	listImportBatches,
	previewImportExpenses,
	undoImportBatch
} from '$lib/server/services/imports';
import {
	decideBankTransaction,
	listReconciliationQueue,
	stageOfxTransactions
} from '$lib/server/services/reconciliation';
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
	budgetAlertPreferenceSchema,
	budgetAlertHistoryFilterSchema,
	confirmImportPreviewSchema,
	idSchema,
	expenseCatalogSchema,
	importExpenseSchema,
	parseForm,
	planningFilterSchema,
	recurringExpenseSchema,
	reconciliationCreateSchema,
	reconciliationIgnoreSchema,
	reconciliationMatchSchema,
	undoImportBatchSchema
} from '$lib/server/validation';
import { translate } from '$lib/i18n';
import { canManageBudgets } from '$lib/server/security/roles';

export const load: PageServerLoad = async (event) => {
	const context = await requireWorkspaceContext(event);
	const filters = planningFilterSchema.safeParse({
		periodMonth: event.url.searchParams.get('periodMonth') || undefined
	});
	if (!filters.success) throw error(400, translate(event.locals.locale, 'Filters are invalid.'));
	const periodMonth = filters.data.periodMonth || firstDayOfMonth(new Date());
	const historyFilters = budgetAlertHistoryFilterSchema.safeParse({
		cursor: event.url.searchParams.get('alertCursor') || undefined
	});
	if (!historyFilters.success)
		throw error(400, translate(event.locals.locale, 'Filters are invalid.'));
	const canManageBudgetAlerts = canManageBudgets(context.role);

	const [
		categories,
		catalogs,
		budgets,
		budgetAlertPreference,
		recurringExpenses,
		importBatches,
		reconciliationQueue
	] = await Promise.all([
		listCategories(context),
		listExpenseCatalogs(context),
		listBudgetStatus(context, periodMonth),
		getBudgetAlertPreference(context),
		listRecurringExpenses(context),
		listImportBatches(context),
		listReconciliationQueue(context)
	]);
	const [budgetAlertRecipients, budgetAlertHistory] = canManageBudgetAlerts
		? await Promise.all([
				listBudgetAlertEligibleRecipients(context),
				listBudgetAlertDeliveryHistory(context, historyFilters.data)
			])
		: [[], { items: [], nextCursor: null }];

	return {
		categories,
		catalogs,
		periodMonth,
		budgets,
		budgetAlertPreference,
		canManageBudgetAlerts,
		budgetAlertRecipients,
		budgetAlertHistory,
		recurringExpenses,
		importBatches,
		reconciliationQueue
	};
};

export const actions: Actions = {
	upsertBudget: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, budgetSchema);
		if (!parsed.success) {
			const fieldErrors = localizedFormFieldErrors(parsed.error, event.locals.locale);
			return fail(400, {
				message: fieldErrors.amount ?? translate(event.locals.locale, 'Check budget data.'),
				budgetValues: budgetFormValues(formData)
			});
		}

		await upsertBudget(context, parsed.data);
		throw redirect(303, `/app/planning?periodMonth=${parsed.data.periodMonth}`);
	},
	deleteBudget: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid budget.') });

		await deleteBudget(context, id.data);
		throw redirect(303, planningPath(formData));
	},
	setBudgetAlertPreference: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		if (!formData.has('recipientMode')) {
			const enabled = formData.get('enabled');
			if (enabled !== 'true' && enabled !== 'false')
				return fail(400, {
					message: translate(event.locals.locale, 'Invalid budget alert preference.'),
					tone: 'danger'
				});
			try {
				await setBudgetAlertPreference(context, enabled === 'true');
			} catch (serviceError) {
				return handleServiceError(serviceError, { tone: 'danger' }, { exclude403: true });
			}
			return {
				tone: 'success',
				message: translate(
					event.locals.locale,
					enabled === 'true'
						? 'Automatic budget alerts enabled.'
						: 'Automatic budget alerts disabled.'
				)
			};
		}
		const parsed = parseForm(formData, budgetAlertPreferenceSchema);
		if (!parsed.success)
			return fail(400, {
				message: translate(event.locals.locale, 'Invalid budget alert preference.'),
				tone: 'danger'
			});

		try {
			await setBudgetAlertPreference(context, {
				isEnabled: parsed.data.enabled,
				recipientMode: parsed.data.recipientMode,
				escalateOverBudget: parsed.data.escalateOverBudget,
				recipientUserIds: parsed.data.recipientUserIds
			});
		} catch (serviceError) {
			return handleServiceError(serviceError, { tone: 'danger' }, { exclude403: true });
		}
		return {
			tone: 'success',
			message: translate(event.locals.locale, 'Budget alert preferences saved.')
		};
	},
	retryBudgetAlertDelivery: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success)
			return fail(400, {
				message: translate(event.locals.locale, 'Invalid budget alert delivery.'),
				tone: 'danger'
			});
		let result;
		try {
			result = await retryBudgetAlertDelivery(context, id.data);
		} catch (serviceError) {
			return handleServiceError(serviceError, { tone: 'danger' }, { exclude403: true });
		}
		return {
			tone: result.failedCount > 0 ? 'danger' : 'success',
			message:
				result.sentCount > 0
					? translate(event.locals.locale, 'Budget alert delivery retried.')
					: translate(event.locals.locale, 'Budget alert delivery retry failed.')
		};
	},
	sendBudgetAlerts: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, budgetAlertSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid alert month.') });

		const result = await sendBudgetAlerts(context, parsed.data.periodMonth);

		if (result.alreadySent) {
			return {
				tone: 'success',
				message: translate(event.locals.locale, 'Budget alert email already sent for this month.')
			};
		}
		if (result.inProgress) {
			return {
				tone: 'success',
				message: translate(event.locals.locale, 'Budget alert delivery is already in progress.')
			};
		}
		if (result.failedCount > 0) {
			return {
				tone: 'danger',
				message: translate(
					event.locals.locale,
					'{sentCount} budget alert recipients notified; {failedCount} deliveries will be retried.',
					{ sentCount: result.sentCount, failedCount: result.failedCount }
				)
			};
		}

		return {
			tone: 'success',
			message:
				result.alertCount > 0
					? translate(
							event.locals.locale,
							'{count} budget alerts sent to {sentCount} recipients.',
							{
								count: result.alertCount,
								sentCount: result.sentCount
							}
						)
					: translate(event.locals.locale, 'No budget alerts to send.')
		};
	},
	createRecurring: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, recurringExpenseSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check recurrence data.') });

		await createRecurringExpense(context, parsed.data);
		await materializeDueRecurringExpenses(context);
		throw redirect(303, planningPath(formData));
	},
	createCatalog: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, expenseCatalogSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Check auxiliary catalog.') });

		await createExpenseCatalogItem(context, parsed.data);
		throw redirect(303, planningPath(formData));
	},
	pauseRecurring: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid recurrence.') });

		await setRecurringExpenseStatus(context, id.data, 'paused');
		throw redirect(303, planningPath(formData));
	},
	resumeRecurring: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const id = idSchema.safeParse(formData.get('id'));
		if (!id.success)
			return fail(400, { message: translate(event.locals.locale, 'Invalid recurrence.') });

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
					? translate(event.locals.locale, '{count} due recurring expenses generated.', {
							count: result.createdCount
						})
					: translate(event.locals.locale, 'No recurrence due to generate.')
		};
	},
	importExpenses: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, importExpenseSchema);
		const file = formData.get('file');
		if (!parsed.success || !(file instanceof File) || file.size === 0) {
			return fail(400, { message: translate(event.locals.locale, 'Check file and format.') });
		}

		if (parsed.data.sourceType === 'ofx') {
			const result = await stageOfxTransactions(context, file);
			return {
				message: translate(
					event.locals.locale,
					'{stagedCount} bank transactions staged; {duplicateCount} duplicates and {failedCount} failures.',
					{
						stagedCount: result.stagedCount,
						duplicateCount: result.duplicateCount,
						failedCount: result.failedCount
					}
				),
				reconciliationResult: result,
				tone: result.stagedCount > 0 || result.duplicateCount > 0 ? 'success' : 'danger'
			};
		}

		const result = await previewImportExpenses(context, { ...parsed.data, file });
		return {
			message: translate(event.locals.locale, 'Import preview ready. Review before confirming.'),
			importPreview: result,
			tone: 'success'
		};
	},
	confirmImport: async (event) => {
		const context = await requireWorkspaceContext(event);
		const formData = await event.request.formData();
		const parsed = parseForm(formData, confirmImportPreviewSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Import preview is invalid.') });
		const result = await confirmImportPreview(context, {
			...parsed.data,
			selectedSourceRowIds: formData.getAll('selectedSourceRowId').map(String)
		});
		const parts: string[] = [];
		if (result.importedCount > 0) {
			parts.push(
				translate(event.locals.locale, '{count} expenses imported.', {
					count: result.importedCount
				})
			);
		}
		if (result.duplicateCount > 0) {
			parts.push(
				translate(event.locals.locale, '{count} duplicates skipped.', {
					count: result.duplicateCount
				})
			);
		}
		const isSuccess = result.importedCount > 0 || result.duplicateCount > 0;
		return {
			message:
				parts.length > 0
					? parts.join(' ')
					: translate(event.locals.locale, 'No expenses imported.'),
			importResult: result,
			tone: isSuccess ? 'success' : 'danger'
		};
	},
	undoImport: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), undoImportBatchSchema);
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Import batch is invalid.') });
		const result = await undoImportBatch(context, parsed.data.batchId);
		return {
			tone: 'success',
			message: translate(
				event.locals.locale,
				'Imported expenses undone: {undoneCount}. Protected expenses skipped: {skippedCount}.',
				result
			),
			undoResult: result
		};
	},
	matchBankTransaction: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), reconciliationMatchSchema);
		if (!parsed.success)
			return fail(400, {
				message: translate(event.locals.locale, 'Reconciliation choice is invalid.'),
				tone: 'danger'
			});
		await decideBankTransaction(context, { ...parsed.data, decision: 'match' });
		return {
			tone: 'success',
			message: translate(event.locals.locale, 'Bank transaction matched and reconciled.')
		};
	},
	createFromBankTransaction: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), reconciliationCreateSchema);
		if (!parsed.success)
			return fail(400, {
				message: translate(event.locals.locale, 'Reconciliation choice is invalid.'),
				tone: 'danger'
			});
		await decideBankTransaction(context, { ...parsed.data, decision: 'create' });
		return {
			tone: 'success',
			message: translate(event.locals.locale, 'Expense created and reconciled.')
		};
	},
	ignoreBankTransaction: async (event) => {
		const context = await requireWorkspaceContext(event);
		const parsed = parseForm(await event.request.formData(), reconciliationIgnoreSchema);
		if (!parsed.success)
			return fail(400, {
				message: translate(event.locals.locale, 'Reconciliation choice is invalid.'),
				tone: 'danger'
			});
		await decideBankTransaction(context, { ...parsed.data, decision: 'ignore' });
		return {
			tone: 'success',
			message: translate(event.locals.locale, 'Bank transaction ignored.')
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
