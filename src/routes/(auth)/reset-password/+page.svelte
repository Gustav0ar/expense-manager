<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const token = $derived(form?.token ?? data.token);
</script>

<svelte:head>
	<title>Nova senha | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>Nova senha</h1>

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		<form method="post" class="stack">
			<input type="hidden" name="token" value={token} />

			<label>
				<span>Senha</span>
				<input
					name="password"
					type="password"
					autocomplete="new-password"
					required
					minlength="10"
				/>
			</label>

			<button class="button primary" type="submit">Salvar senha</button>
		</form>
	</section>
</main>
