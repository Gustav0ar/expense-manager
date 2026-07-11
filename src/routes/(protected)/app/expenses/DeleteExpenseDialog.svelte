<script lang="ts">
	import { Trash2 } from '@lucide/svelte';
	import type { Attachment } from 'svelte/attachments';

	type PendingDelete = { id: number; description: string; amount: string } | null;

	type Props = {
		returnTo: string;
		t: (key: string, params?: Record<string, string | number | null | undefined>) => string;
	};

	let { returnTo, t }: Props = $props();

	let dialogEl: HTMLDialogElement | undefined = $state();
	let pendingDelete: PendingDelete = $state(null);

	const captureDialog: Attachment<HTMLDialogElement> = (element) => {
		dialogEl = element;
		return () => {
			if (dialogEl === element) dialogEl = undefined;
		};
	};

	export function open(expense: { id: number; description: string; amount: string }) {
		pendingDelete = expense;
		if (!dialogEl?.open) dialogEl?.showModal();
	}

	function close() {
		dialogEl?.close();
	}

	function clearOnClose() {
		pendingDelete = null;
	}

	function closeFromBackdrop(event: MouseEvent) {
		if (event.target === dialogEl) close();
	}
</script>

<dialog
	{@attach captureDialog}
	class="app-dialog"
	aria-labelledby="delete-expense-title"
	onclick={closeFromBackdrop}
	onclose={clearOnClose}
>
	{#if pendingDelete}
		<div class="dialog-card">
			<div class="dialog-heading">
				<span class="dialog-icon danger">
					<Trash2 size={20} />
				</span>
				<div>
					<h3 id="delete-expense-title">{t('Delete expense?')}</h3>
					<p>
						{pendingDelete.description}
						<span>{pendingDelete.amount}</span>
					</p>
				</div>
			</div>

			<p class="dialog-muted">
				{t('The expense will move to trash and remain recoverable for 30 days.')}
			</p>

			<form method="post" action="?/delete" class="dialog-actions">
				<input type="hidden" name="id" value={pendingDelete.id} />
				<input type="hidden" name="returnTo" value={returnTo} />
				<button class="button secondary" type="button" onclick={close}>{t('Cancel')}</button>
				<button class="button danger" type="submit">
					<Trash2 size={17} />
					<span>{t('Delete')}</span>
				</button>
			</form>
		</div>
	{/if}
</dialog>
