<script lang="ts">
	import { formatCents } from '$lib/utils/format';
	import { onMount } from 'svelte';
	import {
		formatPeriodLabel,
		getBrowserLocales,
		type DateLabelWidth,
		type DatePeriod
	} from '$lib/utils/date-format';

	type Item = {
		label: string;
		totalCents: number;
	};

	let {
		items,
		label,
		empty = 'No data',
		period = 'date',
		currency = 'USD',
		locale,
		totalLabel = 'Total in period'
	}: {
		items: Item[];
		label: string;
		empty?: string;
		period?: DatePeriod;
		currency?: string;
		locale?: string;
		totalLabel?: string;
	} = $props();

	let locales = $state<Intl.LocalesArgument>(undefined);
	const width = 960;
	const height = 220;
	const padding = { top: 18, right: 28, bottom: 34, left: 28 };
	const max = $derived(Math.max(...items.map((item) => item.totalCents), 0));
	const chartItems = $derived(items);
	const points = $derived.by(() =>
		chartItems.map((item, index) => {
			const x =
				chartItems.length === 1
					? width / 2
					: padding.left +
						(index / (chartItems.length - 1)) * (width - padding.left - padding.right);
			const y =
				height -
				padding.bottom -
				(max ? (item.totalCents / max) * (height - padding.top - padding.bottom) : 0);
			return { ...item, x, y };
		})
	);
	const linePath = $derived(
		points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
	);
	const areaPath = $derived(
		points.length
			? `${linePath} L ${points.at(-1)?.x} ${height - padding.bottom} L ${points[0]?.x} ${height - padding.bottom} Z`
			: ''
	);
	const total = $derived(chartItems.reduce((sum, item) => sum + item.totalCents, 0));
	const last = $derived(points.at(-1));

	function formatLabel(value: string, width: DateLabelWidth = 'full') {
		const resolvedLocales = locale ?? locales;
		if (!resolvedLocales) return value;
		return formatPeriodLabel(value, period, resolvedLocales, width);
	}

	function updateLocales() {
		locales = getBrowserLocales();
	}

	onMount(() => {
		updateLocales();
	});
</script>

<svelte:window onlanguagechange={updateLocales} />

{#if items.length === 0 || total === 0}
	<p class="empty">{empty}</p>
{:else}
	<div class="trend-chart">
		<div class="trend-summary">
			<span>{totalLabel}</span>
			<strong>{formatCents(total, currency, locale ?? locales)}</strong>
			{#if last}
				<small
					>{formatLabel(last.label)}: {formatCents(
						last.totalCents,
						currency,
						locale ?? locales
					)}</small
				>
			{/if}
		</div>

		<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
			{#each [0.25, 0.5, 0.75, 1] as tick (tick)}
				<line
					class="trend-grid-line"
					x1={padding.left}
					x2={width - padding.right}
					y1={height - padding.bottom - tick * (height - padding.top - padding.bottom)}
					y2={height - padding.bottom - tick * (height - padding.top - padding.bottom)}
				></line>
			{/each}
			<path class="trend-area" d={areaPath}></path>
			<path class="trend-line" d={linePath}></path>
			{#each points as point (point.label)}
				<g>
					<circle class="trend-point" cx={point.x} cy={point.y} r="4"></circle>
					<title
						>{formatLabel(point.label)}: {formatCents(
							point.totalCents,
							currency,
							locale ?? locales
						)}</title
					>
				</g>
			{/each}
			{#each points as point, index (point.label)}
				{#if index === 0 || index === points.length - 1 || points.length <= 4}
					<text
						class="trend-axis-label"
						x={point.x}
						y={height - 10}
						text-anchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}
					>
						{formatLabel(point.label, 'compact')}
					</text>
				{/if}
			{/each}
		</svg>
	</div>
{/if}
