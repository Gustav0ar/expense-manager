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
	<title>{t('Create account')} | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>{t('Create account')}</h1>

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		<form method="post" class="stack">
			<input type="hidden" name="next" value={data.next} />

			<label>
				<span>{t('Name')}</span>
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
				<span>{t('Password')}</span>
				<input
					name="password"
					type="password"
					autocomplete="new-password"
					required
					minlength="10"
				/>
			</label>

			<button class="button primary" type="submit">{t('Create account')}</button>
		</form>

		<div class="auth-links">
			<a href={resolve('/login')}>{t('I already have an account')}</a>
		</div>
	</section>
</main>
