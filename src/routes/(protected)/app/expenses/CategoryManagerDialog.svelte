<script lang="ts">
	import { enhance } from '$app/forms';
	import {
		Archive,
		ArchiveRestore,
		ChevronLeft,
		ChevronRight,
		Plus,
		Save,
		Search,
		Trash2
	} from '@lucide/svelte';
	import { categoryEmojiLabels, categoryEmojiValues } from '$lib/category-emojis';
	import type { SubmitFunction } from '@sveltejs/kit';

	type CategoryItem = {
		id: number;
		name: string;
		color: string;
		icon: string | null;
		isArchived: boolean;
		associationCount: number;
	};

	type Props = {
		active: boolean;
		categories: CategoryItem[];
		returnTo: string;
		locale: string;
		onRefresh?: () => void | Promise<void>;
		t: (key: string, params?: Record<string, string | number | null | undefined>) => string;
	};

	let { active, categories, returnTo, locale, onRefresh, t }: Props = $props();
	const pageSize = 8;
	let search = $state('');
	let page = $state(1);
	let view = $state<'active' | 'archived'>('active');
	let notice = $state<{ tone: 'success' | 'danger'; message: string } | null>(null);
	let creating = $state(false);

	let activeCategories = $derived(categories.filter((category) => !category.isArchived));
	let archivedCategoryCount = $derived(categories.length - activeCategories.length);
	let visibleCategories = $derived(
		categories.filter((category) =>
			view === 'archived' ? category.isArchived : !category.isArchived
		)
	);
	let query = $derived(search.trim().toLocaleLowerCase(locale));
	let filteredCategories = $derived.by(() => {
		if (!query) return visibleCategories;
		return visibleCategories.filter((category) =>
			category.name.toLocaleLowerCase(locale).includes(query)
		);
	});
	let pageCount = $derived(Math.max(1, Math.ceil(filteredCategories.length / pageSize)));
	let activePage = $derived(Math.min(page, pageCount));
	let paginatedCategories = $derived(
		filteredCategories.slice((activePage - 1) * pageSize, activePage * pageSize)
	);
	let resultStart = $derived(filteredCategories.length === 0 ? 0 : (activePage - 1) * pageSize + 1);
	let resultEnd = $derived(Math.min(filteredCategories.length, activePage * pageSize));

	export function clearNotice() {
		notice = null;
	}

	function lower(value: string) {
		return value.toLocaleLowerCase(locale);
	}

	function hasAssociations(category: CategoryItem) {
		return category.associationCount > 0;
	}

	function removeLabel(category: CategoryItem) {
		return hasAssociations(category) ? t('Archive') : t('Delete');
	}

	function removeAriaLabel(category: CategoryItem) {
		return `${hasAssociations(category) ? t('Archive category') : t('Delete category')} ${category.name}`;
	}

	function emojiLabel(emoji: (typeof categoryEmojiValues)[number]) {
		return t(categoryEmojiLabels[emoji]);
	}

	function categoryActionData(value: unknown) {
		if (typeof value !== 'object' || value == null) return null;
		const data = value as {
			message?: string;
			categoryAction?: 'createCategory' | 'updateCategory' | 'removeCategory' | 'unarchiveCategory';
			categoryMessage?: string;
		};
		return data.categoryAction ? data : null;
	}

	function enhanceCategoryAction(resetOnSuccess: boolean): SubmitFunction {
		return () => {
			if (resetOnSuccess) creating = true;
			notice = null;

			return async ({ result, update }) => {
				if (resetOnSuccess) creating = false;

				if (result.type === 'success') {
					const data = categoryActionData(result.data);
					await update({ reset: resetOnSuccess, invalidateAll: true });
					await onRefresh?.();
					if (resetOnSuccess) {
						search = '';
						page = 1;
					}
					notice = {
						tone: 'success',
						message:
							data?.categoryMessage ??
							(resetOnSuccess
								? t('Category created successfully.')
								: t('Category updated successfully.'))
					};
					return;
				}

				if (result.type === 'failure') {
					const data = categoryActionData(result.data);
					await update({ reset: false, invalidateAll: false });
					notice = {
						tone: 'danger',
						message: data?.categoryMessage ?? data?.message ?? t('Check category data.')
					};
					return;
				}

				if (result.type === 'error') {
					notice = { tone: 'danger', message: t('Could not save the category.') };
					return;
				}

				await update({ reset: false, invalidateAll: false });
			};
		};
	}

	const enhanceCreate = enhanceCategoryAction(true);
	const enhanceMutation = enhanceCategoryAction(false);
</script>

