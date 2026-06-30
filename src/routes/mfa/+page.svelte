<script lang="ts">
	import { resolve } from '$app/paths';
	import { ShieldCheck } from '@lucide/svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
</script>

<svelte:head>
	<title>Verificacao MFA | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<div class="auth-icon">
			<ShieldCheck size={22} />
		</div>
		<h1>Verificacao</h1>

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		<form method="post" class="stack">
			<input type="hidden" name="next" value={form?.next ?? data.next} />
			<label>
				<span>Codigo do autenticador ou recovery code</span>
				<input
					name="code"
					autocomplete="one-time-code"
					inputmode="numeric"
					required
					placeholder="123456"
				/>
			</label>
			<button class="button primary" type="submit">Verificar</button>
		</form>
	</section>
</main>
