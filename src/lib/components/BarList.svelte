<script lang="ts">
	import { formatCents } from '$lib/utils/format';
	import { onMount } from 'svelte';
	import { formatPeriodLabel, getBrowserLocales, type DatePeriod } from '$lib/utils/date-format';

	type Item = {
		label: string;
		totalCents: number;
		color?: string;
	};

	let {
		items,
		empty = 'No data',
		period,
		currency = 'USD',
		locale
	}: {
		items: Item[];
		empty?: string;
		period?: DatePeriod;
		currency?: string;
		locale?: string;
	} = $props();

	let locales = $state<Intl.LocalesArgument>(undefined);
	const max = $derived(Math.max(...items.map((item) => item.totalCents), 0));

	function formatLabel(label: string) {
		const resolvedLocales = locale ?? locales;
		if (!period || !resolvedLocales) return label;
		return formatPeriodLabel(label, period, resolvedLocales);
	}

	function updateLocales() {
		locales = getBrowserLocales();
	}

	onMount(() => {
		updateLocales();
	});
</script>

<svelte:window onlanguagechange={updateLocales} />

{#if items.length === 0}
	<p class="empty">{empty}</p>
{:else}
	<div class="bar-list">
		{#each items as item (item.label)}
			<div class="bar-row">
				<div class="bar-label">
					<span>{formatLabel(item.label)}</span>
					<strong>{formatCents(item.totalCents, currency, locale ?? locales)}</strong>
				</div>
				<div class="bar-track" aria-hidden="true">
					<div
						class="bar-fill"
						style={`width: ${max ? Math.max(4, (item.totalCents / max) * 100) : 0}%; background: ${item.color ?? 'var(--color-primary)'}`}
					></div>
				</div>
			</div>
		{/each}
	</div>
{/if}
