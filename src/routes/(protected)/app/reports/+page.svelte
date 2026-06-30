<script lang="ts">
	import { resolve } from '$app/paths';
	import BarList from '$lib/components/BarList.svelte';
	import LocalizedDate from '$lib/components/LocalizedDate.svelte';
	import { formatCents } from '$lib/utils/format';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const exportPath = resolve('/app/reports/export.csv');
	const reportPeriod = $derived(
		data.filters.groupBy === 'week' ||
			data.filters.groupBy === 'month' ||
			data.filters.groupBy === 'year'
			? data.filters.groupBy
			: undefined
	);
	const exportUrl = $derived(
		`${exportPath}?from=${data.filters.from}&to=${data.filters.to}&groupBy=${data.filters.groupBy}${data.filters.categoryId ? `&categoryId=${data.filters.categoryId}` : ''}`
	);
</script>

<svelte:head>
	<title>Relatorios | Expense Manager</title>
</svelte:head>

<section class="page-section printable">
	<div class="section-heading no-print">
		<div>
			<span class="eyebrow">Analise</span>
			<h2>Relatorios</h2>
		</div>
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
		<a class="button secondary" href={exportUrl}>CSV</a>
	</div>

	<section class="panel no-print">
		<form method="get" class="form-grid compact">
			<label>
				<span>Inicio</span>
				<input type="date" name="from" value={data.filters.from} />
			</label>
			<label>
				<span>Fim</span>
				<input type="date" name="to" value={data.filters.to} />
			</label>
			<label>
				<span>Agrupar</span>
				<select name="groupBy">
					<option value="category" selected={data.filters.groupBy === 'category'}>Categoria</option>
					<option value="week" selected={data.filters.groupBy === 'week'}>Semana</option>
					<option value="month" selected={data.filters.groupBy === 'month'}>Mes</option>
					<option value="year" selected={data.filters.groupBy === 'year'}>Ano</option>
					<option value="payment" selected={data.filters.groupBy === 'payment'}>Pagamento</option>
				</select>
			</label>
			<label>
				<span>Categoria</span>
				<select name="categoryId">
					<option value="">Todas</option>
					{#each data.categories as category (category.id)}
						<option value={category.id} selected={data.filters.categoryId === category.id}
							>{category.name}</option
						>
					{/each}
				</select>
			</label>
			<button class="button primary align-end" type="submit">Gerar</button>
		</form>
	</section>

	<section class="panel">
		<div class="panel-heading">
			<h3>Resultado</h3>
		</div>
		<BarList items={data.report} period={reportPeriod} />

		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Grupo</th>
						<th>Valor</th>
					</tr>
				</thead>
				<tbody>
					{#each data.report as row (row.key)}
						<tr>
							<td>
								{#if reportPeriod}
									<LocalizedDate value={row.label} period={reportPeriod} />
								{:else}
									{row.label}
								{/if}
							</td>
							<td class="amount">{formatCents(row.totalCents)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
</section>
