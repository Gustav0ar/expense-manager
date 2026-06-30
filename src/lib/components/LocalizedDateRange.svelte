<script lang="ts">
	import { onMount } from 'svelte';
	import { formatDateRangeLabel, getBrowserLocales } from '$lib/utils/date-format';

	let {
		from,
		to,
		fallback = `${from} a ${to}`
	}: {
		from: string;
		to: string;
		fallback?: string;
	} = $props();

	let mounted = $state(false);
	let locales = $state<Intl.LocalesArgument>(undefined);
	const formatted = $derived(mounted ? formatDateRangeLabel(from, to, locales) : fallback);

	function updateLocales() {
		locales = getBrowserLocales();
	}

	onMount(() => {
		mounted = true;
		updateLocales();
	});
</script>

<svelte:window onlanguagechange={updateLocales} />

{formatted}
