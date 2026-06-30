<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ActionData } from './$types';
	import type { LayoutData } from '../../$types';
	import { ClipboardList, Monitor, Moon, ShieldCheck, Sun } from '@lucide/svelte';

	let { data, form } = $props<{ data: LayoutData; form: ActionData }>();
</script>

<svelte:head>
	<title>Workspace | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">Configuracao</span>
			<h2>Workspace</h2>
		</div>
	</div>

	{#if form?.message}
		<p class="notice danger">{form.message}</p>
	{/if}

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>Atual</h3>
			</div>
			<form method="post" action="?/update" class="stack">
				<label>
					<span>Nome</span>
					<input name="name" value={data.currentWorkspace?.workspaceName ?? ''} required />
				</label>
				<label>
					<span>Timezone</span>
					<input
						name="timezone"
						value={data.currentWorkspace?.timezone ?? 'America/Sao_Paulo'}
						required
					/>
				</label>
				<label>
					<span>Inicio da semana</span>
					<select name="weekStartsOn">
						<option value="1" selected={data.currentWorkspace?.weekStartsOn === 1}>Segunda</option>
						<option value="0" selected={data.currentWorkspace?.weekStartsOn === 0}>Domingo</option>
					</select>
				</label>
				<button class="button primary" type="submit">Salvar</button>
			</form>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>Trocar</h3>
			</div>
			<form method="post" action="?/switchWorkspace" class="stack">
				<label>
					<span>Workspace</span>
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
				<button class="button secondary" type="submit">Trocar</button>
			</form>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>Aparencia</h3>
			</div>
			<form method="post" action="?/updateTheme" class="stack">
				<fieldset class="theme-fieldset">
					<legend>Tema</legend>
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
								<span>Sistema</span>
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
								<span>Claro</span>
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
								<span>Escuro</span>
							</span>
						</label>
					</div>
				</fieldset>
				<button class="button primary" type="submit">Salvar tema</button>
			</form>
		</section>

		<section class="panel settings-shortcuts">
			<div class="panel-heading">
				<h3>Conta e auditoria</h3>
			</div>
			<a class="shortcut-link" href={resolve('/app/settings/security')}>
				<ShieldCheck size={18} />
				<span>Seguranca</span>
			</a>
			<a class="shortcut-link" href={resolve('/app/settings/audit')}>
				<ClipboardList size={18} />
				<span>Auditoria</span>
			</a>
		</section>
	</div>

	<section class="panel">
		<div class="panel-heading">
			<h3>Novo workspace</h3>
		</div>
		<form method="post" action="?/create" class="form-grid">
			<label>
				<span>Nome</span>
				<input name="name" required />
			</label>
			<label>
				<span>Timezone</span>
				<input name="timezone" value="America/Sao_Paulo" required />
			</label>
			<label>
				<span>Inicio da semana</span>
				<select name="weekStartsOn">
					<option value="1">Segunda</option>
					<option value="0">Domingo</option>
				</select>
			</label>
			<button class="button primary align-end" type="submit">Criar</button>
		</form>
	</section>
</section>
