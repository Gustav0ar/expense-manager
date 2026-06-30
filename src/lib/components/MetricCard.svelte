<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		label,
		value,
		footnote = '',
		children
	}: {
		label: string;
		value: string;
		footnote?: string;
		children?: Snippet;
	} = $props();
</script>

<section class="metric-card">
	<span>{label}</span>
	<strong>{value}</strong>
	{#if children}
		<small>{@render children()}</small>
	{:else if footnote}
		<small>{footnote}</small>
	{/if}
</section>
