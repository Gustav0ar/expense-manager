<script lang="ts">
	import { translate } from '$lib/i18n';
	import { Copy, Download, KeyRound, ShieldCheck, ShieldOff } from '@lucide/svelte';
	import type { ActionData, PageData } from './$types';
	import QRCode from 'qrcode';
	import { onMount } from 'svelte';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();

	let copiedCodes = $state(false);
	let qrDataUrl = $state('');

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	onMount(async () => {
		if (form?.setup?.otpAuthUri) {
			qrDataUrl = await QRCode.toDataURL(form.setup.otpAuthUri, { width: 200 });
		}
	});

	async function copyRecoveryCodes() {
		if (!form?.recoveryCodes) return;
		try {
			await navigator.clipboard.writeText(form.recoveryCodes.join('\n'));
			copiedCodes = true;
			setTimeout(() => (copiedCodes = false), 2000);
		} catch {
			// clipboard not available (HTTP, permission denied) — silently fail, don't show "Copied!"
		}
	}

	function downloadRecoveryCodes() {
		if (!form?.recoveryCodes) return;
		const blob = new Blob([form.recoveryCodes.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'recovery-codes.txt';
		a.click();
		URL.revokeObjectURL(url);
	}
</script>

<svelte:head>
	<title>{t('Security')} | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">{t('Account')}</span>
			<h2>{t('Security')}</h2>
		</div>
	</div>

	{#if form?.message}
		<p class:success={form.recoveryCodes} class:danger={!form.recoveryCodes} class="notice" role={form.recoveryCodes ? 'status' : 'alert'}>
			{form.message}
		</p>
	{/if}

	<div class="content-grid two">
		<section class="panel security-panel">
			<div class="security-status">
				<span class:active={data.mfa.enabled} class="security-icon">
					{#if data.mfa.enabled}
						<ShieldCheck size={22} />
					{:else}
						<ShieldOff size={22} />
					{/if}
				</span>
				<div>
					<h3>MFA</h3>
					<p>
						{data.mfa.enabled
							? t('{count} recovery codes remaining', {
									count: data.mfa.recoveryCodesRemaining
								})
							: t('Protect your account with an authenticator app.')}
					</p>
				</div>
			</div>

			{#if !data.mfa.enabled && !form?.setup && !form?.recoveryCodes}
				<form method="post" action="?/beginSetup">
					<button class="button primary" type="submit">
						<KeyRound size={18} />
						<span>{t('Configure MFA')}</span>
					</button>
				</form>
			{/if}

			{#if data.mfa.enabled}
				<p class="notice warning">
					{t('Disabling MFA will reduce your account security.')}
				</p>
				<form method="post" action="?/disable" class="stack">
					<label>
						<span>{t('Current code')}</span>
						<input name="code" autocomplete="one-time-code" required />
					</label>
					<button class="button danger" type="submit">{t('Disable MFA')}</button>
				</form>
			{/if}
		</section>

		{#if form?.setup}
			<section class="panel">
				<div class="panel-heading">
					<h3>{t('Enable MFA')}</h3>
				</div>
				<div class="mfa-qr">
					{#if qrDataUrl}
						<img
							src={qrDataUrl}
							alt={t('Scan this QR code with your authenticator app')}
							width="200"
							height="200"
						/>
					{/if}
				</div>
				<div class="setup-code">
					<span>{t('Secret')}</span>
					<strong>{form.setup.secret}</strong>
				</div>
				<div class="setup-uri">
					<span>{t('URI')}</span>
					<code>{form.setup.otpAuthUri}</code>
				</div>
				<form method="post" action="?/enable" class="stack">
					<input type="hidden" name="secret" value={form.setup.secret} />
					<label>
						<span>{t('Code generated in the app')}</span>
						<input name="code" autocomplete="one-time-code" inputmode="numeric" required />
					</label>
					<button class="button primary" type="submit">{t('Enable')}</button>
				</form>
			</section>
		{/if}

		{#if form?.recoveryCodes}
			<section class="panel recovery-panel">
				<div class="panel-heading">
					<h3>{t('Recovery codes')}</h3>
				</div>
				<div class="recovery-grid">
					{#each form.recoveryCodes as code (code)}
						<code>{code}</code>
					{/each}
				</div>
				<div class="recovery-actions">
					<button type="button" class="button secondary" onclick={copyRecoveryCodes}>
						<Copy size={16} />
						<span>{copiedCodes ? t('Copied!') : t('Copy all')}</span>
					</button>
					<button type="button" class="button secondary" onclick={downloadRecoveryCodes}>
						<Download size={16} />
						<span>{t('Download')}</span>
					</button>
				</div>
			</section>
		{/if}
	</div>
</section>
