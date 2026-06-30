<script lang="ts">
	import { onMount } from 'svelte';
	import {
		formatDateTimeLabel,
		getBrowserLocales,
		type DateLabelWidth
	} from '$lib/utils/date-format';

	let {
		value,
		width = 'full',
		fallback
	}: {
		value: Date | string;
		width?: DateLabelWidth;
		fallback?: string;
	} = $props();

	let mounted = $state(false);
	let locales = $state<Intl.LocalesArgument>(undefined);
	const resolvedFallback = $derived(fallback ?? fallbackLabel(value));
	const formatted = $derived(
		mounted ? formatDateTimeLabel(value, locales, width) : resolvedFallback
	);

	function updateLocales() {
		locales = getBrowserLocales();
	}

	onMount(() => {
		mounted = true;
		updateLocales();
	});

	function fallbackLabel(input: Date | string) {
		return input instanceof Date ? input.toISOString() : input;
	}
</script>

<svelte:window onlanguagechange={updateLocales} />

{formatted}
