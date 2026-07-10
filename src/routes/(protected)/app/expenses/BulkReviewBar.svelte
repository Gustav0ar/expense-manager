<script lang="ts">
	import { CheckCircle2, XCircle } from '@lucide/svelte';
	import { SvelteSet } from 'svelte/reactivity';

	type Props = {
		selectedIds: SvelteSet<number>;
		returnTo: string;
		t: (key: string, params?: Record<string, string | number | null | undefined>) => string;
	};

	let { selectedIds, returnTo, t }: Props = $props();
</script>

{#if selectedIds.size > 0}
	<div class="bulk-action-bar" role="region" aria-label={t('Bulk actions')}>
		<span class="bulk-action-count">{t('{count} selected', { count: selectedIds.size })}</span>
		<form method="post" action="?/bulkReview" class="bulk-action-form">
			<input type="hidden" name="returnTo" value={returnTo} />
			<input type="hidden" name="decision" value="approved" />
			{#each [...selectedIds] as id (id)}
				<input type="hidden" name="id" value={id} />
			{/each}
			<button class="button review-approve" type="submit">
				<CheckCircle2 size={16} />
				<span>{t('Approve')}</span>
			</button>
		</form>
		<form method="post" action="?/bulkReview" class="bulk-action-form">
			<input type="hidden" name="returnTo" value={returnTo} />
			<input type="hidden" name="decision" value="rejected" />
			{#each [...selectedIds] as id (id)}
				<input type="hidden" name="id" value={id} />
			{/each}
			<button class="button secondary danger" type="submit">
				<XCircle size={16} />
				<span>{t('Reject')}</span>
			</button>
		</form>
		<button class="button secondary" type="button" onclick={() => selectedIds.clear()}>
			{t('Clear')}
		</button>
	</div>
{/if}
