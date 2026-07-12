<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import './expenses.css';
	import LocalizedDate from '$lib/components/LocalizedDate.svelte';
	import SearchableSelect from '$lib/components/SearchableSelect.svelte';
	import { translate } from '$lib/i18n';
	import { formatCents } from '$lib/utils/format';
	import { reviewLabel, reviewClass, paymentLabel, paymentClass } from '$lib/utils/status';
	import ExpenseCreateForm from './ExpenseCreateForm.svelte';
	import ExpenseWorkflowPanel from './ExpenseWorkflowPanel.svelte';
	import AttachmentPanel from './AttachmentPanel.svelte';
	import BulkReviewBar from './BulkReviewBar.svelte';
	import DeleteExpenseDialog from './DeleteExpenseDialog.svelte';
	import SupportCatalogDialog from './SupportCatalogDialog.svelte';
	import { ChevronDown, Paperclip, RotateCcw, Save, Search, Trash2 } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { tick } from 'svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const expensesPath = resolve('/app/expenses');
	const currency = $derived(data.currentWorkspace?.currency ?? 'USD');
	const activeCategories = $derived(
		data.categories.filter((c: PageData['categories'][number]) => !c.isArchived)
	);
	type ManagementData = Pick<PageData, 'categories' | 'catalogs'>;
	let managementData = $state<ManagementData | null>(null);

	let deleteDialog: DeleteExpenseDialog | undefined = $state();
	let supportCatalogDialog: SupportCatalogDialog | undefined = $state();
	let preparedExpenseDetails = $state<number[]>([]);
	let expandedExpenseIds = new SvelteSet<number>();
	let selectedIds = new SvelteSet<number>();

	afterNavigate(({ from, to }) => {
		if (from && to && from.url.href === to.url.href) return;
		selectedIds.clear();
		expandedExpenseIds.clear();
		preparedExpenseDetails = [];
	});

	function toggleSelect(id: number) {
		if (selectedIds.has(id)) selectedIds.delete(id);
		else selectedIds.add(id);
	}

	async function prepareExpenseDetails(id: number, event: Event) {
		const details = event.currentTarget as HTMLDetailsElement;
		if (!details.open) {
			expandedExpenseIds.delete(id);
			return;
		}
		expandedExpenseIds.add(id);
		if (!preparedExpenseDetails.includes(id)) {
			preparedExpenseDetails = [...preparedExpenseDetails, id];
		}
		await tick();
		scrollExpenseActionsIntoView(details);
	}

	function hasPreparedExpenseDetails(id: number) {
		return preparedExpenseDetails.includes(id);
	}

	function scrollExpenseActionsIntoView(details: HTMLDetailsElement) {
		if (typeof window === 'undefined' || !window.matchMedia('(max-width: 640px)').matches) return;
		const target = details.querySelector('.expense-workflow-panel') ?? details;
		const bottomNav = document.querySelector('.sidebar');
		const targetBox = target.getBoundingClientRect();
		const navTop = bottomNav?.getBoundingClientRect().top ?? window.innerHeight;
		const margin = 14;
		const bottomOverlap = targetBox.bottom - (navTop - margin);

		if (bottomOverlap > 0) {
			window.scrollBy({ top: bottomOverlap, behavior: 'smooth' });
			return;
		}

		if (targetBox.top < margin) {
			window.scrollBy({ top: targetBox.top - margin, behavior: 'smooth' });
		}
	}

	function amountInputValue(cents: number) {
		return (cents / 100).toFixed(2).replace('.', ',');
	}

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	function money(cents: number) {
		return formatCents(cents, currency, data.locale);
	}

	function lower(value: string) {
		return value.toLocaleLowerCase(data.locale);
	}

	function hasActiveFilters() {
		return Boolean(
			data.filters.from ||
			data.filters.to ||
			data.filters.categoryId ||
			data.filters.vendorId ||
			data.filters.costCenterId ||
			data.filters.competencyMonth ||
			data.filters.reviewStatus ||
			data.filters.paymentStatus ||
			data.filters.q
		);
	}

	function openDeleteDialog(expense: PageData['expenses']['items'][number]) {
		deleteDialog?.open({
			id: expense.id,
			description: expense.description,
			amount: money(expense.amountCents)
		});
	}

	function openSupportCatalogDialog() {
		void supportCatalogDialog?.open();
	}

	async function loadManagementData() {
		try {
			const response = await fetch(resolve('/app/expenses/management-data'));
			if (!response.ok) return;
			managementData = (await response.json()) as ManagementData;
		} catch {
			// The current active options remain usable if the management refresh fails.
		}
	}

	function hasCatalogOption(items: { id: number }[], id?: number | null) {
		return id ? items.some((item) => item.id === id) : false;
	}

	function catalogOptions(items: { id: number; name: string }[]) {
		return items.map((item) => ({ id: item.id, label: item.name }));
	}

	function catalogOptionsWithCurrent(
		items: { id: number; name: string }[],
		id?: number | null,
		label?: string | null,
		archivedLabel = 'Archived item'
	) {
		const options = catalogOptions(items);
		if (!id || hasCatalogOption(items, id)) return options;
		return [{ id, label: `${label ?? t(archivedLabel)} (${lower(t('Archived'))})` }, ...options];
	}

	function nextPageHref() {
		const params: string[] = [];
		const addParam = (key: string, value: string | number) => {
			params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
		};

		if (data.filters.from) addParam('from', data.filters.from);
		if (data.filters.to) addParam('to', data.filters.to);
		if (data.filters.categoryId) addParam('categoryId', data.filters.categoryId);
		if (data.filters.vendorId) addParam('vendorId', data.filters.vendorId);
		if (data.filters.costCenterId) addParam('costCenterId', data.filters.costCenterId);
		if (data.filters.competencyMonth) {
			addParam('competencyMonth', data.filters.competencyMonth.slice(0, 7));
		}
		if (data.filters.reviewStatus) addParam('reviewStatus', data.filters.reviewStatus);
		if (data.filters.paymentStatus) addParam('paymentStatus', data.filters.paymentStatus);
		if (data.filters.q) addParam('q', data.filters.q);
		if (data.expenses.nextCursor) addParam('cursor', data.expenses.nextCursor);
		const query = params.join('&');
		return query ? `${expensesPath}?${query}` : expensesPath;
	}
