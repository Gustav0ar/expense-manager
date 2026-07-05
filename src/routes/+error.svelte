<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/stores';
	import { translate } from '$lib/i18n';
	import type { LayoutData } from './$types';

	// The root layout exposes locale; fall back to 'en' if unavailable.
	// We use $page.data for robustness since layout data may not always be set
	// on error boundaries.
	const locale = $derived(($page.data as LayoutData | null)?.locale ?? 'en');

	function t(key: string) {
		return translate(locale, key);
	}
</script>

<svelte:head>
	<title>{$page.status} | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>{$page.status}</h1>
		<p class="notice danger">
			{$page.error?.message ?? t('Something went wrong.')}
		</p>
		<a class="button primary" href={resolve('/app/dashboard')}>{t('Go to dashboard')}</a>
	</section>
</main>
