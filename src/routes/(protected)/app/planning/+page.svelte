<script lang="ts">
	import LocalizedDate from '$lib/components/LocalizedDate.svelte';
	import LocalizedDateTime from '$lib/components/LocalizedDateTime.svelte';
	import { translate } from '$lib/i18n';
	import { formatCents } from '$lib/utils/format';
	import { resolve } from '$app/paths';
	import { Bell, FileUp, Pause, Play, RefreshCw, RotateCcw, Target, Trash2 } from '@lucide/svelte';
	import { untrack } from 'svelte';
	import type { ActionData, PageData } from './$types';
	type PreviewRow = {
		sourceRowId: string;
		rowNumber: number;
		description: string;
		amountCents: number;
		categoryName: string;
		isDuplicate: boolean;
	};

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const currency = $derived(data.currentWorkspace?.currency ?? 'USD');
	const amountPlaceholder = $derived(data.locale === 'pt-BR' ? '0,00' : '0.00');
	let selectedPreviewRowIds = $state<string[]>(
		untrack(() =>
			((form?.importPreview?.rows ?? []) as PreviewRow[])
				.filter((row) => !row.isDuplicate)
				.map((row) => row.sourceRowId)
		)
	);
	const selectedPreviewCount = $derived(selectedPreviewRowIds.length);
	const previewRows = $derived((form?.importPreview?.rows ?? []) as PreviewRow[]);
	const previewFailures = $derived(form?.importPreview?.failedRows ?? []);
	const actionSucceeded = $derived(
		form?.tone === 'success' ||
			(form?.importResult?.importedCount ?? 0) > 0 ||
			(form?.importResult?.duplicateCount ?? 0) > 0
	);

	function amountInputValue(cents: number | null) {
		return cents == null ? '' : (cents / 100).toFixed(2).replace('.', ',');
	}

	function frequencyLabel(value: string, interval: number) {
		const unit = value === 'weekly' ? t('week') : value === 'yearly' ? t('year') : t('month');
		const unitPlural =
			value === 'weekly' ? t('weeks') : value === 'yearly' ? t('years') : t('months');
		return interval === 1
			? t('Every {unit}', { unit })
			: t('Every {interval} {unitPlural}', { interval, unitPlural });
	}

	function importFailureSummary(batch: PageData['importBatches'][number]) {
		if (batch.failedCount === 0) return '0';
		return batch.failedCount === 1
			? t('{count} failure', { count: batch.failedCount })
			: t('{count} failures', { count: batch.failedCount });
	}

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	function money(cents: number) {
		return formatCents(cents, currency, data.locale);
	}

	function selectAllProposedRows() {
		selectedPreviewRowIds = previewRows
			.filter((row) => !row.isDuplicate)
			.map((row) => row.sourceRowId);
	}

	function clearPreviewSelection() {
		selectedPreviewRowIds = [];
	}
</script>

