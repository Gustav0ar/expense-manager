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

	// SvelteKit replaces error.message with 'Internal Error' (English) in production
	// for unhandled 500s. Only surface the message when it comes from an intentional
	// app throw (i.e. the status is a client error or the message differs from the
	// generic SvelteKit fallback strings).
	const SVELTE_GENERIC_MESSAGES = new Set(['Internal Error', 'Not Found', 'Forbidden']);
	const errorMessage = $derived(
		$page.error?.message && !SVELTE_GENERIC_MESSAGES.has($page.error.message)
			? $page.error.message
			: t('Something went wrong.')
	);
</script>

<svelte:head>
	<title>{$page.status} | Expense Manager</title>
</svelte:head>

<main class="auth-page">
	<section class="auth-panel">
		<a class="brand" href={resolve('/')}>Expense Manager</a>
		<h1>{$page.status}</h1>
		<p class="notice danger">
			{errorMessage}
		</p>
		<a class="button primary" href={resolve('/app/dashboard')}>{t('Go to dashboard')}</a>
	</section>
</main>
