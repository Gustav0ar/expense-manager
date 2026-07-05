<script lang="ts">
	import { resolve } from '$app/paths';
	import { Eye, EyeOff } from '@lucide/svelte';
	import { translate } from '$lib/i18n';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	let showPassword = $state(false);
	let showPasswordConfirmation = $state(false);

	function t(key: string) {
		return translate(data.locale, key);
	}

	function submitLocaleForm(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		select.form?.requestSubmit();
	}
</script>

<svelte:head>
	<title>{t('Create account')} | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<div class="auth-header">
			<a class="brand" href={resolve('/')}>Expense Manager</a>
			<form class="locale-form" method="post" action={resolve('/locale')}>
				<input type="hidden" name="returnTo" value={data.returnTo} />
				<label class="screen-reader-label" for="register-locale">{t('Language')}</label>
				<select
					id="register-locale"
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
		<h1>{t('Create account')}</h1>

		{#if form?.message}
			<p class="notice danger">{form.message}</p>
		{/if}

		{#if data.registrationEnabled}
			<form method="post" class="stack">
				<input type="hidden" name="next" value={data.next} />

				<label>
					<span>{t('Name')}</span>
					<input name="name" autocomplete="name" required value={form?.values?.name ?? ''} />
				</label>

				<label>
					<span>{t('Email')}</span>
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
					<span class="password-field">
						<input
							name="password"
							type={showPassword ? 'text' : 'password'}
							autocomplete="new-password"
							required
							minlength="10"
						/>
						<button
							class="password-toggle"
							type="button"
							aria-label={showPassword ? t('Hide password') : t('Show password')}
							title={showPassword ? t('Hide password') : t('Show password')}
							aria-pressed={showPassword}
							onclick={() => (showPassword = !showPassword)}
						>
							{#if showPassword}
								<EyeOff size={18} aria-hidden="true" />
							{:else}
								<Eye size={18} aria-hidden="true" />
							{/if}
						</button>
					</span>
				</label>

				<label>
					<span>{t('Confirm password')}</span>
					<span class="password-field">
						<input
							name="passwordConfirmation"
							type={showPasswordConfirmation ? 'text' : 'password'}
							autocomplete="new-password"
							required
							minlength="10"
						/>
						<button
							class="password-toggle"
							type="button"
							aria-label={showPasswordConfirmation ? t('Hide password') : t('Show password')}
							title={showPasswordConfirmation ? t('Hide password') : t('Show password')}
							aria-pressed={showPasswordConfirmation}
							onclick={() => (showPasswordConfirmation = !showPasswordConfirmation)}
						>
							{#if showPasswordConfirmation}
								<EyeOff size={18} aria-hidden="true" />
							{:else}
								<Eye size={18} aria-hidden="true" />
							{/if}
						</button>
					</span>
				</label>

				<button class="button primary" type="submit">{t('Create account')}</button>
			</form>
		{:else}
			<p class="notice">{t('Registration is currently closed.')}</p>
		{/if}

		<div class="auth-links">
			<a href={resolve('/login')}>{t('I already have an account')}</a>
		</div>
	</section>
</main>
