<script lang="ts">
	import { onMount } from 'svelte';
	import {
		formatPeriodLabel,
		getBrowserLocales,
		type DateLabelWidth,
		type DatePeriod
	} from '$lib/utils/date-format';

	let {
		value,
		period = 'date',
		width = 'full',
		fallback = value
	}: {
		value: string;
		period?: DatePeriod;
		width?: DateLabelWidth;
		fallback?: string;
	} = $props();

	let mounted = $state(false);
	let locales = $state<Intl.LocalesArgument>(undefined);
	const formatted = $derived(mounted ? formatPeriodLabel(value, period, locales, width) : fallback);

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
