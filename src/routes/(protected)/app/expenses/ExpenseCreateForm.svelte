<script lang="ts">
	import { Plus } from '@lucide/svelte';
	import SearchableSelect from '$lib/components/SearchableSelect.svelte';
	import type { ActionData, PageData } from './$types';

	type Translate = (
		key: string,
		params?: Record<string, string | number | null | undefined>
	) => string;
	type Catalogs = PageData['catalogs'];
	type Category = PageData['categories'][number];

	let { activeCategories, catalogs, form, returnTo, locale, t, onSupportCatalog } = $props<{
		activeCategories: Category[];
		catalogs: Catalogs;
		form: ActionData;
		returnTo: string;
		locale: PageData['locale'];
		t: Translate;
		onSupportCatalog: () => void;
	}>();

	const amountPlaceholder = $derived(locale === 'pt-BR' ? '0,00' : '0.00');

	function catalogOptions(items: { id: number; name: string }[]) {
		return items.map((item) => ({ id: item.id, label: item.name }));
	}

	function lower(value: string) {
		return value.toLocaleLowerCase(locale);
	}
</script>

<section class="panel expense-create-panel">
	<div class="panel-heading">
		<h3>{t('New expense')}</h3>
		<button
			class="button secondary support-catalog-trigger"
			type="button"
			onclick={onSupportCatalog}
		>
			<Plus size={16} />
			<span>{t('Support catalogs')}</span>
		</button>
	</div>

	<form method="post" action="?/create" class="form-grid expense-create-form">
		<input type="hidden" name="returnTo" value={returnTo} />
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
				{#each activeCategories as category (category.id)}
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
				{#each catalogs.paymentMethods as paymentMethod (paymentMethod.id)}
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
			options={catalogOptions(catalogs.vendors)}
			selectedId={form?.values?.vendorId}
			placeholder={t('Search {item}', { item: lower(t('Vendor')) })}
			empty={t('No vendor found.')}
			wrapperClass="expense-field"
			{locale}
		/>

		<SearchableSelect
			id="expense-create-cost-center"
			name="costCenterId"
			label={t('Cost center')}
			options={catalogOptions(catalogs.costCenters)}
			selectedId={form?.values?.costCenterId}
			placeholder={t('Search {item}', { item: lower(t('Cost center')) })}
			empty={t('No cost center found.')}
			wrapperClass="expense-field"
			{locale}
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
