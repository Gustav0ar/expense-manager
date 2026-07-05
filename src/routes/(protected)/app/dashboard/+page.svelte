<script lang="ts">
	import BarList from '$lib/components/BarList.svelte';
	import DonutChart from '$lib/components/DonutChart.svelte';
	import LocalizedDateRange from '$lib/components/LocalizedDateRange.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import TrendChart from '$lib/components/TrendChart.svelte';
	import { translate } from '$lib/i18n';
	import { formatCents, formatPercent } from '$lib/utils/format';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const dashboard = $derived(data.dashboard);
	const budgetUsage = $derived(dashboard.budgetSummary.usagePct);
	const currency = $derived(data.currentWorkspace?.currency ?? 'USD');

	function t(key: string, params?: Record<string, string | number>) {
		return translate(data.locale, key, params);
	}

	function money(cents: number) {
		return formatCents(cents, currency, data.locale);
	}
</script>

<svelte:head>
	<title>Dashboard | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">{t('Overview')}</span>
			<h2>{t('Dashboard')}</h2>
		</div>

		<form method="get" class="inline-form">
			<input type="date" name="from" value={dashboard.from} aria-label={t('Start date')} />
			<input type="date" name="to" value={dashboard.to} aria-label={t('End date')} />
			<button class="button secondary" type="submit">{t('Filter')}</button>
		</form>
	</div>

	<div class="metric-grid">
		<MetricCard label={t('Total')} value={money(dashboard.totalCents)}>
			<LocalizedDateRange from={dashboard.from} to={dashboard.to} />
		</MetricCard>
		<MetricCard label={t('Weekly average')} value={money(dashboard.weeklyAverageCents)} />
		<MetricCard
			label={t('Variation')}
			value={formatPercent(dashboard.previousPeriodDeltaPct, data.locale, t('No baseline'))}
		/>
		<MetricCard
			label={t('Top category')}
			value={dashboard.topCategory ? money(dashboard.topCategory.totalCents) : t('No data')}
			footnote={dashboard.topCategory?.label ?? ''}
		/>
		<MetricCard
			label={t('Budget')}
			value={dashboard.budgetSummary.totalBudgetCents > 0
				? t('{percent}% used', { percent: budgetUsage ?? 0 })
				: t('No goals')}
			footnote={dashboard.budgetSummary.totalBudgetCents > 0
				? t('{spent} of {budget}', {
						spent: money(dashboard.budgetSummary.spentCents),
						budget: money(dashboard.budgetSummary.totalBudgetCents)
					})
				: ''}
		/>
		<MetricCard
			label={t('Alerts')}
			value={`${dashboard.budgetSummary.overBudgetCount + dashboard.budgetSummary.warningCount}`}
			footnote={t('Categories near or above the goal')}
		/>
	</div>

	<div class="dashboard-chart-grid">
		<section class="panel chart-panel">
			<div class="panel-heading">
				<h3>{t('Distribution by category')}</h3>
			</div>
			<DonutChart
				items={dashboard.byCategory}
				label={t('Expenses by category')}
				empty={t('No data')}
				{currency}
				locale={data.locale}
				totalLabel={t('Total')}
				othersLabel={t('Others')}
			/>
		</section>

		<section class="panel chart-panel chart-panel-wide">
			<div class="panel-heading">
				<h3>{t('Monthly evolution')}</h3>
			</div>
			<TrendChart
				items={dashboard.byMonth}
				label={t('Expenses by month')}
				period="month"
				empty={t('No data')}
				{currency}
				locale={data.locale}
				totalLabel={t('Total in period')}
			/>
		</section>

		<section class="panel chart-panel chart-panel-full">
			<div class="panel-heading">
				<h3>{t('Weekly evolution')}</h3>
			</div>
			<TrendChart
				items={dashboard.byWeek}
				label={t('Expenses by week')}
				period="week"
				empty={t('No data')}
				{currency}
				locale={data.locale}
				totalLabel={t('Total in period')}
			/>
		</section>
	</div>

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Ranking by category')}</h3>
			</div>
			<BarList items={dashboard.byCategory} empty={t('No data')} {currency} locale={data.locale} />
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Ranking by week')}</h3>
			</div>
			<BarList
				items={dashboard.byWeek}
				period="week"
				empty={t('No data')}
				{currency}
				locale={data.locale}
			/>
		</section>
	</div>

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Monthly budget')}</h3>
			</div>
			<div class="budget-list compact-budget-list">
				{#each dashboard.budgetSummary.items.slice(0, 6) as budget (budget.categoryId)}
					<article class="budget-item">
						<div class="budget-heading">
							<span class="expense-category" style={`--category-color:${budget.categoryColor}`}>
								<span>{budget.categoryIcon ?? '💼'}</span>
								{budget.categoryName}
							</span>
							<strong>{budget.usagePct}%</strong>
						</div>
						<div class="budget-values">
							<strong>{money(budget.spentCents)}</strong>
							<span>{t('of')} {money(budget.amountCents ?? 0)}</span>
						</div>
						<div class="bar-track">
							<span
								class:warning-fill={budget.status === 'warning'}
								class:danger-fill={budget.status === 'over'}
								class="bar-fill"
								style={`width:${Math.min(budget.usagePct ?? 0, 100)}%`}
							></span>
						</div>
					</article>
				{:else}
					<p class="empty">{t('No budget defined.')}</p>
				{/each}
			</div>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Ranking by payment')}</h3>
			</div>
			<BarList
				items={dashboard.byPaymentMethod}
				empty={t('No data')}
				{currency}
				locale={data.locale}
			/>
		</section>
	</div>
</section>
