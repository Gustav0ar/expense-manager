<script lang="ts">
	import { browser } from '$app/environment';
	import { onNavigate } from '$app/navigation';
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();

	type ViewTransitionDocument = Document & {
		startViewTransition?: (callback: () => Promise<void>) => void;
	};

	if (browser) {
		onNavigate((navigation) => {
			const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			const mobileViewport = window.matchMedia('(max-width: 760px)').matches;
			const coarsePointer = window.matchMedia('(pointer: coarse)').matches;
			const startViewTransition = (document as ViewTransitionDocument).startViewTransition;

			if (
				reduceMotion ||
				mobileViewport ||
				coarsePointer ||
				!startViewTransition ||
				!navigation.to?.url
			)
				return;

			return new Promise<void>((resolve) => {
				startViewTransition.call(document, async () => {
					resolve();
					await navigation.complete;
				});
			});
		});
	}
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
