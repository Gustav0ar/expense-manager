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
	<title>{t('Login')} | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>{t('Login')}</h1>

		{#if data.registered}
			<p class="notice success">{t('Account created. Sign in to continue.')}</p>
		{/if}

		{#if data.reset}
			<p class="notice success">{t('Password updated.')}</p>
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
				<span>{t('Password')}</span>
				<input
					name="password"
					type="password"
					autocomplete="current-password"
					required
					minlength="10"
				/>
			</label>

			<button class="button primary" type="submit">{t('Login')}</button>
		</form>

		<div class="auth-links">
			<a href={resolve('/forgot-password')}>{t('Forgot password')}</a>
			<a href={resolve('/register')}>{t('Create account')}</a>
		</div>
	</section>
</main>
