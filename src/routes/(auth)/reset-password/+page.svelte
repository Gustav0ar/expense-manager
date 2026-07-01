<script lang="ts">
	import { resolve } from '$app/paths';
	import { translate } from '$lib/i18n';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const token = $derived(form?.token ?? data.token);

	function t(key: string) {
		return translate(data.locale, key);
	}
</script>

<svelte:head>
	<title>{t('New password')} | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>{t('New password')}</h1>

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		<form method="post" class="stack">
			<input type="hidden" name="token" value={token} />

			<label>
				<span>{t('Password')}</span>
				<input
					name="password"
					type="password"
					autocomplete="new-password"
					required
					minlength="10"
				/>
			</label>

			<button class="button primary" type="submit">{t('Save password')}</button>
		</form>
	</section>
</main>
