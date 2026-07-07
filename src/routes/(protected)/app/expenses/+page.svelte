<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { categoryEmojiLabels, categoryEmojiValues } from '$lib/category-emojis';
	import LocalizedDate from '$lib/components/LocalizedDate.svelte';
	import SearchableSelect from '$lib/components/SearchableSelect.svelte';
	import { translate } from '$lib/i18n';
	import { formatCents } from '$lib/utils/format';
	import { reviewLabel, reviewClass, paymentLabel, paymentClass } from '$lib/utils/status';
	import {
		CheckCircle2,
		ChevronLeft,
		ChevronRight,
		CreditCard,
		Paperclip,
		Pencil,
		Plus,
		RotateCcw,
		Search,
		Save,
		Trash2,
		XCircle
	} from '@lucide/svelte';
	import type { Attachment } from 'svelte/attachments';
	import { SvelteSet } from 'svelte/reactivity';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { ActionData, PageData } from './$types';

	type SupportCatalogKind = 'paymentMethod' | 'vendor' | 'costCenter' | 'category';
	type ExpenseCatalogKind = Exclude<SupportCatalogKind, 'category'>;
	type SupportCatalogItem = PageData['catalogs']['paymentMethods'][number];
	type SupportCatalogNotice = { tone: 'success' | 'danger'; message: string };
	type SupportCatalogActionData = {
		message?: string;
		catalogAction?: 'createCatalog';
		catalogKind?: ExpenseCatalogKind;
		catalogName?: string;
		catalogMessage?: string;
	};
	type CategoryActionData = {
		message?: string;
		categoryAction?: 'createCategory';
		categoryMessage?: string;
	};

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const expensesPath = resolve('/app/expenses');
	const supportCatalogPageSize = 8;
	const currency = $derived(data.currentWorkspace?.currency ?? 'USD');
	const supportCatalogTabs = $derived([
		{
			kind: 'paymentMethod',
			label: t('Payments'),
			singular: lower(t('Payment')),
			createLabel: t('New payment'),
			placeholder: t('Example payment'),
			maxLength: 80,
			empty: t('No payment method found.')
		},
		{
			kind: 'vendor',
			label: t('Vendors'),
			singular: lower(t('Vendor')),
			createLabel: t('New vendor'),
			placeholder: t('Example vendor'),
			maxLength: 120,
			empty: t('No vendor found.')
		},
		{
			kind: 'costCenter',
			label: t('Cost centers'),
			singular: lower(t('Cost center')),
			createLabel: t('New cost center'),
			placeholder: t('Example cost center'),
			maxLength: 120,
			empty: t('No cost center found.')
		}
	] satisfies Array<{
		kind: ExpenseCatalogKind;
		label: string;
		singular: string;
		createLabel: string;
		placeholder: string;
		maxLength: number;
		empty: string;
	}>);

	let deleteDialog: HTMLDialogElement | undefined = $state();
	let supportCatalogDialog: HTMLDialogElement | undefined = $state();
	let pendingDelete = $state<{ id: number; description: string; amount: string } | null>(null);
	let preparedExpenseDetails = $state<number[]>([]);
	let supportCatalogTab = $state<SupportCatalogKind>('paymentMethod');
	let supportCatalogSearch = $state<Record<ExpenseCatalogKind, string>>({
		paymentMethod: '',
		vendor: '',
		costCenter: ''
	});
	let supportCatalogNotice = $state<SupportCatalogNotice | null>(null);
	let supportCatalogCreating = $state(false);
	let supportCatalogPage = $state<Record<ExpenseCatalogKind, number>>({
		paymentMethod: 1,
		vendor: 1,
		costCenter: 1
	});
	let categorySearch = $state('');
	let categoryPage = $state(1);
	let categoryNotice = $state<SupportCatalogNotice | null>(null);
	let categoryCreating = $state(false);
	let selectedIds = new SvelteSet<number>();

	function toggleSelect(id: number) {
		if (selectedIds.has(id)) selectedIds.delete(id);
		else selectedIds.add(id);
	}

	function clearSelection() {
		selectedIds.clear();
	}
	let activeExpenseCatalogTab = $derived(
		isExpenseCatalogKind(supportCatalogTab) ? supportCatalogTab : 'paymentMethod'
	);
	let activeCatalogMeta = $derived(
		supportCatalogTabs.find((tab) => tab.kind === activeExpenseCatalogTab) ?? supportCatalogTabs[0]
	);
	let activeCatalogItems = $derived(catalogItems(activeExpenseCatalogTab));
	let activeCatalogQuery = $derived(
		supportCatalogSearch[activeExpenseCatalogTab].trim().toLocaleLowerCase(data.locale)
	);
	let filteredSupportCatalogItems = $derived.by(() => {
		if (!activeCatalogQuery) return activeCatalogItems;
		return activeCatalogItems.filter((item) =>
			item.name.toLocaleLowerCase(data.locale).includes(activeCatalogQuery)
		);
	});
	let supportCatalogPageCount = $derived(
		Math.max(1, Math.ceil(filteredSupportCatalogItems.length / supportCatalogPageSize))
	);
	let activeSupportCatalogPage = $derived(
		Math.min(supportCatalogPage[activeExpenseCatalogTab], supportCatalogPageCount)
	);
	let paginatedSupportCatalogItems = $derived(
		filteredSupportCatalogItems.slice(
			(activeSupportCatalogPage - 1) * supportCatalogPageSize,
			activeSupportCatalogPage * supportCatalogPageSize
		)
	);
	let supportCatalogResultStart = $derived(
		filteredSupportCatalogItems.length === 0
			? 0
			: (activeSupportCatalogPage - 1) * supportCatalogPageSize + 1
	);
	let supportCatalogResultEnd = $derived(
		Math.min(filteredSupportCatalogItems.length, activeSupportCatalogPage * supportCatalogPageSize)
	);
	let activeCategoryCount = $derived(data.categories.filter(isActiveCategory).length);
	let categoryQuery = $derived(categorySearch.trim().toLocaleLowerCase(data.locale));
	let filteredCategories = $derived.by(() => {
		if (!categoryQuery) return data.categories;
		return data.categories.filter((category: PageData['categories'][number]) =>
			category.name.toLocaleLowerCase(data.locale).includes(categoryQuery)
		);
	});
	let categoryPageCount = $derived(
		Math.max(1, Math.ceil(filteredCategories.length / supportCatalogPageSize))
	);
	let activeCategoryPage = $derived(Math.min(categoryPage, categoryPageCount));
	let paginatedCategories = $derived(
		filteredCategories.slice(
			(activeCategoryPage - 1) * supportCatalogPageSize,
			activeCategoryPage * supportCatalogPageSize
		)
	);
	let categoryResultStart = $derived(
		filteredCategories.length === 0 ? 0 : (activeCategoryPage - 1) * supportCatalogPageSize + 1
	);
	let categoryResultEnd = $derived(
		Math.min(filteredCategories.length, activeCategoryPage * supportCatalogPageSize)
	);
	const captureDeleteDialog: Attachment<HTMLDialogElement> = (element) => {
		deleteDialog = element;
		return () => {
			if (deleteDialog === element) deleteDialog = undefined;
		};
	};
	const captureSupportCatalogDialog: Attachment<HTMLDialogElement> = (element) => {
		supportCatalogDialog = element;
		return () => {
			if (supportCatalogDialog === element) supportCatalogDialog = undefined;
		};
	};

	function prepareExpenseDetails(id: number, event: Event) {
		const details = event.currentTarget as HTMLDetailsElement;
		if (!details.open || preparedExpenseDetails.includes(id)) return;
		preparedExpenseDetails = [...preparedExpenseDetails, id];
	}

	function hasPreparedExpenseDetails(id: number) {
		return preparedExpenseDetails.includes(id);
	}

	function amountInputValue(cents: number) {
		return (cents / 100).toFixed(2).replace('.', ',');
	}

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	const amountPlaceholder = $derived(data.locale === 'pt-BR' ? '0,00' : '0.00');

	function money(cents: number) {
		return formatCents(cents, currency, data.locale);
	}

	function lower(value: string) {
		return value.toLocaleLowerCase(data.locale);
	}

	function isActiveCategory(category: PageData['categories'][number]) {
		return !category.isArchived;
	}

	function isExpenseCatalogKind(kind: SupportCatalogKind): kind is ExpenseCatalogKind {
		return kind !== 'category';
	}

	function emojiLabel(emoji: (typeof categoryEmojiValues)[number]) {
		return t(categoryEmojiLabels[emoji]);
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
		pendingDelete = {
			id: expense.id,
			description: expense.description,
			amount: money(expense.amountCents)
		};

		if (!deleteDialog?.open) deleteDialog?.showModal();
	}

	function closeDeleteDialog() {
		deleteDialog?.close();
	}

	function openSupportCatalogDialog() {
		if (!supportCatalogDialog?.open) supportCatalogDialog?.showModal();
	}

	function closeSupportCatalogDialog() {
		supportCatalogNotice = null;
		categoryNotice = null;
		supportCatalogDialog?.close();
	}

	function clearDeleteDialog() {
		pendingDelete = null;
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

	function closeDeleteDialogFromBackdrop(event: MouseEvent) {
		if (event.target === deleteDialog) closeDeleteDialog();
	}

	function closeSupportCatalogDialogFromBackdrop(event: MouseEvent) {
		if (event.target === supportCatalogDialog) closeSupportCatalogDialog();
	}

	function catalogUsageLabel(item: PageData['catalogs']['paymentMethods'][number]) {
		const expensePart =
			item.expenseCount === 1
				? t('{count} expense', { count: item.expenseCount })
				: t('{count} expenses', { count: item.expenseCount });
		if (item.recurringCount === 0) return item.expenseCount === 0 ? t('No usage') : expensePart;

		const recurringPart =
			item.recurringCount === 1
				? t('{count} recurrence', { count: item.recurringCount })
				: t('{count} recurrences', { count: item.recurringCount });
		return item.expenseCount === 0 ? recurringPart : `${expensePart} + ${recurringPart}`;
	}

	function catalogRemoveLabel(item: PageData['catalogs']['paymentMethods'][number]) {
		return item.expenseCount > 0 ? t('Archive') : t('Delete');
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

	function catalogItems(kind: ExpenseCatalogKind): SupportCatalogItem[] {
		if (kind === 'paymentMethod') return data.catalogs.paymentMethods;
		if (kind === 'vendor') return data.catalogs.vendors;
		return data.catalogs.costCenters;
	}

	function supportCatalogCount(kind: SupportCatalogKind) {
		return kind === 'category' ? activeCategoryCount : catalogItems(kind).length;
	}

	function setSupportCatalogTab(kind: SupportCatalogKind) {
		supportCatalogTab = kind;
		supportCatalogNotice = null;
		categoryNotice = null;
	}

	function updateSupportCatalogSearch(kind: ExpenseCatalogKind, value: string) {
		supportCatalogSearch[kind] = value;
		supportCatalogPage[kind] = 1;
	}

	function goToSupportCatalogPage(page: number) {
		supportCatalogPage[activeExpenseCatalogTab] = Math.min(
			Math.max(page, 1),
			supportCatalogPageCount
		);
	}

	function updateCategorySearch(value: string) {
		categorySearch = value;
		categoryPage = 1;
	}

	function goToCategoryPage(page: number) {
		categoryPage = Math.min(Math.max(page, 1), categoryPageCount);
	}

	function supportCatalogActionData(value: unknown): SupportCatalogActionData | null {
		if (typeof value !== 'object' || value == null) return null;
		const data = value as SupportCatalogActionData;
		return data.catalogAction === 'createCatalog' ? data : null;
	}

	function categoryActionData(value: unknown): CategoryActionData | null {
		if (typeof value !== 'object' || value == null) return null;
		const data = value as CategoryActionData;
		return data.categoryAction === 'createCategory' ? data : null;
	}

	const enhanceSupportCatalogCreate: SubmitFunction = () => {
		supportCatalogCreating = true;
		supportCatalogNotice = null;

		return async ({ result, update }) => {
			supportCatalogCreating = false;

			if (result.type === 'success') {
				const catalogData = supportCatalogActionData(result.data);
				await update({ reset: true, invalidateAll: true });

				if (catalogData?.catalogKind) {
					supportCatalogTab = catalogData.catalogKind;
					supportCatalogSearch[catalogData.catalogKind] = '';
					supportCatalogPage[catalogData.catalogKind] = 1;
				}

				supportCatalogNotice = {
					tone: 'success',
					message: catalogData?.catalogMessage ?? t('Catalog item added successfully.')
				};
				return;
			}

			if (result.type === 'failure') {
				const catalogData = supportCatalogActionData(result.data);
				await update({ reset: false, invalidateAll: false });
				supportCatalogNotice = {
					tone: 'danger',
					message:
						catalogData?.catalogMessage ?? catalogData?.message ?? t('Check auxiliary catalog.')
				};
				return;
			}

			if (result.type === 'error') {
				supportCatalogNotice = { tone: 'danger', message: t('Could not save the catalog.') };
				return;
			}

			await update({ reset: false, invalidateAll: false });
		};
	};

	const enhanceCategoryCreate: SubmitFunction = () => {
		categoryCreating = true;
		categoryNotice = null;

		return async ({ result, update }) => {
			categoryCreating = false;

			if (result.type === 'success') {
				const categoryData = categoryActionData(result.data);
				await update({ reset: true, invalidateAll: true });
				categorySearch = '';
				categoryPage = 1;
				categoryNotice = {
					tone: 'success',
					message: categoryData?.categoryMessage ?? t('Category created successfully.')
				};
				return;
			}

			if (result.type === 'failure') {
				const categoryData = categoryActionData(result.data);
				await update({ reset: false, invalidateAll: false });
				categoryNotice = {
					tone: 'danger',
					message:
						categoryData?.categoryMessage ?? categoryData?.message ?? t('Check category data.')
				};
				return;
			}

			if (result.type === 'error') {
				categoryNotice = { tone: 'danger', message: t('Could not save the category.') };
				return;
			}

			await update({ reset: false, invalidateAll: false });
		};
	};
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
	</div>

	{#if form?.message && form.catalogAction !== 'createCatalog' && form.categoryAction !== 'createCategory'}
		<p class="notice danger" role="alert">{form.message}</p>
	{/if}

	<section class="panel expense-create-panel">
		<div class="panel-heading">
			<h3>{t('New expense')}</h3>
			<button
				class="button secondary support-catalog-trigger"
				type="button"
				onclick={openSupportCatalogDialog}
			>
				<Plus size={16} />
				<span>{t('Support catalogs')}</span>
			</button>
		</div>

		<form method="post" action="?/create" class="form-grid expense-create-form">
			<input type="hidden" name="returnTo" value={data.returnTo} />
			<label class="expense-field description-field">
				<span>{t('Description')}</span>
				<input
					name="description"
					required
					maxlength="160"
					value={form?.values?.description ?? ''}
					aria-invalid={!!form?.fieldErrors?.description}
					aria-describedby={form?.fieldErrors?.description ? 'err-description' : undefined}
				/>
				{#if form?.fieldErrors?.description}
					<span id="err-description" class="field-error">{form.fieldErrors.description}</span>
				{/if}
			</label>

			<label class="expense-field amount-field">
				<span>{t('Installment amount')}</span>
				<input
					name="amount"
					inputmode="decimal"
					placeholder={amountPlaceholder}
					required
					value={form?.values?.amount ?? ''}
					aria-invalid={!!form?.fieldErrors?.amount}
					aria-describedby={form?.fieldErrors?.amount ? 'err-amount' : undefined}
				/>
				{#if form?.fieldErrors?.amount}
					<span id="err-amount" class="field-error">{form.fieldErrors.amount}</span>
				{/if}
			</label>

			<label class="expense-field">
				<span>{t('Date')}</span>
				<input
					name="expenseDate"
					type="date"
					required
					value={form?.values?.expenseDate ?? ''}
					aria-invalid={!!form?.fieldErrors?.expenseDate}
					aria-describedby={form?.fieldErrors?.expenseDate ? 'err-expenseDate' : undefined}
				/>
				{#if form?.fieldErrors?.expenseDate}
					<span id="err-expenseDate" class="field-error">{form.fieldErrors.expenseDate}</span>
				{/if}
			</label>

			<label class="expense-field">
				<span>{t('Category')}</span>
				<select
					name="categoryId"
					required
					aria-invalid={!!form?.fieldErrors?.categoryId}
					aria-describedby={form?.fieldErrors?.categoryId ? 'err-categoryId' : undefined}
				>
					<option value="">{t('Select')}</option>
					{#each data.categories as category (category.id)}
						<option
							value={category.id}
							selected={category.id.toString() === (form?.values?.categoryId ?? '')}
							>{category.icon ?? '💼'} {category.name}</option
						>
					{/each}
				</select>
				{#if form?.fieldErrors?.categoryId}
					<span id="err-categoryId" class="field-error">{form.fieldErrors.categoryId}</span>
				{/if}
			</label>

			<label class="expense-field">
				<span>{t('Payment')}</span>
				<select name="paymentMethodId">
					<option value="">{t('Select')}</option>
					{#each data.catalogs.paymentMethods as paymentMethod (paymentMethod.id)}
						<option
							value={paymentMethod.id}
							selected={paymentMethod.id.toString() === (form?.values?.paymentMethodId ?? '')}
							>{paymentMethod.name}</option
						>
					{/each}
				</select>
			</label>

			<SearchableSelect
				id="expense-create-vendor"
				name="vendorId"
				label={t('Vendor')}
				options={catalogOptions(data.catalogs.vendors)}
				selectedId={form?.values?.vendorId}
				placeholder={t('Search {item}', { item: lower(t('Vendor')) })}
				empty={t('No vendor found.')}
				wrapperClass="expense-field"
				locale={data.locale}
			/>

			<SearchableSelect
				id="expense-create-cost-center"
				name="costCenterId"
				label={t('Cost center')}
				options={catalogOptions(data.catalogs.costCenters)}
				selectedId={form?.values?.costCenterId}
				placeholder={t('Search {item}', { item: lower(t('Cost center')) })}
				empty={t('No cost center found.')}
				wrapperClass="expense-field"
				locale={data.locale}
			/>

			<label class="expense-field">
				<span>{t('Competency')}</span>
				<input name="competencyMonth" type="month" value={form?.values?.competencyMonth ?? ''} />
			</label>

			<label class="expense-field">
				<span>{t('Installments')}</span>
				<input
					name="installments"
					type="number"
					min="1"
					max="120"
					value={form?.values?.installments ?? '1'}
				/>
			</label>

			<label class="expense-field notes-field">
				<span>{t('Notes')}</span>
				<input name="notes" maxlength="1000" value={form?.values?.notes ?? ''} />
			</label>

			<button class="button primary expense-submit" type="submit">
				<Plus size={18} />
				<span>{t('Add')}</span>
			</button>
		</form>
	</section>

	<dialog
		{@attach captureSupportCatalogDialog}
		class="app-dialog support-catalog-dialog"
		aria-labelledby="support-catalog-title"
		onclick={closeSupportCatalogDialogFromBackdrop}
	>
		<div class="dialog-card support-catalog-card">
			<div class="dialog-heading">
				<span class="dialog-icon">
					<Plus size={20} />
				</span>
				<div>
					<h3 id="support-catalog-title">{t('Support catalogs')}</h3>
					<p>{t('Add options for payment, vendor, cost center and category.')}</p>
				</div>
			</div>

			<div class="support-catalog-summary" aria-label={t('Totals registered')}>
				<span>{t('{count} payments', { count: data.catalogs.paymentMethods.length })}</span>
				<span>{t('{count} vendors', { count: data.catalogs.vendors.length })}</span>
				<span>{t('{count} cost centers', { count: data.catalogs.costCenters.length })}</span>
				<span>{t('{count} categories', { count: activeCategoryCount })}</span>
			</div>

			<div class="support-catalog-tabs" role="tablist" aria-label={t('Catalog type')}>
				{#each supportCatalogTabs as tab (tab.kind)}
					<button
						class="support-catalog-tab"
						type="button"
						role="tab"
						id={`support-catalog-tab-${tab.kind}`}
						aria-selected={supportCatalogTab === tab.kind}
						aria-controls={`support-catalog-panel-${tab.kind}`}
						onclick={() => setSupportCatalogTab(tab.kind)}
					>
						<span>{tab.label}</span>
						<strong>{supportCatalogCount(tab.kind)}</strong>
					</button>
				{/each}
				<button
					class="support-catalog-tab"
					type="button"
					role="tab"
					id="support-catalog-tab-category"
					aria-selected={supportCatalogTab === 'category'}
					aria-controls="support-catalog-panel-category"
					onclick={() => setSupportCatalogTab('category')}
				>
					<span>{t('Categories')}</span>
					<strong>{supportCatalogCount('category')}</strong>
				</button>
			</div>

			<div
				class="support-catalog-active-panel"
				id={`support-catalog-panel-${supportCatalogTab}`}
				role="tabpanel"
				aria-labelledby={`support-catalog-tab-${supportCatalogTab}`}
			>
				{#if supportCatalogTab === 'category'}
					<form
						method="post"
						action="?/createCategory"
						class="support-catalog-form support-catalog-create-form support-catalog-category-form"
						use:enhance={enhanceCategoryCreate}
					>
						<input type="hidden" name="returnTo" value={data.returnTo} />
						<label>
							<span>{t('Color')}</span>
							<input
								class="color-picker compact"
								name="color"
								type="color"
								value="#2563eb"
								aria-label={t('Color')}
								required
							/>
						</label>
						<label>
							<span>{t('New category')}</span>
							<input
								name="name"
								required
								minlength="2"
								maxlength="80"
								placeholder={t('New category')}
							/>
						</label>
						<label>
							<span>{t('Emoji')}</span>
							<select name="icon" aria-label={t('Emoji')} required>
								{#each categoryEmojiValues as emoji (emoji)}
									<option value={emoji}>{emoji} {emojiLabel(emoji)}</option>
								{/each}
							</select>
						</label>
						<button class="button secondary" type="submit" disabled={categoryCreating}>
							<Plus size={16} />
							<span>{t('Create')}</span>
						</button>
					</form>

					{#if categoryNotice}
						<p
							class={`notice ${categoryNotice.tone}`}
							role={categoryNotice.tone === 'danger' ? 'alert' : 'status'}
						>
							{categoryNotice.message}
						</p>
					{/if}

					<div class="support-catalog-toolbar">
						<label class="support-catalog-search">
							<span>{t('Search {item}', { item: lower(t('Category')) })}</span>
							<div class="input-with-icon">
								<Search size={16} />
								<input
									value={categorySearch}
									placeholder={t('Search in {collection}', {
										collection: lower(t('Categories'))
									})}
									aria-label={t('Search {item}', { item: lower(t('Category')) })}
									oninput={(event) =>
										updateCategorySearch((event.currentTarget as HTMLInputElement).value)}
								/>
							</div>
						</label>
						<div class="support-catalog-page-size" aria-label={t('Items per page')}>
							<span>{t('Display')}</span>
							<strong>{t('{pageSize} per page', { pageSize: supportCatalogPageSize })}</strong>
						</div>
					</div>

					<div class="support-catalog-list-heading">
						<strong>{t('Categories')}</strong>
						<span>
							{t('{start}-{end} of {total}', {
								start: categoryResultStart,
								end: categoryResultEnd,
								total: filteredCategories.length
							})}
						</span>
					</div>

					<div class="support-catalog-list">
						{#each paginatedCategories as category (category.id)}
							<div class={['support-catalog-row', category.isArchived && 'muted']}>
								<form
									method="post"
									action="?/updateCategory"
									class="support-catalog-edit-form support-catalog-category-edit"
								>
									<input type="hidden" name="returnTo" value={data.returnTo} />
									<input type="hidden" name="id" value={category.id} />
									<label>
										<span>{t('Color')}</span>
										<input
											class="color-picker compact"
											name="color"
											type="color"
											value={category.color}
											aria-label={`${t('Color')} ${category.name}`}
										/>
									</label>
									<label>
										<span>{t('Category name')}</span>
										<input
											name="name"
											value={category.name}
											required
											minlength="2"
											maxlength="80"
											aria-label={`${t('Edit')} ${lower(t('Category'))} ${category.name}`}
										/>
									</label>
									<label>
										<span>{t('Emoji')}</span>
										<select name="icon" aria-label={`${t('Emoji')} ${category.name}`}>
											{#each categoryEmojiValues as emoji (emoji)}
												<option value={emoji} selected={(category.icon ?? '💼') === emoji}
													>{emoji} {emojiLabel(emoji)}</option
												>
											{/each}
										</select>
									</label>
									<button class="button secondary" type="submit">
										<Save size={15} />
										<span>{t('Save')}</span>
									</button>
								</form>
								{#if !category.isArchived}
									<form
										method="post"
										action="?/archiveCategory"
										class="support-catalog-remove-form"
									>
										<input type="hidden" name="returnTo" value={data.returnTo} />
										<input type="hidden" name="id" value={category.id} />
										<button
											class="text-button danger"
											type="submit"
											aria-label={`${t('Archive category')} ${category.name}`}
										>
											<Trash2 size={15} />
											<span>{t('Archive')}</span>
										</button>
									</form>
								{/if}
							</div>
						{:else}
							<p class="support-catalog-empty">
								{categoryQuery ? t('No search results.') : t('No category found.')}
							</p>
						{/each}
					</div>

					{#if categoryPageCount > 1}
						<div class="support-catalog-pagination">
							<button
								class="button secondary"
								type="button"
								disabled={activeCategoryPage === 1}
								aria-label={t('Previous page of {items}', {
									items: lower(t('Categories'))
								})}
								onclick={() => goToCategoryPage(activeCategoryPage - 1)}
							>
								<ChevronLeft size={16} />
								<span>{t('Previous')}</span>
							</button>
							<span>
								{t('Page {page} of {count}', {
									page: activeCategoryPage,
									count: categoryPageCount
								})}
							</span>
							<button
								class="button secondary"
								type="button"
								disabled={activeCategoryPage === categoryPageCount}
								aria-label={t('Next page of {items}', {
									items: lower(t('Categories'))
								})}
								onclick={() => goToCategoryPage(activeCategoryPage + 1)}
							>
								<span>{t('Next')}</span>
								<ChevronRight size={16} />
							</button>
						</div>
					{/if}
				{:else}
					<form
						method="post"
						action="?/createCatalog"
						class="support-catalog-form support-catalog-create-form"
						use:enhance={enhanceSupportCatalogCreate}
					>
						<input type="hidden" name="returnTo" value={data.returnTo} />
						<input type="hidden" name="kind" value={activeExpenseCatalogTab} />
						<label>
							<span>{activeCatalogMeta.createLabel}</span>
							<input
								name="name"
								required
								minlength="2"
								maxlength={activeCatalogMeta.maxLength}
								placeholder={activeCatalogMeta.placeholder}
							/>
						</label>
						<button class="button secondary" type="submit" disabled={supportCatalogCreating}>
							<Plus size={16} />
							<span>{t('Create')}</span>
						</button>
					</form>

					{#if supportCatalogNotice}
						<p
							class={`notice ${supportCatalogNotice.tone}`}
							role={supportCatalogNotice.tone === 'danger' ? 'alert' : 'status'}
						>
							{supportCatalogNotice.message}
						</p>
					{/if}

					<div class="support-catalog-toolbar">
						<label class="support-catalog-search">
							<span>{t('Search {item}', { item: activeCatalogMeta.singular })}</span>
							<div class="input-with-icon">
								<Search size={16} />
								<input
									value={supportCatalogSearch[activeExpenseCatalogTab]}
									placeholder={t('Search in {collection}', {
										collection: lower(activeCatalogMeta.label)
									})}
									aria-label={t('Search {item}', { item: activeCatalogMeta.singular })}
									oninput={(event) =>
										updateSupportCatalogSearch(
											activeExpenseCatalogTab,
											(event.currentTarget as HTMLInputElement).value
										)}
								/>
							</div>
						</label>
						<div class="support-catalog-page-size" aria-label={t('Items per page')}>
							<span>{t('Display')}</span>
							<strong>{t('{pageSize} per page', { pageSize: supportCatalogPageSize })}</strong>
						</div>
					</div>

					<div class="support-catalog-list-heading">
						<strong>{activeCatalogMeta.label}</strong>
						<span>
							{t('{start}-{end} of {total}', {
								start: supportCatalogResultStart,
								end: supportCatalogResultEnd,
								total: filteredSupportCatalogItems.length
							})}
						</span>
					</div>

					<div class="support-catalog-list">
						{#each paginatedSupportCatalogItems as item (item.id)}
							<div class="support-catalog-row">
								<form method="post" action="?/updateCatalog" class="support-catalog-edit-form">
									<input type="hidden" name="returnTo" value={data.returnTo} />
									<input type="hidden" name="kind" value={activeExpenseCatalogTab} />
									<input type="hidden" name="id" value={item.id} />
									<label>
										<span>{catalogUsageLabel(item)}</span>
										<input
											name="name"
											value={item.name}
											required
											minlength="2"
											maxlength={activeCatalogMeta.maxLength}
											aria-label={`${t('Edit')} ${activeCatalogMeta.singular} ${item.name}`}
										/>
									</label>
									<button class="button secondary" type="submit">
										<Save size={15} />
										<span>{t('Save')}</span>
									</button>
								</form>
								<form method="post" action="?/removeCatalog" class="support-catalog-remove-form">
									<input type="hidden" name="returnTo" value={data.returnTo} />
									<input type="hidden" name="kind" value={activeExpenseCatalogTab} />
									<input type="hidden" name="id" value={item.id} />
									<button
										class="button secondary danger"
										type="submit"
										aria-label={`${catalogRemoveLabel(item)} ${activeCatalogMeta.singular} ${item.name}`}
									>
										<Trash2 size={15} />
										<span>{catalogRemoveLabel(item)}</span>
									</button>
								</form>
							</div>
						{:else}
							<p class="support-catalog-empty">
								{activeCatalogQuery ? t('No search results.') : activeCatalogMeta.empty}
							</p>
						{/each}
					</div>

					{#if supportCatalogPageCount > 1}
						<div class="support-catalog-pagination">
							<button
								class="button secondary"
								type="button"
								disabled={activeSupportCatalogPage === 1}
								aria-label={t('Previous page of {items}', {
									items: lower(activeCatalogMeta.label)
								})}
								onclick={() => goToSupportCatalogPage(activeSupportCatalogPage - 1)}
							>
								<ChevronLeft size={16} />
								<span>{t('Previous')}</span>
							</button>
							<span>
								{t('Page {page} of {count}', {
									page: activeSupportCatalogPage,
									count: supportCatalogPageCount
								})}
							</span>
							<button
								class="button secondary"
								type="button"
								disabled={activeSupportCatalogPage === supportCatalogPageCount}
								aria-label={t('Next page of {items}', {
									items: lower(activeCatalogMeta.label)
								})}
								onclick={() => goToSupportCatalogPage(activeSupportCatalogPage + 1)}
							>
								<span>{t('Next')}</span>
								<ChevronRight size={16} />
							</button>
						</div>
					{/if}
				{/if}
			</div>

			<div class="dialog-actions single">
				<button class="button secondary" type="button" onclick={closeSupportCatalogDialog}>
					{t('Close')}
				</button>
			</div>
		</div>
	</dialog>

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
					{#each data.categories as category (category.id)}
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
			<div class="expense-table" aria-label={t('Expenses registered')}>
				<div class="expense-table-header" aria-hidden="true">
					{#if data.permissions.canReview}<span></span>{/if}
					<span>{t('Date')}</span>
					<span>{t('Description')}</span>
					<span>{t('Category')}</span>
					<span>{t('Payment')}</span>
					<span>{t('Notes')}</span>
					<span>{t('Value')}</span>
					<span>{t('Actions')}</span>
				</div>

				{#each data.expenses.items as expense (expense.id)}
					<article class="expense-table-item">
						{#if data.permissions.canReview && expense.reviewStatus === 'pending'}
							<label
								class="expense-select-label"
								aria-label={t('Select {description}', { description: expense.description })}
							>
								<input
									type="checkbox"
									class="expense-select-checkbox"
									checked={selectedIds.has(expense.id)}
									onchange={() => toggleSelect(expense.id)}
								/>
							</label>
						{:else if data.permissions.canReview}
							<span class="expense-select-placeholder"></span>
						{/if}
						<details
							class="expense-table-details"
							ontoggle={(event) => prepareExpenseDetails(expense.id, event)}
						>
							<summary class="expense-table-row">
								<span class="expense-table-date">
									<LocalizedDate value={expense.expenseDate} />
								</span>
								<span class="expense-table-description">
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
									style={`--category-color:${expense.categoryColor}`}
								>
									<span>{expense.categoryIcon ?? '💼'}</span>
									{expense.categoryName}
								</span>
								<span class="expense-table-muted expense-table-payment">
									{expense.paymentMethod || '-'}
									<span class={paymentClass(expense.paymentStatus)}
										>{paymentLabel(expense.paymentStatus, t)}</span
									>
								</span>
								<span class="expense-table-muted expense-table-note">
									{expense.vendor || expense.costCenter || expense.notes || '-'}
									{#if expense.vendor && expense.costCenter}
										<small>{expense.costCenter}</small>
									{:else if expense.reviewStatus === 'rejected' && expense.reviewRejectionReason}
										<small>{expense.reviewRejectionReason}</small>
									{/if}
								</span>
								<span class="expense-table-amount">{money(expense.amountCents)}</span>
								<span class="expense-table-action">
									<Pencil size={15} />
									{t('Edit')}
								</span>
							</summary>

							{#if hasPreparedExpenseDetails(expense.id)}
								<form
									method="post"
									action="?/update"
									class="expense-edit-form expense-edit-form-table"
								>
									<input type="hidden" name="id" value={expense.id} />
									<input type="hidden" name="returnTo" value={data.returnTo} />
									<label>
										<span>{t('Description')}</span>
										<input name="description" value={expense.description} required />
									</label>
									<label>
										<span>{t('Value')}</span>
										<input name="amount" value={amountInputValue(expense.amountCents)} required />
									</label>
									<label>
										<span>{t('Date')}</span>
										<input name="expenseDate" type="date" value={expense.expenseDate} required />
									</label>
									<label>
										<span>{t('Category')}</span>
										<select name="categoryId" required>
											{#each data.categories as category (category.id)}
												<option value={category.id} selected={category.id === expense.categoryId}
													>{category.icon ?? '💼'} {category.name}</option
												>
											{/each}
										</select>
									</label>
									<label>
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
										locale={data.locale}
									/>
									<label>
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

								{#if data.permissions.canReview || data.permissions.canReconcile}
									<div class="expense-workflow-panel">
										<div class="workflow-summary">
											<span class={reviewClass(expense.reviewStatus)}>
												{reviewLabel(expense.reviewStatus, t)}
											</span>
											<span class={paymentClass(expense.paymentStatus)}>
												{paymentLabel(expense.paymentStatus, t)}
											</span>
										</div>
										{#if data.permissions.canReview}
											<form method="post" action="?/review" class="workflow-form">
												<input type="hidden" name="id" value={expense.id} />
												<input type="hidden" name="returnTo" value={data.returnTo} />
												<input type="hidden" name="reviewStatus" value="approved" />
												<button
													class="button secondary"
													type="submit"
													disabled={expense.reviewStatus === 'approved'}
												>
													<CheckCircle2 size={16} />
													<span>{t('Approve')}</span>
												</button>
											</form>
											<form method="post" action="?/review" class="workflow-form reject-form">
												<input type="hidden" name="id" value={expense.id} />
												<input type="hidden" name="returnTo" value={data.returnTo} />
												<input type="hidden" name="reviewStatus" value="rejected" />
												<input
													name="reason"
													aria-label={t('Rejection reason')}
													placeholder={t('Reason')}
													maxlength="500"
													required
												/>
												<button
													class="button secondary danger"
													type="submit"
													disabled={expense.reviewStatus === 'rejected'}
												>
													<XCircle size={16} />
													<span>{t('Reject')}</span>
												</button>
											</form>
										{/if}

										{#if data.permissions.canReconcile && expense.reviewStatus === 'approved'}
											<form method="post" action="?/payment" class="workflow-form">
												<input type="hidden" name="id" value={expense.id} />
												<input type="hidden" name="returnTo" value={data.returnTo} />
												<select name="paymentStatus" aria-label={t('Payment status')}>
													<option value="unpaid" selected={expense.paymentStatus === 'unpaid'}
														>{t('Open')}</option
													>
													<option value="paid" selected={expense.paymentStatus === 'paid'}
														>{t('Paid')}</option
													>
													<option
														value="reconciled"
														selected={expense.paymentStatus === 'reconciled'}
														>{t('Reconciled')}</option
													>
												</select>
												<input
													name="paidAt"
													type="date"
													value={expense.paidAt ?? ''}
													aria-label={t('Payment date')}
												/>
												<button class="button secondary" type="submit">
													<CreditCard size={16} />
													<span>{t('Save payment')}</span>
												</button>
											</form>
										{/if}
									</div>
								{/if}

								<div class="attachment-panel">
									<div class="attachment-list">
										{#each expense.attachments as attachment (attachment.id)}
											<div class="attachment-chip-row">
												<a
													class="attachment-chip"
													href={resolve(`/app/expenses/attachments/${attachment.id}`)}
												>
													<Paperclip size={15} />
													<span>{attachment.originalName}</span>
												</a>
												<form
													method="post"
													action="?/deleteAttachment"
													onsubmit={(e) => {
														if (!window.confirm(t('Delete attachment?'))) e.preventDefault();
													}}
												>
													<input type="hidden" name="id" value={attachment.id} />
													<input type="hidden" name="returnTo" value={data.returnTo} />
													<button
														class="icon-button danger"
														type="submit"
														aria-label={`${t('Delete')} ${attachment.originalName}`}
													>
														<Trash2 size={14} />
													</button>
												</form>
											</div>
										{:else}
											<span class="empty">{t('No attachments added.')}</span>
										{/each}
									</div>
									<form
										method="post"
										action="?/attach"
										enctype="multipart/form-data"
										class="attachment-form"
									>
										<input type="hidden" name="id" value={expense.id} />
										<input type="hidden" name="returnTo" value={data.returnTo} />
										<input
											name="attachment"
											type="file"
											accept="application/pdf,image/png,image/jpeg,image/webp,text/plain"
											aria-label={t('Receipt')}
										/>
										<button class="button secondary" type="submit">
											<Paperclip size={16} />
											<span>{t('Attach')}</span>
										</button>
									</form>
								</div>
							{/if}
						</details>

						<button
							class="icon-button danger expense-table-delete"
							type="button"
							aria-label={`${t('Delete')} ${expense.description}`}
							onclick={() => openDeleteDialog(expense)}
						>
							<Trash2 size={17} />
						</button>
					</article>
				{/each}
			</div>
		{/if}

		{#if data.expenses.nextCursor}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a class="button secondary" href={nextPageHref()}>{t('Next page')}</a>
		{/if}
	</section>

	{#if selectedIds.size > 0}
		<div class="bulk-action-bar" role="region" aria-label={t('Bulk actions')}>
			<span class="bulk-action-count">{t('{count} selected', { count: selectedIds.size })}</span>
			<form method="post" action="?/bulkReview" class="bulk-action-form">
				<input type="hidden" name="returnTo" value={data.returnTo} />
				<input type="hidden" name="decision" value="approved" />
				{#each [...selectedIds] as id (id)}
					<input type="hidden" name="id" value={id} />
				{/each}
				<button class="button secondary" type="submit">
					<CheckCircle2 size={16} />
					<span>{t('Approve')}</span>
				</button>
			</form>
			<form method="post" action="?/bulkReview" class="bulk-action-form">
				<input type="hidden" name="returnTo" value={data.returnTo} />
				<input type="hidden" name="decision" value="rejected" />
				{#each [...selectedIds] as id (id)}
					<input type="hidden" name="id" value={id} />
				{/each}
				<button class="button secondary danger" type="submit">
					<XCircle size={16} />
					<span>{t('Reject')}</span>
				</button>
			</form>
			<button class="button secondary" type="button" onclick={clearSelection}>
				{t('Clear')}
			</button>
		</div>
	{/if}

	<dialog
		{@attach captureDeleteDialog}
		class="app-dialog"
		aria-labelledby="delete-expense-title"
		onclick={closeDeleteDialogFromBackdrop}
		onclose={clearDeleteDialog}
	>
		{#if pendingDelete}
			<div class="dialog-card">
				<div class="dialog-heading">
					<span class="dialog-icon danger">
						<Trash2 size={20} />
					</span>
					<div>
						<h3 id="delete-expense-title">{t('Delete expense?')}</h3>
						<p>
							{pendingDelete.description}
							<span>{pendingDelete.amount}</span>
						</p>
					</div>
				</div>

				<p class="dialog-muted">
					{t('This action removes the entry and updates dashboards and reports.')}
				</p>

				<form method="post" action="?/delete" class="dialog-actions">
					<input type="hidden" name="id" value={pendingDelete.id} />
					<input type="hidden" name="returnTo" value={data.returnTo} />
					<button class="button secondary" type="button" onclick={closeDeleteDialog}
						>{t('Cancel')}</button
					>
					<button class="button danger" type="submit">
						<Trash2 size={17} />
						<span>{t('Delete')}</span>
					</button>
				</form>
			</div>
		{/if}
	</dialog>
</section>
