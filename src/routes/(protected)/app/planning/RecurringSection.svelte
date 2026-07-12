<script lang="ts">
	import { Pause, Play, RefreshCw } from '@lucide/svelte';
	import LocalizedDate from '$lib/components/LocalizedDate.svelte';
	import { translate } from '$lib/i18n';
	import { formatCents } from '$lib/utils/format';
	import type { PageData } from './$types';

	let { data } = $props<{ data: PageData }>();
	const currency = $derived(data.currentWorkspace?.currency ?? 'USD');
	const amountPlaceholder = $derived(data.locale === 'pt-BR' ? '0,00' : '0.00');

	function frequencyLabel(value: string, interval: number) {
		const unit = value === 'weekly' ? t('week') : value === 'yearly' ? t('year') : t('month');
		const unitPlural =
			value === 'weekly' ? t('weeks') : value === 'yearly' ? t('years') : t('months');
		return interval === 1
			? t('Every {unit}', { unit })
			: t('Every {interval} {unitPlural}', { interval, unitPlural });
	}

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	function money(cents: number) {
		return formatCents(cents, currency, data.locale);
	}
</script>

<section class="panel">
	<div class="panel-heading">
		<h3>{t('Recurrences')}</h3>
		<form method="post" action="?/syncRecurring" class="inline-form">
			<input type="hidden" name="section" value="recurring" />
			<input type="hidden" name="periodMonth" value={data.periodMonth} />
			<button class="button secondary" type="submit">
				<RefreshCw size={16} />
				<span>{t('Generate due')}</span>
			</button>
		</form>
	</div>
	<form method="post" action="?/createCatalog" class="support-catalog-form compact-support">
		<input type="hidden" name="section" value="recurring" />
		<input type="hidden" name="periodMonth" value={data.periodMonth} />
		<input type="hidden" name="kind" value="paymentMethod" />
		<label>
			<span>{t('New payment')}</span>
			<input name="name" required minlength="2" maxlength="80" placeholder="Boleto" />
		</label>
		<button class="button secondary" type="submit">{t('Create')}</button>
	</form>
	<form method="post" action="?/createRecurring" class="stack">
		<input type="hidden" name="section" value="recurring" />
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
					<input type="hidden" name="section" value="recurring" />
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
