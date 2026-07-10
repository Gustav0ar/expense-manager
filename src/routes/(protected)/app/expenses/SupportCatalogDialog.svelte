<script lang="ts">
	import { enhance } from '$app/forms';
	import { ChevronLeft, ChevronRight, Plus, Save, Search, Trash2 } from '@lucide/svelte';
	import CategoryManagerDialog from './CategoryManagerDialog.svelte';
	import type { Attachment } from 'svelte/attachments';
	import type { SubmitFunction } from '@sveltejs/kit';

	type SupportCatalogKind = 'paymentMethod' | 'vendor' | 'costCenter' | 'category';
	type ExpenseCatalogKind = Exclude<SupportCatalogKind, 'category'>;
	type SupportCatalogItem = {
		id: number;
		name: string;
		expenseCount: number;
		recurringCount: number;
		isArchived: boolean;
	};
	type CategoryItem = {
		id: number;
		name: string;
		color: string;
		icon: string | null;
		isArchived: boolean;
		associationCount: number;
	};
	type Notice = { tone: 'success' | 'danger'; message: string };
	type SupportCatalogActionData = {
		message?: string;
		catalogAction?: 'createCatalog';
		catalogKind?: ExpenseCatalogKind;
		catalogName?: string;
		catalogMessage?: string;
	};
	type Props = {
		catalogs: {
			paymentMethods: SupportCatalogItem[];
			vendors: SupportCatalogItem[];
			costCenters: SupportCatalogItem[];
		};
		categories: CategoryItem[];
		returnTo: string;
		locale: string;
		t: (key: string, params?: Record<string, string | number | null | undefined>) => string;
	};

	let { catalogs, categories, returnTo, locale, t }: Props = $props();

	const pageSize = 8;

	// ── dialog element ───────────────────────────────────────────────────────────
	let dialogEl: HTMLDialogElement | undefined = $state();
	let categoryManager: CategoryManagerDialog | undefined = $state();
	const captureDialog: Attachment<HTMLDialogElement> = (element) => {
		dialogEl = element;
		return () => {
			if (dialogEl === element) dialogEl = undefined;
		};
	};

	// ── tab / search / pagination state ──────────────────────────────────────────
	let activeTab = $state<SupportCatalogKind>('paymentMethod');
	let catalogSearch = $state<Record<ExpenseCatalogKind, string>>({
		paymentMethod: '',
		vendor: '',
		costCenter: ''
	});
	let catalogPage = $state<Record<ExpenseCatalogKind, number>>({
		paymentMethod: 1,
		vendor: 1,
		costCenter: 1
	});
	let catalogNotice = $state<Notice | null>(null);
	let catalogCreating = $state(false);

	// ── public API ───────────────────────────────────────────────────────────────
	export function open() {
		if (!dialogEl?.open) dialogEl?.showModal();
	}

	function close() {
		catalogNotice = null;
		categoryManager?.clearNotice();
		dialogEl?.close();
	}

	function closeFromBackdrop(event: MouseEvent) {
		if (event.target === dialogEl) close();
	}

	// ── tab helpers ──────────────────────────────────────────────────────────────
	const tabs = $derived([
		{
			kind: 'paymentMethod' as ExpenseCatalogKind,
			label: t('Payments'),
			singular: lower(t('Payment')),
			createLabel: t('New payment'),
			placeholder: t('Example payment'),
			maxLength: 80,
			empty: t('No payment method found.')
		},
		{
			kind: 'vendor' as ExpenseCatalogKind,
			label: t('Vendors'),
			singular: lower(t('Vendor')),
			createLabel: t('New vendor'),
			placeholder: t('Example vendor'),
			maxLength: 120,
			empty: t('No vendor found.')
		},
		{
			kind: 'costCenter' as ExpenseCatalogKind,
			label: t('Cost centers'),
			singular: lower(t('Cost center')),
			createLabel: t('New cost center'),
			placeholder: t('Example cost center'),
			maxLength: 120,
			empty: t('No cost center found.')
		}
	]);

	function lower(value: string) {
		return value.toLocaleLowerCase(locale);
	}

	function isExpenseCatalogKind(kind: SupportCatalogKind): kind is ExpenseCatalogKind {
		return kind !== 'category';
	}

	function setActiveTab(kind: SupportCatalogKind) {
		activeTab = kind;
		catalogNotice = null;
		categoryManager?.clearNotice();
	}

	// ── catalog tab derived ───────────────────────────────────────────────────────
	let activeCatalogKind = $derived(
		isExpenseCatalogKind(activeTab) ? activeTab : ('paymentMethod' as ExpenseCatalogKind)
	);
	let activeCatalogMeta = $derived(tabs.find((tab) => tab.kind === activeCatalogKind) ?? tabs[0]);

	function catalogItems(kind: ExpenseCatalogKind): SupportCatalogItem[] {
		if (kind === 'paymentMethod') return catalogs.paymentMethods;
		if (kind === 'vendor') return catalogs.vendors;
		return catalogs.costCenters;
	}

	let activeCatalogItems = $derived(catalogItems(activeCatalogKind));
	let activeCatalogQuery = $derived(
		catalogSearch[activeCatalogKind].trim().toLocaleLowerCase(locale)
	);
	let filteredCatalogItems = $derived.by(() => {
		if (!activeCatalogQuery) return activeCatalogItems;
		return activeCatalogItems.filter((item) =>
			item.name.toLocaleLowerCase(locale).includes(activeCatalogQuery)
		);
	});
	let catalogPageCount = $derived(Math.max(1, Math.ceil(filteredCatalogItems.length / pageSize)));
	let activeCatalogPage = $derived(Math.min(catalogPage[activeCatalogKind], catalogPageCount));
	let paginatedCatalogItems = $derived(
		filteredCatalogItems.slice((activeCatalogPage - 1) * pageSize, activeCatalogPage * pageSize)
	);
	let catalogResultStart = $derived(
		filteredCatalogItems.length === 0 ? 0 : (activeCatalogPage - 1) * pageSize + 1
	);
	let catalogResultEnd = $derived(
		Math.min(filteredCatalogItems.length, activeCatalogPage * pageSize)
	);

	let activeCategoryCount = $derived(categories.filter((category) => !category.isArchived).length);

	// ── count badges ─────────────────────────────────────────────────────────────
	function tabCount(kind: SupportCatalogKind) {
		return kind === 'category' ? activeCategoryCount : catalogItems(kind).length;
	}

	// ── catalog action helpers ────────────────────────────────────────────────────
	function catalogUsageLabel(item: SupportCatalogItem) {
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

	function catalogRemoveLabel(item: SupportCatalogItem) {
		return item.expenseCount > 0 ? t('Archive') : t('Delete');
	}

	// ── action data extractors ────────────────────────────────────────────────────
	function supportCatalogActionData(value: unknown): SupportCatalogActionData | null {
		if (typeof value !== 'object' || value == null) return null;
		const d = value as SupportCatalogActionData;
		return d.catalogAction === 'createCatalog' ? d : null;
	}

	// ── enhance handlers ──────────────────────────────────────────────────────────
	const enhanceCatalogCreate: SubmitFunction = () => {
		catalogCreating = true;
		catalogNotice = null;

		return async ({ result, update }) => {
			catalogCreating = false;

			if (result.type === 'success') {
				const d = supportCatalogActionData(result.data);
				await update({ reset: true, invalidateAll: true });
				if (d?.catalogKind) {
					activeTab = d.catalogKind;
					catalogSearch[d.catalogKind] = '';
					catalogPage[d.catalogKind] = 1;
				}
				catalogNotice = {
					tone: 'success',
					message: d?.catalogMessage ?? t('Catalog item added successfully.')
				};
				return;
			}

			if (result.type === 'failure') {
				const d = supportCatalogActionData(result.data);
				await update({ reset: false, invalidateAll: false });
				catalogNotice = {
					tone: 'danger',
					message: d?.catalogMessage ?? d?.message ?? t('Check auxiliary catalog.')
				};
				return;
			}

			if (result.type === 'error') {
				catalogNotice = { tone: 'danger', message: t('Could not save the catalog.') };
				return;
			}

			await update({ reset: false, invalidateAll: false });
		};
	};
</script>

<dialog
	{@attach captureDialog}
	class="app-dialog support-catalog-dialog"
	aria-labelledby="support-catalog-title"
	onclick={closeFromBackdrop}
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
			<span>{t('{count} payments', { count: catalogs.paymentMethods.length })}</span>
			<span>{t('{count} vendors', { count: catalogs.vendors.length })}</span>
			<span>{t('{count} cost centers', { count: catalogs.costCenters.length })}</span>
			<span>{t('{count} categories', { count: activeCategoryCount })}</span>
		</div>

		<div class="support-catalog-tabs" role="tablist" aria-label={t('Catalog type')}>
			{#each tabs as tab (tab.kind)}
				<button
					class="support-catalog-tab"
					type="button"
					role="tab"
					id={`support-catalog-tab-${tab.kind}`}
					aria-selected={activeTab === tab.kind}
					aria-controls={`support-catalog-panel-${tab.kind}`}
					onclick={() => setActiveTab(tab.kind)}
				>
					<span>{tab.label}</span>
					<strong>{tabCount(tab.kind)}</strong>
				</button>
			{/each}
			<button
				class="support-catalog-tab"
				type="button"
				role="tab"
				id="support-catalog-tab-category"
				aria-selected={activeTab === 'category'}
				aria-controls="support-catalog-panel-category"
				onclick={() => setActiveTab('category')}
			>
				<span>{t('Categories')}</span>
				<strong>{tabCount('category')}</strong>
			</button>
		</div>

		<div
			class="support-catalog-active-panel"
			id={`support-catalog-panel-${activeTab}`}
			role="tabpanel"
			aria-labelledby={`support-catalog-tab-${activeTab}`}
		>
			<div class="support-catalog-category-panel" hidden={activeTab !== 'category'}>
				<CategoryManagerDialog
					bind:this={categoryManager}
					active={activeTab === 'category'}
					{categories}
					{returnTo}
					{locale}
					{t}
				/>
			</div>

			{#if activeTab !== 'category'}
				<!-- ── Catalog (payment / vendor / cost center) tab ──────────────── -->
				<form
					method="post"
					action="?/createCatalog"
					class="support-catalog-form support-catalog-create-form"
					use:enhance={enhanceCatalogCreate}
				>
					<input type="hidden" name="returnTo" value={returnTo} />
					<input type="hidden" name="kind" value={activeCatalogKind} />
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
					<button class="button secondary" type="submit" disabled={catalogCreating}>
						<Plus size={16} />
						<span>{t('Create')}</span>
					</button>
				</form>

				{#if catalogNotice}
					<p
						class={`notice ${catalogNotice.tone}`}
						role={catalogNotice.tone === 'danger' ? 'alert' : 'status'}
					>
						{catalogNotice.message}
					</p>
				{/if}

				<div class="support-catalog-toolbar">
					<label class="support-catalog-search">
						<span>{t('Search {item}', { item: activeCatalogMeta.singular })}</span>
						<div class="input-with-icon">
							<Search size={16} />
							<input
								value={catalogSearch[activeCatalogKind]}
								placeholder={t('Search in {collection}', {
									collection: lower(activeCatalogMeta.label)
								})}
								aria-label={t('Search {item}', { item: activeCatalogMeta.singular })}
								oninput={(event) => {
									catalogSearch[activeCatalogKind] = (
										event.currentTarget as HTMLInputElement
									).value;
									catalogPage[activeCatalogKind] = 1;
								}}
							/>
						</div>
					</label>
					<div class="support-catalog-page-size" aria-label={t('Items per page')}>
						<span>{t('Display')}</span>
						<strong>{t('{pageSize} per page', { pageSize: pageSize })}</strong>
					</div>
				</div>

				<div class="support-catalog-list-heading">
					<strong>{activeCatalogMeta.label}</strong>
					<span>
						{t('{start}-{end} of {total}', {
							start: catalogResultStart,
							end: catalogResultEnd,
							total: filteredCatalogItems.length
						})}
					</span>
				</div>

				<div class="support-catalog-list">
					{#each paginatedCatalogItems as item (item.id)}
						<div class="support-catalog-row">
							<form method="post" action="?/updateCatalog" class="support-catalog-edit-form">
								<input type="hidden" name="returnTo" value={returnTo} />
								<input type="hidden" name="kind" value={activeCatalogKind} />
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
								<input type="hidden" name="returnTo" value={returnTo} />
								<input type="hidden" name="kind" value={activeCatalogKind} />
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

				{#if catalogPageCount > 1}
					<div class="support-catalog-pagination">
						<button
							class="button secondary"
							type="button"
							disabled={activeCatalogPage === 1}
							aria-label={t('Previous page of {items}', {
								items: lower(activeCatalogMeta.label)
							})}
							onclick={() => {
								catalogPage[activeCatalogKind] = Math.min(
									Math.max(catalogPage[activeCatalogKind] - 1, 1),
									catalogPageCount
								);
							}}
						>
							<ChevronLeft size={16} />
							<span>{t('Previous')}</span>
						</button>
						<span>
							{t('Page {page} of {count}', {
								page: activeCatalogPage,
								count: catalogPageCount
							})}
						</span>
						<button
							class="button secondary"
							type="button"
							disabled={activeCatalogPage === catalogPageCount}
							aria-label={t('Next page of {items}', {
								items: lower(activeCatalogMeta.label)
							})}
							onclick={() => {
								catalogPage[activeCatalogKind] = Math.min(
									Math.max(catalogPage[activeCatalogKind] + 1, 1),
									catalogPageCount
								);
							}}
						>
							<span>{t('Next')}</span>
							<ChevronRight size={16} />
						</button>
					</div>
				{/if}
			{/if}
		</div>

		<div class="dialog-actions single">
			<button class="button secondary" type="button" onclick={close}>
				{t('Close')}
			</button>
		</div>
	</div>
</dialog>
