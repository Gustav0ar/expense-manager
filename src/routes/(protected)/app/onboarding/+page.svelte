<script lang="ts">
	import { resolve } from '$app/paths';
	import { commonCurrencyCodes, translate } from '$lib/i18n';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();

	function t(key: string) {
		return translate(data.locale, key);
	}
</script>

<svelte:head>
	<title>{t('New workspace')} | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel wide">
		<a class="brand" href={resolve('/app')}>Expense Manager</a>
		<h1>{t('New workspace')}</h1>

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		<form method="post" class="stack">
			<label>
				<span>{t('Name')}</span>
				<input name="name" required minlength="2" maxlength="80" value="My expenses" />
			</label>

			<label>
				<span>{t('Week starts on')}</span>
				<select name="weekStartsOn">
					<option value="1">{t('Monday')}</option>
					<option value="0">{t('Sunday')}</option>
				</select>
			</label>

			<label>
				<span>{t('Currency')}</span>
				<input
					name="currency"
					list="currency-options"
					maxlength="3"
					pattern={'[A-Za-z]{3}'}
					value={data.locale === 'pt-BR' ? 'BRL' : 'USD'}
					required
				/>
				<datalist id="currency-options">
					{#each commonCurrencyCodes as currency (currency)}
						<option value={currency}></option>
					{/each}
				</datalist>
			</label>

			<button class="button primary" type="submit">{t('Create workspace')}</button>
		</form>
	</section>
</main>
