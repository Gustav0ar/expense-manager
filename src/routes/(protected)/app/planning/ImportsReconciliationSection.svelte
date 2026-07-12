<script lang="ts">
	import { resolve } from '$app/paths';
	import { FileUp, Landmark, RotateCcw } from '@lucide/svelte';
	import { untrack } from 'svelte';
	import LocalizedDate from '$lib/components/LocalizedDate.svelte';
	import LocalizedDateTime from '$lib/components/LocalizedDateTime.svelte';
	import { translate } from '$lib/i18n';
	import type { ReconciliationQueueItem } from '$lib/server/services/reconciliation';
	import { formatCents } from '$lib/utils/format';
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
	let reconciliationSearch = $state('');
	const filteredReconciliationQueue = $derived.by(() => {
		const query = reconciliationSearch.trim().toLocaleLowerCase(data.locale);
		if (!query) return data.reconciliationQueue;
		return (data.reconciliationQueue as ReconciliationQueueItem[]).filter((item) =>
			`${item.description} ${item.memo ?? ''}`.toLocaleLowerCase(data.locale).includes(query)
		);
	});

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

	function candidateDateReason(days: number) {
		return days === 0 ? t('Same date') : t('{count} days apart', { count: days });
	}
</script>

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

	{#if form?.reconciliationResult?.failedRows?.length}
		<div class="import-errors" role="region" aria-label={t('OFX staging failures')}>
			<h5>{t('OFX staging failures')}</h5>
			{#each form.reconciliationResult.failedRows as row, index (`ofx-failure-${row.rowNumber}-${index}`)}
				<p>{row.message}</p>
			{/each}
		</div>
	{/if}

	{#if data.reconciliationQueue.length > 0}
		<section class="reconciliation-workspace" aria-labelledby="reconciliation-title">
			<div class="panel-heading panel-heading-wrap">
				<div>
					<span class="eyebrow">{t('Bank ledger')}</span>
					<h4 id="reconciliation-title">{t('Reconcile OFX transactions')}</h4>
					<p>{t('Suggestions never change expenses until you confirm a decision.')}</p>
				</div>
				<Landmark size={20} />
			</div>
			<label class="reconciliation-search">
				<span>{t('Search staged transactions')}</span>
				<input
					type="search"
					bind:value={reconciliationSearch}
					placeholder={t('Search description')}
				/>
			</label>
			<p class="sr-only" aria-live="polite">
				{t('{count} transactions shown', { count: filteredReconciliationQueue.length })}
			</p>

			<div class="reconciliation-queue">
				{#each filteredReconciliationQueue as transaction (transaction.id)}
					<article
						class="reconciliation-item"
						aria-labelledby={`bank-transaction-${transaction.id}`}
					>
						<div class="bank-side">
							<span class={['status-pill', transaction.isCredit ? 'neutral' : 'warning']}>
								{transaction.isCredit ? t('Credit') : t('Debit')}
							</span>
							<h5 id={`bank-transaction-${transaction.id}`}>{transaction.description}</h5>
							<strong>{money(Math.abs(transaction.signedAmountCents))}</strong>
							<span><LocalizedDate value={transaction.postedDate} /></span>
							{#if transaction.sourceCurrency}<span>{transaction.sourceCurrency}</span>{/if}
							{#if transaction.memo}<p>{transaction.memo}</p>{/if}
						</div>

						<div class="candidate-side">
							{#if transaction.currencyMismatch}
								<p class="notice danger" role="alert">
									{t(
										'This statement currency does not match the workspace. You can only ignore this transaction.'
									)}
								</p>
							{:else if transaction.isCredit}
								<p>
									{t('Credits are staged for visibility and cannot create or match expenses.')}
								</p>
							{:else if transaction.candidates.length > 0}
								<h6>{t('Exact amount candidates')}</h6>
								<div class="candidate-list">
									{#each transaction.candidates as candidate (candidate.id)}
										<form method="post" action="?/matchBankTransaction" class="candidate-row">
											<input type="hidden" name="transactionId" value={transaction.id} />
											<input type="hidden" name="expenseId" value={candidate.id} />
											<div>
												<strong>{candidate.description}</strong>
												<span
													>{money(candidate.amountCents)} · <LocalizedDate
														value={candidate.expenseDate}
													/></span
												>
												<small>
													{t('Exact amount')} · {candidateDateReason(candidate.dateDistanceDays)} ·
													{t('{score}% description overlap', { score: candidate.textScore })}
												</small>
											</div>
											<button class="button primary" type="submit">{t('Match')}</button>
										</form>
									{/each}
								</div>
							{:else}
								<p>{t('No eligible expense found within the date window.')}</p>
							{/if}

							<div class="reconciliation-actions">
								{#if !transaction.isCredit && !transaction.currencyMismatch}
									<form method="post" action="?/createFromBankTransaction" class="inline-form">
										<input type="hidden" name="transactionId" value={transaction.id} />
										<label>
											<span class="sr-only">{t('Category for new expense')}</span>
											<select name="categoryId" required aria-label={t('Category for new expense')}>
												<option value="">{t('Select category')}</option>
												{#each data.categories as category (category.id)}
													<option value={category.id}
														>{category.icon ?? '💼'} {category.name}</option
													>
												{/each}
											</select>
										</label>
										<button class="button secondary" type="submit"
											>{t('Create and reconcile')}</button
										>
									</form>
								{/if}
								<form method="post" action="?/ignoreBankTransaction">
									<input type="hidden" name="transactionId" value={transaction.id} />
									<button class="button secondary" type="submit">{t('Ignore')}</button>
								</form>
							</div>
						</div>
					</article>
				{/each}
			</div>
		</section>
	{/if}

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
					<input type="hidden" name="section" value="imports" />
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
						<td data-label={t('Date')}>
							<LocalizedDateTime value={batch.createdAt} width="compact" />
						</td>
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
