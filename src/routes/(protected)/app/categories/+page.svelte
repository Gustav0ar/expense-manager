<script lang="ts">
	import { categoryEmojiLabels, categoryEmojiValues } from '$lib/category-emojis';
	import { translate } from '$lib/i18n';
	import { Archive, ArchiveRestore, Trash2 } from '@lucide/svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const activeCategories = $derived(data.categories.filter(isActiveCategory));

	function isActiveCategory(category: PageData['categories'][number]) {
		return !category.isArchived;
	}

	function categoryHasAssociations(category: PageData['categories'][number]) {
		return category.associationCount > 0;
	}

	function categoryRemoveLabel(category: PageData['categories'][number]) {
		return categoryHasAssociations(category) ? t('Archive') : t('Delete');
	}

	function categoryRemoveAriaLabel(category: PageData['categories'][number]) {
		return `${categoryHasAssociations(category) ? t('Archive category') : t('Delete category')} ${category.name}`;
	}

	function ruleTargetLabel(value: string) {
		if (value === 'vendor') return t('Vendor');
		if (value === 'payment') return t('Payment');
		return t('Description');
	}

	function t(key: string, params?: Record<string, string | number | null | undefined>) {
		return translate(data.locale, key, params);
	}

	function emojiLabel(emoji: (typeof categoryEmojiValues)[number]) {
		return t(categoryEmojiLabels[emoji]);
	}
</script>

<svelte:head>
	<title>{t('Categories')} | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">{t('Organization')}</span>
			<h2>{t('Categories')}</h2>
		</div>
	</div>

	{#if form?.message}
		<p class="notice danger" role="alert">{form.message}</p>
	{/if}

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>{t('New category')}</h3>
			</div>
			<form method="post" action="?/create" class="stack">
				<label>
					<span>{t('Name')}</span>
					<input name="name" required maxlength="80" />
				</label>
				<label>
					<span>{t('Color')}</span>
					<input class="color-picker" name="color" type="color" value="#2563eb" required />
				</label>
				<label>
					<span>{t('Emoji')}</span>
					<select name="icon" required>
						{#each categoryEmojiValues as emoji (emoji)}
							<option value={emoji}>{emoji} {emojiLabel(emoji)}</option>
						{/each}
					</select>
				</label>
				<button class="button primary" type="submit">{t('Create')}</button>
			</form>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>{t('List')}</h3>
			</div>
			<div class="category-list">
				{#each data.categories as category (category.id)}
					<article class:muted={category.isArchived} class="category-item">
						<form method="post" action="?/update" class="category-edit">
							<input type="hidden" name="id" value={category.id} />
							<input
								class="color-picker compact"
								name="color"
								type="color"
								value={category.color}
								aria-label={t('Color')}
							/>
							<input name="name" value={category.name} aria-label={t('Category name')} required />
							<select name="icon" aria-label={t('Emoji')}>
								{#each categoryEmojiValues as emoji (emoji)}
									<option value={emoji} selected={(category.icon ?? '💼') === emoji}
										>{emoji} {emojiLabel(emoji)}</option
									>
								{/each}
							</select>
							<button class="button secondary" type="submit">{t('Save')}</button>
						</form>
						{#if category.isArchived}
							<form method="post" action="?/unarchive">
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
							<form method="post" action="?/remove">
								<input type="hidden" name="id" value={category.id} />
								<button
									class="button secondary danger"
									type="submit"
									aria-label={categoryRemoveAriaLabel(category)}
								>
									{#if categoryHasAssociations(category)}
										<Archive size={15} />
									{:else}
										<Trash2 size={15} />
									{/if}
									<span>{categoryRemoveLabel(category)}</span>
								</button>
							</form>
						{/if}
					</article>
				{/each}
			</div>
		</section>
	</div>

	<section class="panel">
		<div class="panel-heading">
			<h3>{t('Automatic rules')}</h3>
		</div>
		<form method="post" action="?/createRule" class="form-grid compact">
			<label>
				<span>{t('Name')}</span>
				<input name="name" required maxlength="80" />
			</label>
			<label>
				<span>{t('Category')}</span>
				<select name="categoryId" required>
					{#each activeCategories as category (category.id)}
						<option value={category.id}>{category.icon ?? '💼'} {category.name}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>{t('Field')}</span>
				<select name="matchTarget">
					<option value="description">{t('Description')}</option>
					<option value="vendor">{t('Vendor')}</option>
					<option value="payment">{t('Payment')}</option>
				</select>
			</label>
			<label>
				<span>{t('Contains')}</span>
				<input name="pattern" required maxlength="120" />
			</label>
			<label>
				<span>{t('Priority')}</span>
				<input name="priority" type="number" min="1" max="1000" value="100" required />
			</label>
			<button class="button primary align-end" type="submit">{t('Create rule')}</button>
		</form>

		<div class="category-list">
			{#each data.categoryRules as rule (rule.id)}
				<article class:muted={!rule.isActive} class="category-item">
					<div class="rule-summary">
						<strong>{rule.name}</strong>
						<span>
							{ruleTargetLabel(rule.matchTarget)}
							{t('contains')} "{rule.pattern}" -> {rule.categoryIcon ?? '💼'}
							{rule.categoryName}
						</span>
					</div>
					<span class="role-pill">#{rule.priority}</span>
					{#if rule.isActive}
						<form method="post" action="?/archiveRule">
							<input type="hidden" name="id" value={rule.id} />
							<button class="text-button danger" type="submit">{t('Archive')}</button>
						</form>
					{/if}
				</article>
			{:else}
				<p class="empty">{t('No rule created.')}</p>
			{/each}
		</div>
	</section>
</section>
