<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { LoaderCircle, Paperclip, Trash2 } from '@lucide/svelte';
	import { maxAttachmentBytes } from '$lib/attachment-limits';
	import type { SubmitFunction } from '@sveltejs/kit';

	type AttachmentItem = {
		id: number;
		originalName: string;
	};

	type UploadState = {
		tone: 'info' | 'danger';
		stage: 'compressing' | 'uploading' | 'error';
		message: string;
	};

	type Props = {
		expenseId: number;
		attachments: AttachmentItem[];
		returnTo: string;
		t: (key: string, params?: Record<string, string | number | null | undefined>) => string;
	};

	let { expenseId, attachments, returnTo, t }: Props = $props();
	let uploadState: UploadState | null = $state(null);

	function actionMessage(value: unknown) {
		if (typeof value !== 'object' || value == null) return null;
		const data = value as { message?: string };
		return typeof data.message === 'string' ? data.message : null;
	}

	const enhanceUpload: SubmitFunction = async ({ formData, controller, cancel }) => {
		const file = formData.get('attachment');
		if (!(file instanceof File) || file.size === 0) return;

		uploadState = {
			tone: 'info',
			stage: 'uploading',
			message: t('Uploading attachment...')
		};

		if (file.type.toLowerCase().startsWith('image/')) {
			uploadState = {
				tone: 'info',
				stage: 'compressing',
				message: t('Compressing image...')
			};

			try {
				const {
					compressImageAttachment,
					formatFileSize,
					isCompressibleImage,
					maxImageAttachmentBytes
				} = await import('$lib/client/image-compression');

				if (isCompressibleImage(file)) {
					const compressed = await compressImageAttachment(file, { signal: controller.signal });
					if (controller.signal.aborted) return;

					if (compressed.file.size > maxImageAttachmentBytes) {
						cancel();
						uploadState = {
							tone: 'danger',
							stage: 'error',
							message: t('Image is still larger than 2 MB after compression.')
						};
						return;
					}

					if (compressed.compressed) {
						formData.set('attachment', compressed.file, compressed.file.name);
						uploadState = {
							tone: 'info',
							stage: 'uploading',
							message: t('Image compressed from {from} to {to}.', {
								from: formatFileSize(compressed.originalSize),
								to: formatFileSize(compressed.compressedSize)
							})
						};
					}
				}
			} catch {
				if (controller.signal.aborted) return;
				if (file.size > maxAttachmentBytes) {
					cancel();
					uploadState = {
						tone: 'danger',
						stage: 'error',
						message: t('Could not compress image. Try a smaller file.')
					};
					return;
				}
			}
		}

		if (uploadState?.stage !== 'uploading') {
			uploadState = {
				tone: 'info',
				stage: 'uploading',
				message: t('Uploading attachment...')
			};
		}

		return async ({ result, update }) => {
			if (result.type === 'failure') {
				uploadState = {
					tone: 'danger',
					stage: 'error',
					message: actionMessage(result.data) ?? t('Invalid attachment.')
				};
				await update({ reset: false, invalidateAll: false });
				return;
			}

			if (result.type === 'error') {
				uploadState = {
					tone: 'danger',
					stage: 'error',
					message: t('Something went wrong.')
				};
				return;
			}

			uploadState = null;
			await update({ reset: true, invalidateAll: true });
		};
	};

	function isUploadInProgress(state: UploadState | null) {
		return state?.stage === 'compressing' || state?.stage === 'uploading';
	}

	let uploadInProgress = $derived(isUploadInProgress(uploadState));
</script>

<div class="attachment-panel">
	<div class="attachment-list">
		{#each attachments as attachment (attachment.id)}
			<div class="attachment-chip-row">
				<a class="attachment-chip" href={resolve(`/app/expenses/attachments/${attachment.id}`)}>
					<Paperclip size={15} />
					<span>{attachment.originalName}</span>
				</a>
				<form
					method="post"
					action="?/deleteAttachment"
					onsubmit={(event) => {
						if (!window.confirm(t('Delete attachment?'))) event.preventDefault();
					}}
				>
					<input type="hidden" name="id" value={attachment.id} />
					<input type="hidden" name="returnTo" value={returnTo} />
					<button
						class="icon-button danger"
						type="submit"
						aria-label={`${t('Delete')} ${attachment.originalName}`}
					>
						<Trash2 size={14} />
					</button>
				</form>
			</div>
		{:else}
			<span class="empty">{t('No attachments added.')}</span>
		{/each}
	</div>
	<form
		method="post"
		action="?/attach"
		enctype="multipart/form-data"
		class="attachment-form"
		use:enhance={enhanceUpload}
	>
		<input type="hidden" name="id" value={expenseId} />
		<input type="hidden" name="returnTo" value={returnTo} />
		<input
			name="attachment"
			type="file"
			accept="application/pdf,image/png,image/jpeg,image/webp,text/plain"
			aria-label={t('Receipt')}
			disabled={uploadInProgress}
			onchange={() => (uploadState = null)}
		/>
		<button class="button secondary" type="submit" disabled={uploadInProgress}>
			{#if uploadInProgress}
				<LoaderCircle class="attachment-progress-spinner" size={16} />
			{:else}
				<Paperclip size={16} />
			{/if}
			<span>{uploadState?.stage === 'compressing' ? t('Compressing image...') : t('Attach')}</span>
		</button>
		{#if uploadState}
			<p
				class={['attachment-status', uploadState.tone]}
				role={uploadState.tone === 'danger' ? 'alert' : 'status'}
				aria-live="polite"
			>
				{#if uploadInProgress}
					<LoaderCircle class="attachment-progress-spinner" size={15} />
				{/if}
				<span>{uploadState.message}</span>
			</p>
		{/if}
	</form>
</div>
