<script lang="ts">
	import LocalizedDate from '$lib/components/LocalizedDate.svelte';
	import LocalizedDateTime from '$lib/components/LocalizedDateTime.svelte';
	import { formatCents } from '$lib/utils/format';
	import { Bell, FileUp, Pause, Play, RefreshCw, Target, Trash2 } from '@lucide/svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();

	function amountInputValue(cents: number | null) {
		return cents == null ? '' : (cents / 100).toFixed(2).replace('.', ',');
	}

	function frequencyLabel(value: string, interval: number) {
		const base = value === 'weekly' ? 'semana' : value === 'yearly' ? 'ano' : 'mes';
		return interval === 1 ? `Todo ${base}` : `A cada ${interval} ${base}es`;
	}

	function importFailureSummary(batch: PageData['importBatches'][number]) {
		if (batch.failedCount === 0) return '0';
		return `${batch.failedCount} falha${batch.failedCount === 1 ? '' : 's'}`;
	}
</script>

<svelte:head>
	<title>Planejamento | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">Controle</span>
			<h2>Planejamento</h2>
		</div>

		<form method="get" class="inline-form">
			<input
				type="month"
				name="periodMonth"
				value={data.periodMonth.slice(0, 7)}
				aria-label="Mes do orcamento"
			/>
			<button class="button secondary" type="submit">Ver mes</button>
		</form>
	</div>

	{#if form?.message}
		<p
			class:success={form.tone === 'success' || form.importResult?.importedCount > 0}
			class:danger={form.tone !== 'success' && !form.importResult?.importedCount}
			class="notice"
		>
			{form.message}
		</p>
	{/if}

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>Orcamento por categoria</h3>
				<div class="inline-actions">
					<Target size={19} />
					<form method="post" action="?/sendBudgetAlerts">
						<input type="hidden" name="periodMonth" value={data.periodMonth} />
						<button class="button secondary" type="submit">
							<Bell size={16} />
							<span>Enviar alertas</span>
						</button>
					</form>
				</div>
			</div>
			<form method="post" action="?/upsertBudget" class="form-grid compact planning-form">
				<input type="hidden" name="periodMonth" value={data.periodMonth} />
				<label>
					<span>Categoria</span>
					<select name="categoryId" required>
						{#each data.categories as category (category.id)}
							<option value={category.id}>{category.icon ?? '💼'} {category.name}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Valor</span>
					<input name="amount" inputmode="decimal" placeholder="0,00" required />
				</label>
				<label>
					<span>Alerta (%)</span>
					<input name="warningThresholdPct" type="number" min="1" max="100" value="80" required />
				</label>
				<button class="button primary align-end" type="submit">Salvar</button>
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
									<button class="icon-button danger" type="submit" aria-label="Remover orcamento">
										<Trash2 size={16} />
									</button>
								</form>
							{/if}
						</div>
						<div class="budget-values">
							<strong>{formatCents(budget.spentCents)}</strong>
							<span>
								{#if budget.amountCents == null}
									Sem meta
								{:else}
									de {formatCents(budget.amountCents)}
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
								placeholder="0,00"
							/>
							<input
								name="warningThresholdPct"
								type="number"
								min="1"
								max="100"
								value={budget.warningThresholdPct}
								aria-label="Alerta"
							/>
							<button class="button secondary" type="submit">Atualizar</button>
						</form>
					</article>
				{/each}
			</div>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>Recorrencias</h3>
				<form method="post" action="?/syncRecurring" class="inline-form">
					<input type="hidden" name="periodMonth" value={data.periodMonth} />
					<button class="button secondary" type="submit">
						<RefreshCw size={16} />
						<span>Gerar vencidas</span>
					</button>
				</form>
			</div>
			<form method="post" action="?/createCatalog" class="support-catalog-form compact-support">
				<input type="hidden" name="periodMonth" value={data.periodMonth} />
				<input type="hidden" name="kind" value="paymentMethod" />
				<label>
					<span>Novo pagamento</span>
					<input name="name" required minlength="2" maxlength="80" placeholder="Boleto" />
				</label>
				<button class="button secondary" type="submit">Criar</button>
			</form>
			<form method="post" action="?/createRecurring" class="stack">
				<input type="hidden" name="periodMonth" value={data.periodMonth} />
				<label>
					<span>Descricao</span>
					<input name="description" required maxlength="160" />
				</label>
				<div class="form-grid compact planning-form recurring-fields">
					<label>
						<span>Valor</span>
						<input name="amount" inputmode="decimal" placeholder="0,00" required />
					</label>
					<label>
						<span>Categoria</span>
						<select name="categoryId" required>
							{#each data.categories as category (category.id)}
								<option value={category.id}>{category.icon ?? '💼'} {category.name}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>Frequencia</span>
						<select name="frequency">
							<option value="monthly">Mensal</option>
							<option value="weekly">Semanal</option>
							<option value="yearly">Anual</option>
						</select>
					</label>
					<label>
						<span>Intervalo</span>
						<input name="intervalCount" type="number" min="1" max="24" value="1" />
					</label>
				</div>
				<div class="form-grid compact planning-form recurring-fields">
					<label>
						<span>Inicio</span>
						<input name="startDate" type="date" required />
					</label>
					<label>
						<span>Fim</span>
						<input name="endDate" type="date" />
					</label>
					<label>
						<span>Pagamento</span>
						<select name="paymentMethodId">
							<option value="">Selecione</option>
							{#each data.catalogs.paymentMethods as paymentMethod (paymentMethod.id)}
								<option value={paymentMethod.id}>{paymentMethod.name}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>Notas</span>
						<input name="notes" maxlength="1000" />
					</label>
				</div>
				<button class="button primary" type="submit">Criar recorrencia</button>
			</form>

			<div class="recurring-list">
				{#each data.recurringExpenses as item (item.id)}
					<article class:muted={item.status === 'paused'} class="recurring-item">
						<div>
							<strong>{item.description}</strong>
							<span>{item.categoryIcon ?? '💼'} {item.categoryName}</span>
							{#if item.paymentMethod}
								<span>{item.paymentMethod}</span>
							{/if}
						</div>
						<div>
							<strong>{formatCents(item.amountCents)}</strong>
							<span>{frequencyLabel(item.frequency, item.intervalCount)}</span>
						</div>
						<div>
							<span>Proximo</span>
							<strong><LocalizedDate value={item.nextRunDate} /></strong>
						</div>
						<form
							method="post"
							action={item.status === 'active' ? '?/pauseRecurring' : '?/resumeRecurring'}
						>
							<input type="hidden" name="id" value={item.id} />
							<input type="hidden" name="periodMonth" value={data.periodMonth} />
							<button class="button secondary" type="submit">
								{#if item.status === 'active'}
									<Pause size={16} />
									<span>Pausar</span>
								{:else}
									<Play size={16} />
									<span>Retomar</span>
								{/if}
							</button>
						</form>
					</article>
				{/each}
			</div>
		</section>
	</div>

	<section class="panel">
		<div class="panel-heading">
			<h3>Importar despesas</h3>
			<FileUp size={19} />
		</div>
		<form
			method="post"
			action="?/importExpenses"
			enctype="multipart/form-data"
			class="form-grid compact"
		>
			<label>
				<span>Formato</span>
				<select name="sourceType">
					<option value="csv">CSV</option>
					<option value="ofx">OFX</option>
				</select>
			</label>
			<label>
				<span>Categoria padrão</span>
				<select name="defaultCategoryId">
					<option value="">Usar coluna categoria</option>
					{#each data.categories as category (category.id)}
						<option value={category.id}>{category.icon ?? '💼'} {category.name}</option>
					{/each}
				</select>
			</label>
			<label class="span-2">
				<span>Arquivo</span>
				<input name="file" type="file" accept=".csv,.ofx,text/csv,application/x-ofx" required />
			</label>
			<button class="button primary align-end" type="submit">Importar</button>
		</form>

		{#if form?.importResult?.failedRows?.length}
			<div class="import-errors">
				{#each form.importResult.failedRows.slice(0, 6) as row, index (`${row.rowNumber}-${index}`)}
					<p>Linha {row.rowNumber || '-'}: {row.message}</p>
				{/each}
			</div>
		{/if}

		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Arquivo</th>
						<th>Formato</th>
						<th>Importadas</th>
						<th>Falhas</th>
						<th>Data</th>
					</tr>
				</thead>
				<tbody>
					{#each data.importBatches as batch (batch.id)}
						<tr>
							<td data-label="Arquivo">{batch.fileName}</td>
							<td data-label="Formato">{batch.sourceType}</td>
							<td data-label="Importadas">{batch.importedCount}</td>
							<td data-label="Falhas">
								{#if batch.failedRows.length}
									<details class="import-failure-details">
										<summary>{importFailureSummary(batch)}</summary>
										<div>
											{#each batch.failedRows.slice(0, 4) as row, index (`${batch.id}-${row.rowNumber}-${index}`)}
												<p>Linha {row.rowNumber || '-'}: {row.message}</p>
											{/each}
										</div>
									</details>
								{:else}
									{batch.failedCount}
								{/if}
							</td>
							<td data-label="Data"
								><LocalizedDateTime value={batch.createdAt} width="compact" /></td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
</section>
