<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData } from './$types';

	let { form } = $props<{ form: ActionData }>();
</script>

<svelte:head>
	<title>Novo workspace | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel wide">
		<a class="brand" href={resolve('/app')}>Expense Manager</a>
		<h1>Novo workspace</h1>

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		<form method="post" class="stack">
			<label>
				<span>Nome</span>
				<input name="name" required minlength="2" maxlength="80" value="Minhas despesas" />
			</label>

			<label>
				<span>Timezone</span>
				<input name="timezone" required value="America/Sao_Paulo" />
			</label>

			<label>
				<span>Inicio da semana</span>
				<select name="weekStartsOn">
					<option value="1">Segunda</option>
					<option value="0">Domingo</option>
				</select>
			</label>

			<button class="button primary" type="submit">Criar workspace</button>
		</form>
	</section>
</main>
