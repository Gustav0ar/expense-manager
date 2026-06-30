<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
</script>

<svelte:head>
	<title>Criar conta | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>Criar conta</h1>

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		<form method="post" class="stack">
			<input type="hidden" name="next" value={data.next} />

			<label>
				<span>Nome</span>
				<input name="name" autocomplete="name" required value={form?.values?.name ?? ''} />
			</label>

			<label>
				<span>Email</span>
				<input
					name="email"
					type="email"
					autocomplete="email"
					required
					value={form?.values?.email ?? ''}
				/>
			</label>

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

			<button class="button primary" type="submit">Criar conta</button>
		</form>

		<div class="auth-links">
			<a href={resolve('/login')}>Ja tenho conta</a>
		</div>
	</section>
</main>
