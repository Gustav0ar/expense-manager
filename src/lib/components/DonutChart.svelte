<script lang="ts">
	import { formatCents } from '$lib/utils/format';

	type Item = {
		label: string;
		totalCents: number;
		color?: string;
	};

	let {
		items,
		label,
		empty = 'No data',
		currency = 'USD',
		locale,
		totalLabel = 'Total'
	}: {
		items: Item[];
		label: string;
		empty?: string;
		currency?: string;
		locale?: string;
		totalLabel?: string;
	} = $props();

	const radius = 42;
	const circumference = 2 * Math.PI * radius;
	const total = $derived(items.reduce((sum, item) => sum + item.totalCents, 0));
	const chartItems = $derived(items.filter((item) => item.totalCents > 0).slice(0, 6));
	const fallbackColors = ['#0f766e', '#2563eb', '#f97316', '#7c3aed', '#dc2626', '#0891b2'];
	const segments = $derived.by(() => {
		let offset = 0;
		return chartItems.map((item, index) => {
			const value = total ? item.totalCents / total : 0;
			const length = value * circumference;
			const segment = {
				...item,
				color: item.color ?? fallbackColors[index % fallbackColors.length],
				dasharray: `${length} ${circumference - length}`,
				dashoffset: -offset,
				percent: value * 100
			};
			offset += length;
			return segment;
		});
	});
</script>

{#if total === 0 || segments.length === 0}
	<p class="empty">{empty}</p>
{:else}
	<div class="donut-chart">
		<svg viewBox="0 0 120 120" role="img" aria-label={label}>
			<circle class="donut-base" cx="60" cy="60" r={radius}></circle>
			{#each segments as segment (segment.label)}
				<circle
					class="donut-segment"
					cx="60"
					cy="60"
					r={radius}
					stroke={segment.color}
					stroke-dasharray={segment.dasharray}
					stroke-dashoffset={segment.dashoffset}
				></circle>
			{/each}
			<text class="donut-total-label" x="60" y="55" text-anchor="middle">{totalLabel}</text>
			<text class="donut-total-value" x="60" y="70" text-anchor="middle">
				{formatCents(total, currency, locale)}
			</text>
		</svg>

		<div class="chart-legend">
			{#each segments as segment (segment.label)}
				<div class="chart-legend-item">
					<span class="legend-dot" style={`--legend-color:${segment.color}`}></span>
					<span>{segment.label}</span>
					<strong
						>{new Intl.NumberFormat(locale, {
							minimumFractionDigits: 1,
							maximumFractionDigits: 1
						}).format(segment.percent)}%</strong
					>
				</div>
			{/each}
		</div>
	</div>
{/if}
