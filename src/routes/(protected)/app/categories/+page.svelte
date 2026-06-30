<script lang="ts">
	import { categoryEmojiLabels, categoryEmojiValues } from '$lib/category-emojis';
	import type { ActionData, PageData } from './$types';

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const activeCategories = $derived(data.categories.filter(isActiveCategory));

	function isActiveCategory(category: PageData['categories'][number]) {
		return !category.isArchived;
	}

	function ruleTargetLabel(value: string) {
		if (value === 'vendor') return 'Fornecedor';
		if (value === 'payment') return 'Pagamento';
		return 'Descricao';
	}
</script>

<svelte:head>
	<title>Categorias | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">Organizacao</span>
			<h2>Categorias</h2>
		</div>
	</div>

	{#if form?.message}
		<p class="notice danger">{form.message}</p>
	{/if}

	<div class="content-grid two">
		<section class="panel">
			<div class="panel-heading">
				<h3>Nova categoria</h3>
			</div>
			<form method="post" action="?/create" class="stack">
				<label>
					<span>Nome</span>
					<input name="name" required maxlength="80" />
				</label>
				<label>
					<span>Cor</span>
					<input class="color-picker" name="color" type="color" value="#2563eb" required />
				</label>
				<label>
					<span>Emoji</span>
					<select name="icon" required>
						{#each categoryEmojiValues as emoji (emoji)}
							<option value={emoji}>{emoji} {categoryEmojiLabels[emoji]}</option>
						{/each}
					</select>
				</label>
				<button class="button primary" type="submit">Criar</button>
			</form>
		</section>

		<section class="panel">
			<div class="panel-heading">
				<h3>Lista</h3>
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
								aria-label="Cor"
							/>
							<input name="name" value={category.name} required />
							<select name="icon" aria-label="Emoji">
								{#each categoryEmojiValues as emoji (emoji)}
									<option value={emoji} selected={(category.icon ?? '💼') === emoji}
										>{emoji} {categoryEmojiLabels[emoji]}</option
									>
								{/each}
							</select>
							<button class="button secondary" type="submit">Salvar</button>
						</form>
						{#if !category.isArchived}
							<form method="post" action="?/archive">
								<input type="hidden" name="id" value={category.id} />
								<button class="text-button danger" type="submit">Arquivar</button>
							</form>
						{/if}
					</article>
				{/each}
			</div>
		</section>
	</div>

	<section class="panel">
		<div class="panel-heading">
			<h3>Regras automaticas</h3>
		</div>
		<form method="post" action="?/createRule" class="form-grid compact">
			<label>
				<span>Nome</span>
				<input name="name" required maxlength="80" />
			</label>
			<label>
				<span>Categoria</span>
				<select name="categoryId" required>
					{#each activeCategories as category (category.id)}
						<option value={category.id}>{category.icon ?? '💼'} {category.name}</option>
					{/each}
				</select>
			</label>
			<label>
				<span>Campo</span>
				<select name="matchTarget">
					<option value="description">Descricao</option>
					<option value="vendor">Fornecedor</option>
					<option value="payment">Pagamento</option>
				</select>
			</label>
			<label>
				<span>Contem</span>
				<input name="pattern" required maxlength="120" />
			</label>
			<label>
				<span>Prioridade</span>
				<input name="priority" type="number" min="1" max="1000" value="100" required />
			</label>
			<button class="button primary align-end" type="submit">Criar regra</button>
		</form>

		<div class="category-list">
			{#each data.categoryRules as rule (rule.id)}
				<article class:muted={!rule.isActive} class="category-item">
					<div class="rule-summary">
						<strong>{rule.name}</strong>
						<span>
							{ruleTargetLabel(rule.matchTarget)} contem "{rule.pattern}" -> {rule.categoryIcon ??
								'💼'}
							{rule.categoryName}
						</span>
					</div>
					<span class="role-pill">#{rule.priority}</span>
					{#if rule.isActive}
						<form method="post" action="?/archiveRule">
							<input type="hidden" name="id" value={rule.id} />
							<button class="text-button danger" type="submit">Arquivar</button>
						</form>
					{/if}
				</article>
			{:else}
				<p class="empty">Nenhuma regra criada.</p>
			{/each}
		</div>
	</section>
</section>
