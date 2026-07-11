<script lang="ts">
	import { resolve } from '$app/paths';
	import { ArrowLeft, RotateCcw, Trash2 } from '@lucide/svelte';
	import { translate } from '$lib/i18n';
	import { formatDateTimeLabel } from '$lib/utils/date-format';
	import { formatCents } from '$lib/utils/format';
	import type { Attachment } from 'svelte/attachments';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	let purgeDialog: HTMLDialogElement | undefined = $state();
	let pendingPurge = $state<PageData['items'][number] | null>(null);
	const capturePurgeDialog: Attachment<HTMLDialogElement> = (element) => {
		purgeDialog = element;
		return () => {
			if (purgeDialog === element) purgeDialog = undefined;
		};
	};

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	function dateTime(value: Date | string | null) {
		return value ? formatDateTimeLabel(value, data.locale, 'compact') : '';
	}

	function isExpired(expiresAt: Date | null) {
		return expiresAt !== null && expiresAt.getTime() <= data.serverNow.getTime();
	}

	function openPurgeDialog(item: PageData['items'][number]) {
		pendingPurge = item;
		purgeDialog?.showModal();
	}

	function closePurgeDialog() {
		purgeDialog?.close();
	}

	function clearPurgeDialog() {
		pendingPurge = null;
	}
</script>

<svelte:head>
	<title>{t('Expense trash')} | Expense Manager</title>
</svelte:head>

<section class="page-section trash-page">
	<div class="section-heading trash-heading">
		<div>
			<span class="eyebrow">{t('Recovery')}</span>
			<h2>{t('Expense trash')}</h2>
			<p>{t('Deleted expenses remain recoverable for 30 days.')}</p>
		</div>
		<a class="button secondary" href={resolve('/app/expenses')}>
			<ArrowLeft size={16} />
			<span>{t('Back to expenses')}</span>
		</a>
	</div>

	{#if form?.message}
		<p class="notice danger" role="alert">{form.message}</p>
	{/if}

	{#if data.items.length === 0}
		<div class="panel trash-empty">
			<Trash2 size={28} aria-hidden="true" />
			<h3>{t('Trash is empty')}</h3>
			<p>{t('Deleted expenses will appear here during their recovery period.')}</p>
		</div>
	{:else}
		<div class="trash-list" aria-label={t('Deleted expenses')}>
			{#each data.items as item (item.id)}
				<article class:expired={isExpired(item.trashExpiresAt)} class="panel trash-item">
					<div class="trash-main">
						<div>
							<span class="trash-category">{item.categoryName}</span>
							<h3>{item.description}</h3>
							<p class="trash-amount">
								{formatCents(item.amountCents, item.currency, data.locale)}
							</p>
						</div>
						<div class="trash-dates">
							<span>{t('Deleted {date}', { date: dateTime(item.deletedAt) })}</span>
							<strong>
								{isExpired(item.trashExpiresAt)
									? t('Recovery period expired')
									: t('Permanent deletion {date}', { date: dateTime(item.trashExpiresAt) })}
							</strong>
						</div>
					</div>
					<div class="trash-actions">
						{#if !isExpired(item.trashExpiresAt) && item.canRestore}
							<form method="post" action="?/restore">
								<input type="hidden" name="id" value={item.id} />
								<input type="hidden" name="returnTo" value={data.returnTo} />
								<button class="button primary" type="submit">
									<RotateCcw size={16} />
									<span>{t('Restore')}</span>
								</button>
							</form>
						{:else if isExpired(item.trashExpiresAt) && item.canRestore}
							<button class="button danger" type="button" onclick={() => openPurgeDialog(item)}>
								<Trash2 size={16} />
								<span>{t('Delete permanently')}</span>
							</button>
						{:else}
							<span class="trash-permission"
								>{t('Only workspace managers can recover this expense.')}</span
							>
						{/if}
					</div>
				</article>
			{/each}
		</div>
	{/if}

	{#if data.isCursorPage || (data.hasMore && data.nextCursor)}
		<nav class="pagination-bar" aria-label={t('Pagination')}>
			{#if data.isCursorPage}
				<a class="button secondary" href={resolve('/app/expenses/trash')}>{t('First page')}</a>
			{/if}
			{#if data.hasMore && data.nextCursor}
				<a
					class="button secondary"
					href={resolve(`/app/expenses/trash?cursor=${encodeURIComponent(data.nextCursor)}`)}
				>
					{t('Next page')}
				</a>
			{/if}
		</nav>
	{/if}
</section>

<dialog
	{@attach capturePurgeDialog}
	class="app-dialog"
	aria-labelledby="purge-expense-title"
	onclose={clearPurgeDialog}
>
	{#if pendingPurge}
		<div class="dialog-card">
			<div class="dialog-heading">
				<span class="dialog-icon danger"><Trash2 size={20} /></span>
				<div>
					<h3 id="purge-expense-title">{t('Delete expense permanently?')}</h3>
					<p>{pendingPurge.description}</p>
				</div>
			</div>
			<p class="dialog-muted">{t('This action cannot be undone.')}</p>
			<form method="post" action="?/purge" class="dialog-actions">
				<input type="hidden" name="id" value={pendingPurge.id} />
				<input type="hidden" name="returnTo" value={data.returnTo} />
				<button class="button secondary" type="button" onclick={closePurgeDialog}>
					{t('Cancel')}
				</button>
				<button class="button danger" type="submit">
					<Trash2 size={16} />
					<span>{t('Delete permanently')}</span>
				</button>
			</form>
		</div>
	{/if}
</dialog>

<style>
	.trash-page,
	.trash-list {
		display: grid;
		gap: 1rem;
	}

	.trash-heading p,
	.trash-empty p {
		margin: 0.35rem 0 0;
		color: var(--color-muted);
	}

	.trash-empty {
		display: grid;
		justify-items: center;
		gap: 0.45rem;
		padding: 2.5rem 1rem;
		text-align: center;
		color: var(--color-muted);
	}

	.trash-empty h3 {
		margin: 0.25rem 0 0;
		color: var(--color-ink);
	}

	.trash-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 1rem;
		border-left: 4px solid var(--color-warning);
	}

	.trash-item.expired {
		border-left-color: var(--color-danger);
	}

	.trash-main {
		display: grid;
		min-width: 0;
		grid-template-columns: minmax(12rem, 1fr) minmax(12rem, auto);
		align-items: center;
		gap: 1.25rem;
		flex: 1;
	}

	.trash-main h3,
	.trash-amount {
		margin: 0.2rem 0 0;
	}

	.trash-category {
		color: var(--color-muted);
		font-size: 0.78rem;
		font-weight: 800;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.trash-amount {
		font-weight: 850;
	}

	.trash-dates {
		display: grid;
		gap: 0.25rem;
		color: var(--color-muted);
		font-size: 0.85rem;
	}

	.trash-dates strong {
		color: var(--color-ink-soft);
	}

	.trash-actions,
	.trash-actions form {
		display: flex;
	}

	.trash-permission {
		max-width: 14rem;
		color: var(--color-muted);
		font-size: 0.82rem;
		font-weight: 700;
		text-align: right;
	}

	.pagination-bar {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	@media (max-width: 720px) {
		.trash-heading,
		.trash-item,
		.trash-main {
			align-items: stretch;
			grid-template-columns: 1fr;
		}

		.trash-item {
			display: grid;
		}

		.trash-actions .button,
		.trash-actions form {
			width: 100%;
		}

		.trash-permission {
			max-width: none;
			text-align: left;
		}
	}
</style>
