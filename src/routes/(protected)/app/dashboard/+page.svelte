<script lang="ts">
	import BarList from '$lib/components/BarList.svelte';
	import DonutChart from '$lib/components/DonutChart.svelte';
	import LocalizedDateRange from '$lib/components/LocalizedDateRange.svelte';
	import MetricCard from '$lib/components/MetricCard.svelte';
	import TrendChart from '$lib/components/TrendChart.svelte';
	import { formatCents, formatPercent } from '$lib/utils/format';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const dashboard = $derived(data.dashboard);
	const budgetUsage = $derived(dashboard.budgetSummary.usagePct);
</script>

<svelte:head>
	<title>Dashboard | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">Visao geral</span>
			<h2>Dashboard</h2>
		</div>

		<form method="get" class="inline-form">
			<input type="date" name="from" value={dashboard.from} aria-label="Data inicial" />
			<input type="date" name="to" value={dashboard.to} aria-label="Data final" />
			<button class="button secondary" type="submit">Filtrar</button>
		</form>
	</div>

	<div class="metric-grid">
		<MetricCard label="Total" value={formatCents(dashboard.totalCents)}>
			<LocalizedDateRange from={dashboard.from} to={dashboard.to} />
		</MetricCard>
		<MetricCard label="Media semanal" value={formatCents(dashboard.weeklyAverageCents)} />
		<MetricCard label="Variacao" value={formatPercent(dashboard.previousPeriodDeltaPct)} />
		<MetricCard
			label="Maior categoria"
			value={dashboard.topCategory ? formatCents(dashboard.topCategory.totalCents) : 'Sem dados'}
			footnote={dashboard.topCategory?.label ?? ''}
		/>
		<MetricCard
			label="Orcamento"
			value={dashboard.budgetSummary.totalBudgetCents > 0
				? `${budgetUsage ?? 0}% usado`
				: 'Sem metas'}
			footnote={dashboard.budgetSummary.totalBudgetCents > 0
				? `${formatCents(dashboard.budgetSummary.spentCents)} de ${formatCents(dashboard.budgetSummary.totalBudgetCents)}`
				: ''}
		/>
		<MetricCard
			label="Alertas"
			value={`${dashboard.budgetSummary.overBudgetCount + dashboard.budgetSummary.warningCount}`}
			footnote="Categorias perto ou acima da meta"
		/>
	</div>

	<div class="dashboard-chart-grid">
		<section class="panel chart-panel">
			<div class="panel-heading">
				<h3>Distribuicao por categoria</h3>
			</div>
			<DonutChart items={dashboard.byCategory} label="Despesas por categoria" />
		</section>

		<section class="panel chart-panel chart-panel-wide">
			<div class="panel-heading">
				<h3>Evolucao mensal</h3>
			</div>
			<TrendChart items={dashboard.byMonth} label="Despesas por mes" period="month" />
		</section>

		<section class="panel chart-panel chart-panel-full">
			<div class="panel-heading">
				<h3>Evolucao semanal</h3>
			</div>
			<TrendChart items={dashboard.byWeek} label="Despesas por semana" period="week" />
		</section>
	</div>

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>Ranking por categoria</h3>
			</div>
			<BarList items={dashboard.byCategory} />
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>Ranking por semana</h3>
			</div>
			<BarList items={dashboard.byWeek} period="week" />
		</section>
	</div>

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>Orcamento do mes</h3>
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
							<strong>{formatCents(budget.spentCents)}</strong>
							<span>de {formatCents(budget.amountCents ?? 0)}</span>
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
					<p class="empty">Nenhum orcamento definido.</p>
				{/each}
			</div>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>Ranking por pagamento</h3>
			</div>
			<BarList items={dashboard.byPaymentMethod} />
		</section>
	</div>
</section>
