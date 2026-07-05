<script lang="ts">
	import { resolve } from '$app/paths';
	import { translate } from '$lib/i18n';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();

	function t(key: string) {
		return translate(data.locale, key);
	}
</script>

<svelte:head>
	<title>{t('Recover password')} | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>{t('Recover password')}</h1>

		{#if form?.sent}
			<p class="notice success">{t('If the email exists, you will receive the instructions.')}</p>
		{:else}
			{#if form?.message}
				<p class="notice danger">{form.message}</p>
			{/if}

			<form method="post" class="stack">
				<label>
					<span>{t('Email')}</span>
					<input name="email" type="email" autocomplete="email" required />
				</label>

				<button class="button primary" type="submit">{t('Send')}</button>
			</form>
		{/if}

		<div class="auth-links">
			<a href={resolve('/login')}>{t('Back')}</a>
		</div>
	</section>
</main>
