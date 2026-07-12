<script lang="ts">
	import { Target, Trash2 } from '@lucide/svelte';
	import { translate } from '$lib/i18n';
	import { formatCents } from '$lib/utils/format';
	import BudgetNotificationCenter from './BudgetNotificationCenter.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const currency = $derived(data.currentWorkspace?.currency ?? 'USD');
	const amountPlaceholder = $derived(data.locale === 'pt-BR' ? '0,00' : '0.00');

	function amountInputValue(cents: number | null) {
		return cents == null ? '' : (cents / 100).toFixed(2).replace('.', ',');
	}

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	function money(cents: number) {
		return formatCents(cents, currency, data.locale);
	}
</script>

<section class="panel">
	<div class="panel-heading panel-heading-wrap">
		<h3>{t('Budget by category')}</h3>
		{#if data.canManageBudgetAlerts}
			<div class="inline-actions">
				<form method="post" action="?/sendBudgetAlerts">
					<input type="hidden" name="periodMonth" value={data.periodMonth} />
					<button class="button secondary" type="submit" title={t('Send budget alert email')}>
						<Target size={16} />
						<span>{t('Send alerts now')}</span>
					</button>
				</form>
			</div>
		{/if}
	</div>
	<form method="post" action="?/upsertBudget" class="form-grid compact planning-form">
		<input type="hidden" name="periodMonth" value={data.periodMonth} />
		<label>
			<span>{t('Category')}</span>
			<select name="categoryId" required>
				{#each data.categories as category (category.id)}
					<option
						value={category.id}
						selected={category.id.toString() === form?.budgetValues?.categoryId}
						>{category.icon ?? '💼'} {category.name}</option
					>
				{/each}
			</select>
		</label>
		<label>
			<span>{t('Value')}</span>
			<input
				name="amount"
				inputmode="decimal"
				placeholder={amountPlaceholder}
				required
				value={form?.budgetValues?.amount}
			/>
		</label>
		<label>
			<span>{t('Alert')} (%)</span>
			<input
				name="warningThresholdPct"
				type="number"
				min="1"
				max="100"
				value={form?.budgetValues?.warningThresholdPct ?? '80'}
				required
			/>
		</label>
		<button class="button primary align-end" type="submit">{t('Save')}</button>
	</form>

	<div class="budget-list">
		{#each data.budgets as budget (budget.categoryId)}
			<article class:empty-budget={budget.status === 'unset'} class="budget-item">
				<div class="budget-heading">
					<span class="expense-category" style={`--category-color:${budget.categoryColor}`}>
						<span>{budget.categoryIcon ?? '💼'}</span>
						{budget.categoryName}
					</span>
					{#if budget.budgetId}
						<form method="post" action="?/deleteBudget">
							<input type="hidden" name="id" value={budget.budgetId} />
							<input type="hidden" name="periodMonth" value={data.periodMonth} />
							<button class="icon-button danger" type="submit" aria-label={t('Remove budget')}>
								<Trash2 size={16} />
							</button>
						</form>
					{/if}
				</div>
				<div class="budget-values">
					<strong>{money(budget.spentCents)}</strong>
					<span>
						{#if budget.amountCents == null}
							{t('No goal')}
						{:else}
							{t('of')} {money(budget.amountCents)}
						{/if}
					</span>
				</div>
				<div class="bar-track">
					<span
						class:warning-fill={budget.status === 'warning'}
						class:danger-fill={budget.status === 'over'}
						class="bar-fill"
						style={`width:${Math.min(budget.usagePct ?? 0, 100)}%`}
					></span>
				</div>
				<form method="post" action="?/upsertBudget" class="budget-inline-form">
					<input type="hidden" name="periodMonth" value={data.periodMonth} />
					<input type="hidden" name="categoryId" value={budget.categoryId} />
					<input
						name="amount"
						value={amountInputValue(budget.amountCents)}
						placeholder={amountPlaceholder}
						aria-label={t('Budget amount')}
					/>
					<input
						name="warningThresholdPct"
						type="number"
						min="1"
						max="100"
						value={budget.warningThresholdPct}
						aria-label={t('Alert')}
					/>
					<button class="button secondary" type="submit">{t('Update')}</button>
				</form>
			</article>
		{/each}
	</div>
</section>

<BudgetNotificationCenter
	locale={data.locale}
	periodMonth={data.periodMonth}
	canManage={data.canManageBudgetAlerts}
	budgets={data.budgets}
	preference={data.budgetAlertPreference}
	eligibleRecipients={data.budgetAlertRecipients}
	history={data.budgetAlertHistory}
/>
