<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
</script>

<svelte:head>
	<title>Entrar | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>Entrar</h1>

		{#if data.registered}
			<p class="notice success">Conta criada. Entre para continuar.</p>
		{/if}

		{#if data.reset}
			<p class="notice success">Senha atualizada.</p>
		{/if}

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		<form method="post" class="stack">
			<input type="hidden" name="next" value={data.next} />
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
					autocomplete="current-password"
					required
					minlength="10"
				/>
			</label>

			<button class="button primary" type="submit">Entrar</button>
		</form>

		<div class="auth-links">
			<a href={resolve('/forgot-password')}>Esqueci minha senha</a>
			<a href={resolve('/register')}>Criar conta</a>
		</div>
	</section>
</main>
