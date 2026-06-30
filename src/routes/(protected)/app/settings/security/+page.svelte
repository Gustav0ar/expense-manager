<script lang="ts">
	import { KeyRound, ShieldCheck, ShieldOff } from '@lucide/svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
</script>

<svelte:head>
	<title>Seguranca | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">Conta</span>
			<h2>Seguranca</h2>
		</div>
	</div>

	{#if form?.message}
		<p class:success={form.recoveryCodes} class:danger={!form.recoveryCodes} class="notice">
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
							? `${data.mfa.recoveryCodesRemaining} recovery codes restantes`
							: 'Proteja sua conta com um app autenticador.'}
					</p>
				</div>
			</div>

			{#if !data.mfa.enabled && !form?.setup && !form?.recoveryCodes}
				<form method="post" action="?/beginSetup">
					<button class="button primary" type="submit">
						<KeyRound size={18} />
						<span>Configurar MFA</span>
					</button>
				</form>
			{/if}

			{#if data.mfa.enabled}
				<form method="post" action="?/disable" class="stack">
					<label>
						<span>Codigo atual</span>
						<input name="code" autocomplete="one-time-code" required />
					</label>
					<button class="button danger" type="submit">Desativar MFA</button>
				</form>
			{/if}
		</section>

		{#if form?.setup}
			<section class="panel">
				<div class="panel-heading">
					<h3>Ativar MFA</h3>
				</div>
				<div class="setup-code">
					<span>Secret</span>
					<strong>{form.setup.secret}</strong>
				</div>
				<div class="setup-uri">
					<span>URI</span>
					<code>{form.setup.otpAuthUri}</code>
				</div>
				<form method="post" action="?/enable" class="stack">
					<input type="hidden" name="secret" value={form.setup.secret} />
					<label>
						<span>Codigo gerado no app</span>
						<input name="code" autocomplete="one-time-code" inputmode="numeric" required />
					</label>
					<button class="button primary" type="submit">Ativar</button>
				</form>
			</section>
		{/if}

		{#if form?.recoveryCodes}
			<section class="panel recovery-panel">
				<div class="panel-heading">
					<h3>Recovery codes</h3>
				</div>
				<div class="recovery-grid">
					{#each form.recoveryCodes as code (code)}
						<code>{code}</code>
					{/each}
				</div>
			</section>
		{/if}
	</div>
</section>