</script>

<svelte:head>
	<title>{t('Expenses')} | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">{t('Entries')}</span>
			<h2>{t('Expenses')}</h2>
		</div>
		<a class="button secondary" href={resolve('/app/expenses/trash')}>
			<Trash2 size={16} />
			<span>{t('View trash')}</span>
		</a>
	</div>

	{#if form?.message && !form.catalogAction && !form.categoryAction}
		<p class="notice danger" role="alert">{form.message}</p>
	{/if}

	<ExpenseCreateForm
		{activeCategories}
		catalogs={data.catalogs}
		{form}
		returnTo={data.returnTo}
		locale={data.locale}
		{t}
		onSupportCatalog={openSupportCatalogDialog}
	/>

	<SupportCatalogDialog
		bind:this={supportCatalogDialog}
		catalogs={managementData?.catalogs ?? data.catalogs}
		categories={managementData?.categories ?? data.categories}
		returnTo={data.returnTo}
		locale={data.locale}
		onRefresh={loadManagementData}
		{t}
	/>

	<section class="panel expense-list-panel">
		<div class="expense-list-heading">
			<div>
				<h3>{t('Expenses registered')}</h3>
				<p>
					{t('{shown} of {total} items shown', {
						shown: data.expenses.items.length,
						total: data.expenseSummary.itemCount
					})}
				</p>
			</div>
			<strong>{money(data.expenseSummary.totalCents)}</strong>
		</div>

		<form method="get" class="expense-filter-form">
			<label>
				<span>{t('Start')}</span>
				<input type="date" name="from" value={data.filters.from ?? ''} />
			</label>
			<label>
				<span>{t('End')}</span>
				<input type="date" name="to" value={data.filters.to ?? ''} />
			</label>
			<label>
				<span>{t('Category')}</span>
				<select name="categoryId" aria-label={t('Category')}>
					<option value="">{t('All categories')}</option>
					{#each activeCategories as category (category.id)}
						<option value={category.id} selected={data.filters.categoryId === category.id}
							>{category.icon ?? '💼'} {category.name}</option
						>
					{/each}
				</select>
			</label>
			<SearchableSelect
				id="expense-filter-vendor"
				name="vendorId"
				label={t('Vendor')}
				options={catalogOptions(data.catalogs.vendors)}
				selectedId={data.filters.vendorId}
				placeholder={t('All')}
				empty={t('No vendor found.')}
				locale={data.locale}
			/>
			<SearchableSelect
				id="expense-filter-cost-center"
				name="costCenterId"
				label={t('Cost center')}
				options={catalogOptions(data.catalogs.costCenters)}
				selectedId={data.filters.costCenterId}
				placeholder={t('All')}
				empty={t('No cost center found.')}
				locale={data.locale}
			/>
			<label>
				<span>{t('Competency')}</span>
				<input
					type="month"
					name="competencyMonth"
					value={data.filters.competencyMonth?.slice(0, 7) ?? ''}
				/>
			</label>
			<label>
				<span>{t('Review')}</span>
				<select name="reviewStatus" aria-label={t('Review')}>
					<option value="">{t('All reviews')}</option>
					<option value="pending" selected={data.filters.reviewStatus === 'pending'}>
						{t('Pending')}
					</option>
					<option value="approved" selected={data.filters.reviewStatus === 'approved'}>
						{t('Approved')}
					</option>
					<option value="rejected" selected={data.filters.reviewStatus === 'rejected'}>
						{t('Rejected')}
					</option>
				</select>
			</label>
			<label>
				<span>{t('Payment')}</span>
				<select name="paymentStatus" aria-label={t('Payment')}>
					<option value="">{t('All payments')}</option>
					<option value="unpaid" selected={data.filters.paymentStatus === 'unpaid'}>
						{t('Open')}
					</option>
					<option value="paid" selected={data.filters.paymentStatus === 'paid'}>{t('Paid')}</option>
					<option value="reconciled" selected={data.filters.paymentStatus === 'reconciled'}>
						{t('Reconciled')}
					</option>
				</select>
			</label>
			<label class="filter-search">
				<span>{t('Search')}</span>
				<input name="q" placeholder={t('Search')} value={data.filters.q ?? ''} />
			</label>
			<button class="button secondary filter-button" type="submit">
				<Search size={17} />
				<span>{t('Filter')}</span>
			</button>
			{#if hasActiveFilters()}
				<a class="button secondary filter-button" href={expensesPath}>
					<RotateCcw size={17} />
					<span>{t('Clear')}</span>
				</a>
			{/if}
		</form>

		{#if data.expenses.items.length === 0}
			<p class="empty">{t('No expense found.')}</p>
		{:else}
			<div
				class={['expense-table', data.permissions.canReview && 'with-select']}
				role="treegrid"
				aria-label={t('Expenses registered')}
				aria-colcount={data.permissions.canReview ? 8 : 7}
			>
				<div class="expense-table-header" role="row">
					{#if data.permissions.canReview}
						<span role="columnheader" aria-colindex="1"
							><span class="sr-only">{t('Review')}</span></span
						>
					{/if}
					<span role="columnheader" aria-colindex={data.permissions.canReview ? 2 : 1}
						>{t('Date')}</span
					>
					<span role="columnheader" aria-colindex={data.permissions.canReview ? 3 : 2}
						>{t('Description')}</span
					>
					<span role="columnheader" aria-colindex={data.permissions.canReview ? 4 : 3}
						>{t('Category')}</span
					>
					<span role="columnheader" aria-colindex={data.permissions.canReview ? 5 : 4}
						>{t('Payment')}</span
					>
					<span role="columnheader" aria-colindex={data.permissions.canReview ? 6 : 5}
						>{t('Details')}</span
					>
					<span role="columnheader" aria-colindex={data.permissions.canReview ? 7 : 6}
						>{t('Value')}</span
					>
					<span role="columnheader" aria-colindex={data.permissions.canReview ? 8 : 7}
						>{t('Actions')}</span
					>
				</div>

				{#each data.expenses.items as expense (expense.id)}
					<article
						class={['expense-table-item', expense.reviewStatus === 'pending' && 'pending-review']}
						role="rowgroup"
					>
						<details
							class="expense-table-details"
							role="presentation"
							ontoggle={(event) => prepareExpenseDetails(expense.id, event)}
						>
							<summary
								class="expense-table-row"
								role="row"
								aria-level="1"
								aria-expanded={expandedExpenseIds.has(expense.id)}
							>
								{#if data.permissions.canReview && expense.reviewStatus === 'pending'}
									<span
										class={['expense-select-label', selectedIds.has(expense.id) && 'selected']}
										role="gridcell"
										aria-colindex="1"
										tabindex="-1"
										onclick={(event) => {
											if (event.target instanceof HTMLInputElement) {
												event.stopPropagation();
												return;
											}
											event.preventDefault();
											event.stopPropagation();
											toggleSelect(expense.id);
										}}
										onkeydown={(event) => {
											if (event.target instanceof HTMLInputElement) {
												event.stopPropagation();
												return;
											}
											if (event.key !== ' ' && event.key !== 'Enter') return;
											event.preventDefault();
											event.stopPropagation();
											toggleSelect(expense.id);
										}}
									>
										<input
											type="checkbox"
											class="expense-select-checkbox"
											checked={selectedIds.has(expense.id)}
											onchange={() => toggleSelect(expense.id)}
											aria-label={t('Select {description}', {
												description: expense.description
											})}
										/>
										<span class="expense-select-text">{t('Review')}</span>
									</span>
								{:else if data.permissions.canReview}
									<span class="expense-select-placeholder" role="gridcell" aria-colindex="1">
										<span class="sr-only">{reviewLabel(expense.reviewStatus, t)}</span>
									</span>
								{/if}
								<span
									class="expense-table-date"
									role="gridcell"
									aria-colindex={data.permissions.canReview ? 2 : 1}
								>
									<LocalizedDate value={expense.expenseDate} />
								</span>
								<span
									class="expense-table-description"
									role="gridcell"
									aria-colindex={data.permissions.canReview ? 3 : 2}
								>
									<strong>{expense.description}</strong>
									{#if expense.installmentsTotal}
										<small>{expense.installmentNumber}/{expense.installmentsTotal}</small>
									{/if}
									{#if expense.attachments.length > 0}
										<small class="expense-attachment-count">
											<Paperclip size={12} />
											{expense.attachments.length}
										</small>
									{/if}
									<span class={reviewClass(expense.reviewStatus)}
										>{reviewLabel(expense.reviewStatus, t)}</span
									>
								</span>
								<span
									class="expense-category expense-table-category"
									role="gridcell"
									aria-colindex={data.permissions.canReview ? 4 : 3}
									style={`--category-color:${expense.categoryColor}`}
								>
									<span>{expense.categoryIcon ?? '💼'}</span>
									{expense.categoryName}
								</span>
								<span
									class="expense-table-muted expense-table-payment"
									role="gridcell"
									aria-colindex={data.permissions.canReview ? 5 : 4}
								>
									{expense.paymentMethod || '-'}
									<span class={paymentClass(expense.paymentStatus)}
										>{paymentLabel(expense.paymentStatus, t)}</span
									>
								</span>
								<span
									class="expense-table-muted expense-table-note"
									role="gridcell"
									aria-colindex={data.permissions.canReview ? 6 : 5}
								>
									{expense.vendor || expense.costCenter || expense.notes || '-'}
									{#if expense.vendor && expense.costCenter}
										<small>{expense.costCenter}</small>
									{:else if expense.reviewStatus === 'rejected' && expense.reviewRejectionReason}
										<small>{expense.reviewRejectionReason}</small>
									{/if}
								</span>
								<span
									class="expense-table-amount"
									role="gridcell"
									aria-colindex={data.permissions.canReview ? 7 : 6}
									>{money(expense.amountCents)}</span
								>
								<span
									class="expense-table-action"
									role="gridcell"
									aria-colindex={data.permissions.canReview ? 8 : 7}
								>
									<ChevronDown size={15} />
									{t('Actions')}
									<button
										class="icon-button danger expense-table-delete"
										type="button"
										aria-label={`${t('Delete')} ${expense.description}`}
										onclick={(event) => {
											event.preventDefault();
											event.stopPropagation();
											openDeleteDialog(expense);
										}}
									>
										<Trash2 size={17} />
									</button>
								</span>
							</summary>

							{#if hasPreparedExpenseDetails(expense.id)}
								<div class="expense-details-body" role="row" aria-level="2">
									<div
										class="expense-details-cell"
										role="gridcell"
										aria-colindex="1"
										aria-colspan={data.permissions.canReview ? 8 : 7}
									>
										{#if data.permissions.canReview || data.permissions.canReconcile}
											<ExpenseWorkflowPanel
												{expense}
												canReview={data.permissions.canReview}
												canReconcile={data.permissions.canReconcile}
												returnTo={data.returnTo}
												{t}
											/>
										{/if}
										<form
											method="post"
											action="?/update"
											class="expense-edit-form expense-edit-form-table"
										>
											<input type="hidden" name="id" value={expense.id} />
											<input type="hidden" name="returnTo" value={data.returnTo} />
											<label class="expense-edit-description">
												<span>{t('Description')}</span>
												<input name="description" value={expense.description} required />
											</label>
											<label class="expense-edit-amount">
												<span>{t('Value')}</span>
												<input
													name="amount"
													value={amountInputValue(expense.amountCents)}
													required
												/>
											</label>
											<label class="expense-edit-date">
												<span>{t('Date')}</span>
												<input
													name="expenseDate"
													type="date"
													value={expense.expenseDate}
													required
												/>
											</label>
											<label class="expense-edit-category">
												<span>{t('Category')}</span>
												<select name="categoryId" required>
													{#each activeCategories as category (category.id)}
														<option
															value={category.id}
															selected={category.id === expense.categoryId}
															>{category.icon ?? '💼'} {category.name}</option
														>
													{/each}
												</select>
											</label>
											<label class="expense-edit-payment">
												<span>{t('Payment')}</span>
												<select name="paymentMethodId">
													<option value="">{t('Select')}</option>
													{#if expense.paymentMethodId && !hasCatalogOption(data.catalogs.paymentMethods, expense.paymentMethodId)}
														<option value={expense.paymentMethodId} selected
															>{expense.paymentMethod ?? t('Archived payment method')} ({lower(
																t('Archived')
															)})</option
														>
													{/if}
													{#each data.catalogs.paymentMethods as paymentMethod (paymentMethod.id)}
														<option
															value={paymentMethod.id}
															selected={paymentMethod.id === expense.paymentMethodId}
															>{paymentMethod.name}</option
														>
													{/each}
												</select>
											</label>
											<SearchableSelect
												id={`expense-edit-vendor-${expense.id}`}
												name="vendorId"
												label={t('Vendor')}
												options={catalogOptionsWithCurrent(
													data.catalogs.vendors,
													expense.vendorId,
													expense.vendor,
													'Archived vendor'
												)}
												selectedId={expense.vendorId}
												selectedLabel={expense.vendor}
												placeholder={t('Select')}
												empty={t('No vendor found.')}
												wrapperClass="expense-edit-vendor"
												locale={data.locale}
											/>
											<SearchableSelect
												id={`expense-edit-cost-center-${expense.id}`}
												name="costCenterId"
												label={t('Cost center')}
												options={catalogOptionsWithCurrent(
													data.catalogs.costCenters,
													expense.costCenterId,
													expense.costCenter,
													'Archived cost center'
												)}
												selectedId={expense.costCenterId}
												selectedLabel={expense.costCenter}
												placeholder={t('Select')}
												empty={t('No cost center found.')}
												wrapperClass="expense-edit-cost-center"
												locale={data.locale}
											/>
											<label class="expense-edit-competency">
												<span>{t('Competency')}</span>
												<input
													name="competencyMonth"
													type="month"
													value={expense.competencyMonth?.slice(0, 7) ?? ''}
												/>
											</label>
											<label class="edit-notes">
												<span>{t('Notes')}</span>
												<input name="notes" value={expense.notes ?? ''} />
											</label>
											<button class="button primary" type="submit">
												<Save size={17} />
												<span>{t('Update')}</span>
											</button>
										</form>

										<AttachmentPanel
											expenseId={expense.id}
											attachments={expense.attachments}
											returnTo={data.returnTo}
											{t}
										/>
									</div>
								</div>
							{/if}
						</details>
					</article>
				{/each}
			</div>
		{/if}

		{#if data.expenses.nextCursor}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a class="button secondary" href={nextPageHref()}>{t('Next page')}</a>
		{/if}
	</section>

	<BulkReviewBar {selectedIds} returnTo={data.returnTo} {t} />

	<DeleteExpenseDialog bind:this={deleteDialog} returnTo={data.returnTo} {t} />
</section>
