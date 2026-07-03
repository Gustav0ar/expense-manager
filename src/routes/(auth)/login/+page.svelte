<script lang="ts">
	import { resolve } from '$app/paths';
	import { translate } from '$lib/i18n';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();

	function t(key: string) {
		return translate(data.locale, key);
	}

	function submitLocaleForm(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		select.form?.requestSubmit();
	}
</script>

<svelte:head>
	<title>{t('Login')} | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<div class="auth-header">
			<a class="brand" href={resolve('/')}>Expense Manager</a>
			<form class="locale-form" method="post" action={resolve('/locale')}>
				<input type="hidden" name="returnTo" value={data.returnTo} />
				<label class="screen-reader-label" for="login-locale">{t('Language')}</label>
				<select
					id="login-locale"
					name="locale"
					aria-label={t('Language')}
					onchange={submitLocaleForm}
				>
					<option value="system" selected={data.localePreference === 'system'}>
						🌐 {t('Device language')}
					</option>
					<option value="en" selected={data.localePreference === 'en'}>🇺🇸 {t('English')}</option>
					<option value="pt-BR" selected={data.localePreference === 'pt-BR'}>
						🇧🇷 {t('Portuguese (Brazil)')}
					</option>
				</select>
			</form>
		</div>
		<h1>{t('Login')}</h1>

		{#if data.registered}
			<p class="notice success">{t('Account created. Sign in to continue.')}</p>
		{/if}

		{#if data.reset}
			<p class="notice success">{t('Password updated.')}</p>
		{/if}

		{#if data.verifyEmail}
			<p class="notice success">
				{t('Account created. Check your email to verify your account before signing in.')}
			</p>
		{/if}

		{#if data.resentVerification}
			<p class="notice success">
				{t('If the account exists and needs verification, we sent a new verification link.')}
			</p>
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
			{#if data.registrationEnabled}
				<a href={resolve('/register')}>{t('Create account')}</a>
			{/if}
		</div>
	</section>
</main>
