<script lang="ts">
	import { onMount } from 'svelte';
	import { formatDateLabel, formatDatePart, getBrowserLocales } from '$lib/utils/date-format';

	let { value }: { value: string } = $props();

	let mounted = $state(false);
	let locales = $state<Intl.LocalesArgument>(undefined);
	const ariaLabel = $derived(mounted ? formatDateLabel(value, locales) : value);
	const day = $derived(mounted ? formatDatePart(value, 'day', locales) : value.slice(-2));
	const month = $derived(mounted ? formatDatePart(value, 'month', locales) : value.slice(5, 7));

	function updateLocales() {
		locales = getBrowserLocales();
	}

	onMount(() => {
		mounted = true;
		updateLocales();
	});
</script>

<svelte:window onlanguagechange={updateLocales} />

<span class="expense-date-badge" aria-label={ariaLabel}>
	<strong>{day}</strong>
	<small>{month}</small>
</span>