<svelte:head>
	<title>{t('Budget')} | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">{t('Control')}</span>
			<h2>{t('Budget')}</h2>
		</div>

		<form method="get" class="inline-form">
			<input
				type="month"
				name="periodMonth"
				value={data.periodMonth.slice(0, 7)}
				aria-label={t('Budget month')}
			/>
			<button class="button secondary" type="submit">{t('View month')}</button>
		</form>
	</div>

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

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading panel-heading-wrap">
				<h3>{t('Budget by category')}</h3>
				<div class="inline-actions">
					<span
						class={['status-pill', data.budgetAlertPreference.isEnabled ? 'success' : 'neutral']}
					>
						{data.budgetAlertPreference.isEnabled
							? t('Automatic alerts on')
							: t('Automatic alerts off')}
					</span>
					<form method="post" action="?/setBudgetAlertPreference">
						<input
							type="hidden"
							name="enabled"
							value={data.budgetAlertPreference.isEnabled ? 'false' : 'true'}
						/>
						<button class="button secondary" type="submit">
							<Bell size={16} />
							<span>
								{data.budgetAlertPreference.isEnabled
									? t('Disable automatic alerts')
									: t('Enable automatic alerts')}
							</span>
						</button>
					</form>
					<form method="post" action="?/sendBudgetAlerts">
						<input type="hidden" name="periodMonth" value={data.periodMonth} />
						<button class="button secondary" type="submit" title={t('Send budget alert email')}>
							<Target size={16} />
							<span>{t('Send alerts now')}</span>
						</button>
					</form>
				</div>
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

		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Recurrences')}</h3>
				<form method="post" action="?/syncRecurring" class="inline-form">
					<input type="hidden" name="periodMonth" value={data.periodMonth} />
					<button class="button secondary" type="submit">
						<RefreshCw size={16} />
						<span>{t('Generate due')}</span>
					</button>
				</form>
			</div>
			<form method="post" action="?/createCatalog" class="support-catalog-form compact-support">
				<input type="hidden" name="periodMonth" value={data.periodMonth} />
				<input type="hidden" name="kind" value="paymentMethod" />
				<label>
					<span>{t('New payment')}</span>
					<input name="name" required minlength="2" maxlength="80" placeholder="Boleto" />
				</label>
				<button class="button secondary" type="submit">{t('Create')}</button>
			</form>
			<form method="post" action="?/createRecurring" class="stack">
				<input type="hidden" name="periodMonth" value={data.periodMonth} />
				<label>
					<span>{t('Description')}</span>
					<input name="description" required maxlength="160" />
				</label>
				<div class="form-grid compact planning-form recurring-fields">
					<label>
						<span>{t('Value')}</span>
						<input name="amount" inputmode="decimal" placeholder={amountPlaceholder} required />
					</label>
					<label>
						<span>{t('Category')}</span>
						<select name="categoryId" required>
							{#each data.categories as category (category.id)}
								<option value={category.id}>{category.icon ?? '💼'} {category.name}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>{t('Frequency')}</span>
						<select name="frequency">
							<option value="monthly">{t('Monthly')}</option>
							<option value="weekly">{t('Weekly')}</option>
							<option value="yearly">{t('Yearly')}</option>
						</select>
					</label>
					<label>
						<span>{t('Interval')}</span>
						<input name="intervalCount" type="number" min="1" max="24" value="1" />
					</label>
				</div>
				<div class="form-grid compact planning-form recurring-fields">
					<label>
						<span>{t('Start')}</span>
						<input name="startDate" type="date" required />
					</label>
					<label>
						<span>{t('End')}</span>
						<input name="endDate" type="date" />
					</label>
					<label>
						<span>{t('Payment')}</span>
						<select name="paymentMethodId">
							<option value="">{t('Select')}</option>
							{#each data.catalogs.paymentMethods as paymentMethod (paymentMethod.id)}
								<option value={paymentMethod.id}>{paymentMethod.name}</option>
							{/each}
						</select>
					</label>
					<label>
						<span>{t('Notes')}</span>
						<input name="notes" maxlength="1000" />
					</label>
				</div>
				<button class="button primary" type="submit">{t('Create recurrence')}</button>
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
							<strong>{money(item.amountCents)}</strong>
							<span>{frequencyLabel(item.frequency, item.intervalCount)}</span>
						</div>
						<div>
							<span>{t('Next run')}</span>
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
									<span>{t('Pause')}</span>
								{:else}
									<Play size={16} />
									<span>{t('Resume')}</span>
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
			<h3>{t('Import expenses')}</h3>
			<FileUp size={19} />
		</div>
		<form
			method="post"
			action="?/importExpenses"
			enctype="multipart/form-data"
			class="form-grid compact"
		>
			<label>
				<span>{t('Format')}</span>
				<select name="sourceType">
					<option value="csv">CSV</option>
					<option value="ofx">OFX</option>
				</select>
			</label>
			<label>
				<span>{t('Default category')}</span>
				<select name="defaultCategoryId">
					<option value="">{t('Use category column')}</option>
					{#each data.categories as category (category.id)}
						<option value={category.id}>{category.icon ?? '💼'} {category.name}</option>
					{/each}
				</select>
			</label>
			<label class="span-2">
				<span>{t('File')}</span>
				<input name="file" type="file" accept=".csv,.ofx,text/csv,application/x-ofx" required />
			</label>
			<button class="button primary align-end" type="submit">{t('Import')}</button>
		</form>

		{#if form?.importPreview}
			<section class="import-preview" aria-labelledby="import-preview-title">
				<div class="panel-heading panel-heading-wrap">
					<div>
						<span class="eyebrow">{t('Review ledger')}</span>
						<h4 id="import-preview-title">{t('Import preview')}</h4>
					</div>
					<div class="inline-actions">
						<span class="status-pill success">
							{t('{count} proposed', { count: form.importPreview.proposedCount })}
						</span>
						<span class="status-pill neutral">
							{t('{count} duplicates', { count: form.importPreview.duplicateCount })}
						</span>
						<span class="status-pill neutral">
							{t('{count} failures', { count: form.importPreview.failedCount })}
						</span>
					</div>
				</div>

				<div class="preview-selection-actions">
					<p aria-live="polite">{t('{count} rows selected', { count: selectedPreviewCount })}</p>
					<div class="inline-actions">
						<button class="button secondary" type="button" onclick={selectAllProposedRows}>
							{t('Select proposed')}
						</button>
						<button class="button secondary" type="button" onclick={clearPreviewSelection}>
							{t('Clear selection')}
						</button>
					</div>
				</div>

				<div class="table-wrap import-preview-ledger">
					<table>
						<thead>
							<tr>
								<th scope="col">{t('Include')}</th>
								<th scope="col">{t('Source row')}</th>
								<th scope="col">{t('Description')}</th>
								<th scope="col">{t('Amount')}</th>
								<th scope="col">{t('Proposed category')}</th>
								<th scope="col">{t('Result')}</th>
							</tr>
						</thead>
						<tbody>
							{#each previewRows as row (row.sourceRowId)}
								<tr class:muted={row.isDuplicate}>
									<td data-label={t('Include')}>
										<input
											type="checkbox"
											name="previewSelection"
											value={row.sourceRowId}
											bind:group={selectedPreviewRowIds}
											aria-label={t('Include row {rowNumber}', { rowNumber: row.rowNumber })}
										/>
									</td>
									<td data-label={t('Source row')}>{row.rowNumber}</td>
									<td data-label={t('Description')}>{row.description}</td>
									<td data-label={t('Amount')}>{money(row.amountCents)}</td>
									<td data-label={t('Proposed category')}>{row.categoryName}</td>
									<td data-label={t('Result')}>
										{row.isDuplicate ? t('Duplicate') : t('Ready')}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				{#if previewFailures.length}
					<div class="import-errors" role="region" aria-label={t('Import failures')}>
						<h5>{t('Import failures')}</h5>
						{#each previewFailures as row, index (`failure-${row.rowNumber}-${index}`)}
							<p>
								{t('Line {rowNumber}: {message}', {
									rowNumber: row.rowNumber || '-',
									message: row.message
								})}
							</p>
						{/each}
					</div>
				{/if}

				<div class="confirm-import-form">
					<form method="post" action="?/confirmImport">
						<input type="hidden" name="previewId" value={form.importPreview.previewId} />
						<input type="hidden" name="sourceChecksum" value={form.importPreview.sourceChecksum} />
						{#each selectedPreviewRowIds as sourceRowId (sourceRowId)}
							<input type="hidden" name="selectedSourceRowId" value={sourceRowId} />
						{/each}
						<button class="button primary" type="submit" disabled={selectedPreviewCount === 0}>
							{t('Confirm selected expenses')}
						</button>
					</form>
					<form method="get" action={resolve('/app/planning')}>
						<input type="hidden" name="periodMonth" value={data.periodMonth.slice(0, 7)} />
						<button class="button secondary" type="submit">{t('Cancel preview')}</button>
					</form>
				</div>
			</section>
		{/if}

		{#if form?.importResult?.failedRows?.length}
			<div class="import-errors" role="region" aria-label={t('Import failures')}>
				{#each form.importResult.failedRows as row, index (`confirmed-failure-${row.rowNumber}-${index}`)}
					<p>
						{t('Line {rowNumber}: {message}', {
							rowNumber: row.rowNumber || '-',
							message: row.message
						})}
					</p>
				{/each}
			</div>
		{/if}

		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>{t('File')}</th>
						<th>{t('Format')}</th>
						<th>{t('Imported')}</th>
						<th>{t('Failures')}</th>
						<th>{t('Date')}</th>
						<th>{t('Actions')}</th>
					</tr>
				</thead>
				<tbody>
					{#each data.importBatches as batch (batch.id)}
						<tr>
							<td data-label={t('File')}>{batch.fileName}</td>
							<td data-label={t('Format')}>{batch.sourceType}</td>
							<td data-label={t('Imported')}>{batch.importedCount}</td>
							<td data-label={t('Failures')}>
								{#if batch.failedRows.length}
									<details class="import-failure-details">
										<summary>{importFailureSummary(batch)}</summary>
										<div>
											{#each batch.failedRows.slice(0, 4) as row, index (`${batch.id}-${row.rowNumber}-${index}`)}
												<p>
													{t('Line {rowNumber}: {message}', {
														rowNumber: row.rowNumber || '-',
														message: row.message
													})}
												</p>
											{/each}
										</div>
									</details>
								{:else}
									{batch.failedCount}
								{/if}
							</td>
							<td data-label={t('Date')}
								><LocalizedDateTime value={batch.createdAt} width="compact" /></td
							>
							<td data-label={t('Actions')}>
								{#if batch.undoneAt}
									<span class="status-pill neutral">
										{t('{count} undone', { count: batch.undoneCount })}
									</span>
								{:else if batch.importedCount > 0}
									<form
										method="post"
										action="?/undoImport"
										onsubmit={(event) => {
											if (!window.confirm(t('Undo this import batch?'))) event.preventDefault();
										}}
									>
										<input type="hidden" name="batchId" value={batch.id} />
										<button class="button secondary" type="submit">
											<RotateCcw size={16} />
											<span>{t('Undo import')}</span>
										</button>
									</form>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>
</section>
