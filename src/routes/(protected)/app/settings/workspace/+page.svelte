<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData } from './$types';
	import type { LayoutData } from '../../$types';
	import {
		ClipboardList,
		LogOut,
		Monitor,
		Moon,
		ShieldCheck,
		Sun,
		UsersRound
	} from '@lucide/svelte';
	import { commonCurrencyCodes, defaultCurrencyForLocale, translate } from '$lib/i18n';

	let { data, form } = $props<{ data: LayoutData; form: ActionData }>();

	function t(key: string, params?: Record<string, string | number>) {
		return translate(data.locale, key, params);
	}

	function submitLocaleForm(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		select.form?.requestSubmit();
	}
</script>

<svelte:head>
	<title>{t('Workspace')} | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">{t('Settings')}</span>
			<h2>{t('Workspace')}</h2>
		</div>
	</div>

	{#if form?.message}
		<p class="notice danger">{form.message}</p>
	{/if}

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Current')}</h3>
			</div>
			<form method="post" action="?/update" class="stack">
				<label>
					<span>{t('Name')}</span>
					<input name="name" value={data.currentWorkspace?.workspaceName ?? ''} required />
				</label>
				<label>
					<span>{t('Week starts on')}</span>
					<select name="weekStartsOn">
						<option value="1" selected={data.currentWorkspace?.weekStartsOn === 1}
							>{t('Monday')}</option
						>
						<option value="0" selected={data.currentWorkspace?.weekStartsOn === 0}
							>{t('Sunday')}</option
						>
					</select>
				</label>
				<label>
					<span>{t('Currency')}</span>
					<input
						name="currency"
						list="currency-options"
						maxlength="3"
						pattern={'[A-Za-z]{3}'}
						value={data.currentWorkspace?.currency ?? 'USD'}
						required
					/>
					<datalist id="currency-options">
						{#each commonCurrencyCodes as currency (currency)}
							<option value={currency}></option>
						{/each}
					</datalist>
				</label>
				<button class="button primary" type="submit">{t('Save')}</button>
			</form>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Transfer')}</h3>
			</div>
			<form method="post" action="?/switchWorkspace" class="stack">
				<label>
					<span>{t('Workspace')}</span>
					<select name="workspaceId">
						{#each data.memberships as membership (membership.workspaceId)}
							<option
								value={membership.workspaceId}
								selected={membership.workspaceId === data.currentWorkspace?.workspaceId}
							>
								{membership.workspaceName}
							</option>
						{/each}
					</select>
				</label>
				<button class="button secondary" type="submit">{t('Transfer')}</button>
			</form>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Appearance')}</h3>
			</div>
			<form method="post" action="?/updateTheme" class="stack">
				<fieldset class="theme-fieldset">
					<legend>{t('Theme')}</legend>
					<div class="theme-options">
						<label class="theme-option">
							<input
								type="radio"
								name="theme"
								value="system"
								checked={data.themePreference === 'system'}
							/>
							<span class="theme-option-content">
								<Monitor size={18} />
								<span>{t('System')}</span>
							</span>
						</label>
						<label class="theme-option">
							<input
								type="radio"
								name="theme"
								value="light"
								checked={data.themePreference === 'light'}
							/>
							<span class="theme-option-content">
								<Sun size={18} />
								<span>{t('Light')}</span>
							</span>
						</label>
						<label class="theme-option">
							<input
								type="radio"
								name="theme"
								value="dark"
								checked={data.themePreference === 'dark'}
							/>
							<span class="theme-option-content">
								<Moon size={18} />
								<span>{t('Dark')}</span>
							</span>
						</label>
					</div>
				</fieldset>
				<button class="button primary" type="submit">{t('Save theme')}</button>
			</form>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>{t('Language')}</h3>
			</div>
			<form method="post" action="?/updateLocale" class="stack">
				<label>
					<span>{t('Language')}</span>
					<select name="locale" onchange={submitLocaleForm}>
						<option value="system" selected={data.localePreference === 'system'}
							>🌐 {t('System')}</option
						>
						<option value="en" selected={data.localePreference === 'en'}>🇺🇸 {t('English')}</option>
						<option value="pt-BR" selected={data.localePreference === 'pt-BR'}>
							🇧🇷 {t('Portuguese (Brazil)')}
						</option>
					</select>
				</label>
				<button class="button primary" type="submit">{t('Save language')}</button>
			</form>
		</section>

		<section class="panel settings-shortcuts">
			<div class="panel-heading">
				<h3>{t('Account and audit')}</h3>
			</div>
			<a class="shortcut-link" href={resolve('/app/settings/users')}>
				<UsersRound size={18} />
				<span>{t('Users')}</span>
			</a>
			<a class="shortcut-link" href={resolve('/app/settings/security')}>
				<ShieldCheck size={18} />
				<span>{t('Security')}</span>
			</a>
			<a class="shortcut-link" href={resolve('/app/settings/audit')}>
				<ClipboardList size={18} />
				<span>{t('Audit')}</span>
			</a>
		</section>
	</div>

	<section class="panel">
		<div class="panel-heading">
			<h3>{t('New workspace')}</h3>
		</div>
		<form method="post" action="?/create" class="form-grid">
			<label>
				<span>{t('Name')}</span>
				<input name="name" required />
			</label>
			<label>
				<span>{t('Week starts on')}</span>
				<select name="weekStartsOn">
					<option value="1">{t('Monday')}</option>
					<option value="0">{t('Sunday')}</option>
				</select>
			</label>
			<label>
				<span>{t('Currency')}</span>
				<input
					name="currency"
					list="currency-options"
					maxlength="3"
					pattern={'[A-Za-z]{3}'}
					value={defaultCurrencyForLocale(data.locale)}
					required
				/>
			</label>
			<button class="button primary align-end" type="submit">{t('Create')}</button>
		</form>
	</section>

	<section class="panel logout-panel">
		<div class="logout-identity">
			<strong>{data.user.name}</strong>
			<span>{data.user.email}</span>
		</div>
		<form method="post" action="/logout">
			<button class="button secondary danger" type="submit">
				<LogOut size={16} />
				{t('Logout')}
			</button>
		</form>
	</section>
</section>
