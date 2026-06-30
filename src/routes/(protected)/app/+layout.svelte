<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import type { LayoutData } from './$types';
	import {
		BarChart3,
		CalendarClock,
		FolderTree,
		Home,
		LogOut,
		ReceiptText,
		Settings,
		UsersRound
	} from '@lucide/svelte';

	let { data, children } = $props<{ data: LayoutData; children: import('svelte').Snippet }>();

	const nav = [
		{ href: '/app/dashboard', label: 'Dashboard', shortLabel: 'Inicio', icon: Home },
		{ href: '/app/expenses', label: 'Despesas', shortLabel: 'Desp.', icon: ReceiptText },
		{ href: '/app/planning', label: 'Planejamento', shortLabel: 'Plano', icon: CalendarClock },
		{ href: '/app/categories', label: 'Categorias', shortLabel: 'Cat.', icon: FolderTree },
		{ href: '/app/reports', label: 'Relatorios', shortLabel: 'Rel.', icon: BarChart3 },
		{ href: '/app/settings/users', label: 'Usuarios', shortLabel: 'Equipe', icon: UsersRound },
		{ href: '/app/settings/workspace', label: 'Ajustes', shortLabel: 'Ajustes', icon: Settings }
	] as const;

	function isActive(href: string) {
		const pathname = page.url.pathname;
		return pathname === href || pathname.startsWith(`${href}/`);
	}
</script>

{#if data.currentWorkspace}
	<div class="app-shell">
		<aside class="sidebar">
			<a class="brand compact" href={resolve('/app/dashboard')}>Expense Manager</a>

			<nav class="nav-list" aria-label="Principal">
				{#each nav as item (item.href)}
					{@const Icon = item.icon}
					{@const active = isActive(item.href)}
					<a
						class:active
						class="nav-item"
						href={resolve(item.href)}
						aria-current={active ? 'page' : undefined}
						aria-label={item.label}
						data-sveltekit-preload-code="viewport"
					>
						<Icon size={18} />
						<span class="nav-label-full" aria-hidden="true">{item.label}</span>
						<span class="nav-label-short" aria-hidden="true">{item.shortLabel}</span>
					</a>
				{/each}
			</nav>

			<form method="post" action="/logout" class="sidebar-footer">
				<div>
					<strong>{data.user.name}</strong>
				</div>
				<button class="icon-button" type="submit" aria-label="Sair">
					<LogOut size={18} />
				</button>
			</form>
		</aside>

		<main class="main-panel">
			{@render children()}
		</main>
	</div>
{:else}
	{@render children()}
{/if}
