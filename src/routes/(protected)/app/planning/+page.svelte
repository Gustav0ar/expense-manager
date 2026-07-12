<script lang="ts">
	import { resolve } from '$app/paths';
	import { translate } from '$lib/i18n';
	import BudgetAlertsSection from './BudgetAlertsSection.svelte';
	import ImportsReconciliationSection from './ImportsReconciliationSection.svelte';
	import RecurringSection from './RecurringSection.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const actionSucceeded = $derived(
		form?.tone === 'success' ||
			(form?.importResult?.importedCount ?? 0) > 0 ||
			(form?.importResult?.duplicateCount ?? 0) > 0
	);

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	function planningSectionPath(section: PageData['section']): `/app/planning?${string}` {
		const period = section === 'budgets' ? `&periodMonth=${data.periodMonth.slice(0, 7)}` : '';
		return `/app/planning?section=${section}${period}`;
	}
</script>

<svelte:head>
	<title>{t('Planning')} | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">{t('Control')}</span>
			<h2>
				{data.section === 'budgets'
					? t('Budget')
					: data.section === 'recurring'
						? t('Recurrences')
						: t('Import expenses')}
			</h2>
		</div>

		{#if data.section === 'budgets'}
			<form method="get" class="inline-form">
				<input type="hidden" name="section" value="budgets" />
				<input
					type="month"
					name="periodMonth"
					value={data.periodMonth.slice(0, 7)}
					aria-label={t('Budget month')}
				/>
				<button class="button secondary" type="submit">{t('View month')}</button>
			</form>
		{/if}
	</div>
	<nav class="settings-tabs" aria-label={t('Planning')}>
		<a
			href={resolve(planningSectionPath('budgets'))}
			class:active={data.section === 'budgets'}
			aria-current={data.section === 'budgets' ? 'page' : undefined}>{t('Budget')}</a
		>
		<a
			href={resolve(planningSectionPath('recurring'))}
			class:active={data.section === 'recurring'}
			aria-current={data.section === 'recurring' ? 'page' : undefined}>{t('Recurrences')}</a
		>
		<a
			href={resolve(planningSectionPath('imports'))}
			class:active={data.section === 'imports'}
			aria-current={data.section === 'imports' ? 'page' : undefined}>{t('Import expenses')}</a
		>
	</nav>

	{#if form?.message}
		<p
			class:success={actionSucceeded}
			class:danger={form.tone === 'danger' || !actionSucceeded}
			class="notice"
			role={actionSucceeded ? 'status' : 'alert'}
		>
			{form.message}
		</p>
	{/if}

	{#if data.section === 'budgets'}
		<BudgetAlertsSection {data} {form} />
	{:else if data.section === 'recurring'}
		<RecurringSection {data} />
	{:else}
		<ImportsReconciliationSection {data} {form} />
	{/if}
</section>
