<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { translate } from '$lib/i18n';
	import type { LayoutData } from './$types';
	import { BarChart3, CalendarClock, Home, LogOut, ReceiptText, Settings } from '@lucide/svelte';

	let { data, children } = $props<{ data: LayoutData; children: import('svelte').Snippet }>();

	const nav = $derived([
		{ href: '/app/dashboard', label: t('Dashboard'), shortLabel: t('Home short'), icon: Home },
		{
			href: '/app/expenses',
			label: t('Expenses'),
			shortLabel: t('Expenses short'),
			icon: ReceiptText
		},
		{
			href: '/app/planning',
			label: t('Budget'),
			shortLabel: t('Budget short'),
			icon: CalendarClock
		},
		{ href: '/app/reports', label: t('Reports'), shortLabel: t('Reports short'), icon: BarChart3 },
		{
			href: '/app/settings/workspace',
			label: t('Settings'),
			shortLabel: t('Settings short'),
			icon: Settings
		}
	] as const);

	function t(key: string) {
		return translate(data.locale, key);
	}

	function isActive(href: string) {
		const pathname = page.url.pathname;
		if (href === '/app/planning' && pathname.startsWith('/app/categories')) {
			return true;
		}
		if (
			href === '/app/settings/workspace' &&
			(pathname.startsWith('/app/settings/security') ||
				pathname.startsWith('/app/settings/audit') ||
				pathname.startsWith('/app/settings/users'))
		) {
			return true;
		}
		return pathname === href || pathname.startsWith(`${href}/`);
	}
</script>

{#if data.currentWorkspace}
	<a href="#main-content" class="skip-link">{t('Skip to main content')}</a>
	<div class="app-shell">
		<aside class="sidebar">
			<a class="brand compact" href={resolve('/app/dashboard')}>Expense Manager</a>

			<nav class="nav-list" aria-label={t('Primary')}>
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
				<button class="icon-button" type="submit" aria-label={t('Logout')}>
					<LogOut size={18} />
				</button>
			</form>
		</aside>

		<main class="main-panel" id="main-content">
			{@render children()}
		</main>
	</div>
{:else}
	{@render children()}
{/if}
