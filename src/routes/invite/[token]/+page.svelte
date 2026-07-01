<script lang="ts">
	import { resolve } from '$app/paths';
	import { translate } from '$lib/i18n';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const loginPath = resolve('/login');

	function t(key: string) {
		return translate(data.locale, key);
	}
</script>

<svelte:head>
	<title>{t('Invite')} | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>{t('Invite')}</h1>

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		{#if !data.invitation}
			<p class="notice danger">{t('Invalid invite or expired.')}</p>
		{:else}
			<p class="notice success">{data.invitation.workspaceName}</p>

			{#if data.user}
				<form method="post" action="?/accept" class="stack">
					<button class="button primary" type="submit">{t('Accept invite')}</button>
				</form>
			{:else}
				<div class="auth-links">
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
					<a href={`${loginPath}?next=${encodeURIComponent(`/invite/${data.token}`)}`}
						>{t('Login')}</a
					>
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
					<a href={`${resolve('/register')}?next=${encodeURIComponent(`/invite/${data.token}`)}`}
						>{t('Create account')}</a
					>
				</div>
			{/if}
		{/if}
	</section>
</main>