{#if active}
	<form
		method="post"
		action="?/createCategory"
		class="support-catalog-form support-catalog-create-form support-catalog-category-form"
		use:enhance={enhanceCreate}
	>
		<input type="hidden" name="returnTo" value={returnTo} />
		<label>
			<span>{t('Color')}</span>
			<input
				class="color-picker compact"
				name="color"
				type="color"
				value="#2563eb"
				aria-label={t('Color')}
				required
			/>
		</label>
		<label>
			<span>{t('New category')}</span>
			<input name="name" required minlength="2" maxlength="80" placeholder={t('New category')} />
		</label>
		<label>
			<span>{t('Emoji')}</span>
			<select name="icon" aria-label={t('Emoji')} required>
				{#each categoryEmojiValues as emoji (emoji)}
					<option value={emoji}>{emoji} {emojiLabel(emoji)}</option>
				{/each}
			</select>
		</label>
		<button class="button secondary" type="submit" disabled={creating}>
			<Plus size={16} />
			<span>{t('Create')}</span>
		</button>
	</form>

	{#if notice}
		<p class={`notice ${notice.tone}`} role={notice.tone === 'danger' ? 'alert' : 'status'}>
			{notice.message}
		</p>
	{/if}

	<div class="support-catalog-view-toggle" role="group" aria-label={t('Category status')}>
		<button
			class="support-catalog-view-option"
			type="button"
			aria-pressed={view === 'active'}
			onclick={() => {
				view = 'active';
				page = 1;
			}}
		>
			<span>{t('Active categories')}</span>
			<strong>{activeCategories.length}</strong>
		</button>
		<button
			class="support-catalog-view-option"
			type="button"
			aria-pressed={view === 'archived'}
			onclick={() => {
				view = 'archived';
				page = 1;
			}}
		>
			<span>{t('Archived categories')}</span>
			<strong>{archivedCategoryCount}</strong>
		</button>
	</div>

	<div class="support-catalog-toolbar">
		<label class="support-catalog-search">
			<span>{t('Search {item}', { item: lower(t('Category')) })}</span>
			<div class="input-with-icon">
				<Search size={16} />
				<input
					value={search}
					placeholder={t('Search in {collection}', { collection: lower(t('Categories')) })}
					aria-label={t('Search {item}', { item: lower(t('Category')) })}
					oninput={(event) => {
						search = event.currentTarget.value;
						page = 1;
					}}
				/>
			</div>
		</label>
		<div class="support-catalog-page-size" aria-label={t('Items per page')}>
			<span>{t('Display')}</span>
			<strong>{t('{pageSize} per page', { pageSize })}</strong>
		</div>
	</div>

	<div class="support-catalog-list-heading">
		<strong>{view === 'archived' ? t('Archived categories') : t('Categories')}</strong>
		<span
			>{t('{start}-{end} of {total}', {
				start: resultStart,
				end: resultEnd,
				total: filteredCategories.length
			})}</span
		>
	</div>

	<div class="support-catalog-list">
		{#each paginatedCategories as category (category.id)}
			<div class={['support-catalog-row', category.isArchived && 'muted']}>
				<form
					method="post"
					action="?/updateCategory"
					class="support-catalog-edit-form support-catalog-category-edit"
					use:enhance={enhanceMutation}
				>
					<input type="hidden" name="returnTo" value={returnTo} />
					<input type="hidden" name="id" value={category.id} />
					<label>
						<span>{t('Color')}</span>
						<input
							class="color-picker compact"
							name="color"
							type="color"
							value={category.color}
							aria-label={`${t('Color')} ${category.name}`}
						/>
					</label>
					<label>
						<span>{t('Category name')}</span>
						<input
							name="name"
							value={category.name}
							required
							minlength="2"
							maxlength="80"
							aria-label={`${t('Edit')} ${lower(t('Category'))} ${category.name}`}
						/>
					</label>
					<label>
						<span>{t('Emoji')}</span>
						<select name="icon" aria-label={`${t('Emoji')} ${category.name}`}>
							{#each categoryEmojiValues as emoji (emoji)}
								<option value={emoji} selected={(category.icon ?? '💼') === emoji}>
									{emoji}
									{emojiLabel(emoji)}
								</option>
							{/each}
						</select>
					</label>
					<button class="button secondary" type="submit">
						<Save size={15} />
						<span>{t('Save')}</span>
					</button>
				</form>
				{#if category.isArchived}
					<form
						method="post"
						action="?/unarchiveCategory"
						class="support-catalog-remove-form"
						use:enhance={enhanceMutation}
					>
						<input type="hidden" name="returnTo" value={returnTo} />
						<input type="hidden" name="id" value={category.id} />
						<button
							class="button secondary"
							type="submit"
							aria-label={`${t('Restore category')} ${category.name}`}
						>
							<ArchiveRestore size={15} />
							<span>{t('Restore')}</span>
						</button>
					</form>
				{:else}
					<form
						method="post"
						action="?/removeCategory"
						class="support-catalog-remove-form"
						use:enhance={enhanceMutation}
					>
						<input type="hidden" name="returnTo" value={returnTo} />
						<input type="hidden" name="id" value={category.id} />
						<button
							class="button secondary danger"
							type="submit"
							aria-label={removeAriaLabel(category)}
						>
							{#if hasAssociations(category)}
								<Archive size={15} />
							{:else}
								<Trash2 size={15} />
							{/if}
							<span>{removeLabel(category)}</span>
						</button>
					</form>
				{/if}
			</div>
		{:else}
			<p class="support-catalog-empty">
				{query
					? t('No search results.')
					: view === 'archived'
						? t('No archived category found.')
						: t('No category found.')}
			</p>
		{/each}
	</div>

	{#if pageCount > 1}
		<div class="support-catalog-pagination">
			<button
				class="button secondary"
				type="button"
				disabled={activePage === 1}
				aria-label={t('Previous page of {items}', { items: lower(t('Categories')) })}
				onclick={() => (page = Math.min(Math.max(page - 1, 1), pageCount))}
			>
				<ChevronLeft size={16} />
				<span>{t('Previous')}</span>
			</button>
			<span>{t('Page {page} of {count}', { page: activePage, count: pageCount })}</span>
			<button
				class="button secondary"
				type="button"
				disabled={activePage === pageCount}
				aria-label={t('Next page of {items}', { items: lower(t('Categories')) })}
				onclick={() => (page = Math.min(Math.max(page + 1, 1), pageCount))}
			>
				<span>{t('Next')}</span>
				<ChevronRight size={16} />
			</button>
		</div>
	{/if}
{/if}
