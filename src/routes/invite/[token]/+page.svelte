<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const loginPath = resolve('/login');
</script>

<svelte:head>
	<title>Convite | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>Convite</h1>

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		{#if !data.invitation}
			<p class="notice danger">Convite invalido ou expirado.</p>
		{:else}
			<p class="notice success">{data.invitation.workspaceName}</p>

			{#if data.user}
				<form method="post" action="?/accept" class="stack">
					<button class="button primary" type="submit">Aceitar convite</button>
				</form>
			{:else}
				<div class="auth-links">
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
					<a href={`${loginPath}?next=${encodeURIComponent(`/invite/${data.token}`)}`}>Entrar</a>
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
					<a href={`${resolve('/register')}?next=${encodeURIComponent(`/invite/${data.token}`)}`}
						>Criar conta</a
					>
				</div>
			{/if}
		{/if}
	</section>
</main>
