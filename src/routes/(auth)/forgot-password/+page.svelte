<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData } from './$types';

	let { form } = $props<{ form: ActionData }>();
</script>

<svelte:head>
	<title>Recuperar senha | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>Recuperar senha</h1>

		{#if form?.sent}
			<p class="notice success">Se o email existir, voce recebera as instrucoes.</p>
		{:else}
			{#if form?.message}
				<p class="notice danger">{form.message}</p>
			{/if}

			<form method="post" class="stack">
				<label>
					<span>Email</span>
					<input name="email" type="email" autocomplete="email" required />
				</label>

				<button class="button primary" type="submit">Enviar</button>
			</form>
		{/if}

		<div class="auth-links">
			<a href={resolve('/login')}>Voltar</a>
		</div>
	</section>
</main>
