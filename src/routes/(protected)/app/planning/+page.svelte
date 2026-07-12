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
	<nav class="planning-tabs" aria-label={t('Planning')}>
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

<style>
	.planning-tabs {
		display: flex;
		width: fit-content;
		max-width: 100%;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-bottom: 1rem;
		padding: 0.3rem;
		border: 1px solid var(--color-line-soft);
		border-radius: 10px;
		background: var(--color-surface-muted);
	}

	.planning-tabs a {
		display: inline-flex;
		min-height: 44px;
		align-items: center;
		justify-content: center;
		padding: 0.6rem 0.9rem;
		border-radius: 8px;
		color: var(--color-muted);
		font-weight: 800;
		text-align: center;
		text-decoration: none;
	}

	.planning-tabs a:hover {
		color: var(--color-ink);
	}

	.planning-tabs a.active {
		background: var(--color-surface);
		box-shadow: inset 0 0 0 1px var(--color-line);
		color: var(--color-primary-strong);
	}

	@media (max-width: 42rem) {
		.planning-tabs {
			display: grid;
			width: 100%;
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}

		.planning-tabs a {
			padding-inline: 0.4rem;
			font-size: 0.82rem;
		}
	}
</style>
