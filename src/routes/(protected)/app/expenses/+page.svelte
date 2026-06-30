<script lang="ts">
	import { resolve } from '$app/paths';
	import LocalizedDate from '$lib/components/LocalizedDate.svelte';
	import { formatCents } from '$lib/utils/format';
	import {
		CheckCircle2,
		ChevronLeft,
		ChevronRight,
		CreditCard,
		Paperclip,
		Pencil,
		Plus,
		RotateCcw,
		Search,
		Save,
		Trash2,
		XCircle
	} from '@lucide/svelte';
	import type { Attachment } from 'svelte/attachments';
	import type { ActionData, PageData } from './$types';

	type SupportCatalogKind = 'paymentMethod' | 'vendor' | 'costCenter';
	type SupportCatalogItem = PageData['catalogs']['paymentMethods'][number];

	let { data, form } = $props<{ data: PageData; form: ActionData }>();
	const expensesPath = resolve('/app/expenses');
	const supportCatalogPageSize = 8;
	const supportCatalogTabs = [
		{
			kind: 'paymentMethod',
			label: 'Pagamentos',
			singular: 'pagamento',
			createLabel: 'Novo pagamento',
			placeholder: 'Pix',
			maxLength: 80,
			empty: 'Nenhum pagamento cadastrado.'
		},
		{
			kind: 'vendor',
			label: 'Fornecedores',
			singular: 'fornecedor',
			createLabel: 'Novo fornecedor',
			placeholder: 'ACME Servicos',
			maxLength: 120,
			empty: 'Nenhum fornecedor cadastrado.'
		},
		{
			kind: 'costCenter',
			label: 'Centros de custo',
			singular: 'centro de custo',
			createLabel: 'Novo centro de custo',
			placeholder: 'Operacao',
			maxLength: 120,
			empty: 'Nenhum centro de custo cadastrado.'
		}
	] satisfies Array<{
		kind: SupportCatalogKind;
		label: string;
		singular: string;
		createLabel: string;
		placeholder: string;
		maxLength: number;
		empty: string;
	}>;

	let deleteDialog: HTMLDialogElement | undefined = $state();
	let supportCatalogDialog: HTMLDialogElement | undefined = $state();
	let pendingDelete = $state<{ id: number; description: string; amount: string } | null>(null);
	let preparedExpenseDetails = $state<number[]>([]);
	let supportCatalogTab = $state<SupportCatalogKind>('paymentMethod');
	let supportCatalogSearch = $state<Record<SupportCatalogKind, string>>({
		paymentMethod: '',
		vendor: '',
		costCenter: ''
	});
	let supportCatalogPage = $state<Record<SupportCatalogKind, number>>({
		paymentMethod: 1,
		vendor: 1,
		costCenter: 1
	});
	let activeCatalogMeta = $derived(
		supportCatalogTabs.find((tab) => tab.kind === supportCatalogTab) ?? supportCatalogTabs[0]
	);
	let activeCatalogItems = $derived(catalogItems(supportCatalogTab));
	let activeCatalogQuery = $derived(
		supportCatalogSearch[supportCatalogTab].trim().toLocaleLowerCase('pt-BR')
	);
	let filteredSupportCatalogItems = $derived.by(() => {
		if (!activeCatalogQuery) return activeCatalogItems;
		return activeCatalogItems.filter((item) =>
			item.name.toLocaleLowerCase('pt-BR').includes(activeCatalogQuery)
		);
	});
	let supportCatalogPageCount = $derived(
		Math.max(1, Math.ceil(filteredSupportCatalogItems.length / supportCatalogPageSize))
	);
	let activeSupportCatalogPage = $derived(
		Math.min(supportCatalogPage[supportCatalogTab], supportCatalogPageCount)
	);
	let paginatedSupportCatalogItems = $derived(
		filteredSupportCatalogItems.slice(
			(activeSupportCatalogPage - 1) * supportCatalogPageSize,
			activeSupportCatalogPage * supportCatalogPageSize
		)
	);
	let supportCatalogResultStart = $derived(
		filteredSupportCatalogItems.length === 0
			? 0
			: (activeSupportCatalogPage - 1) * supportCatalogPageSize + 1
	);
	let supportCatalogResultEnd = $derived(
		Math.min(filteredSupportCatalogItems.length, activeSupportCatalogPage * supportCatalogPageSize)
	);
	const captureDeleteDialog: Attachment<HTMLDialogElement> = (element) => {
		deleteDialog = element;
		return () => {
			if (deleteDialog === element) deleteDialog = undefined;
		};
	};
	const captureSupportCatalogDialog: Attachment<HTMLDialogElement> = (element) => {
		supportCatalogDialog = element;
		return () => {
			if (supportCatalogDialog === element) supportCatalogDialog = undefined;
		};
	};

	function prepareExpenseDetails(id: number, event: Event) {
		const details = event.currentTarget as HTMLDetailsElement;
		if (!details.open || preparedExpenseDetails.includes(id)) return;
		preparedExpenseDetails = [...preparedExpenseDetails, id];
	}

	function hasPreparedExpenseDetails(id: number) {
		return preparedExpenseDetails.includes(id);
	}

	function amountInputValue(cents: number) {
		return (cents / 100).toFixed(2).replace('.', ',');
	}

	function hasActiveFilters() {
		return Boolean(
			data.filters.from ||
			data.filters.to ||
			data.filters.categoryId ||
			data.filters.reviewStatus ||
			data.filters.paymentStatus ||
			data.filters.q
		);
	}

	function reviewLabel(value: string) {
		if (value === 'pending') return 'Pendente';
		if (value === 'rejected') return 'Rejeitada';
		return 'Aprovada';
	}

	function reviewClass(value: string) {
		if (value === 'pending') return 'status-pill warning';
		if (value === 'rejected') return 'status-pill danger';
		return 'status-pill success';
	}

	function paymentLabel(value: string) {
		if (value === 'paid') return 'Paga';
		if (value === 'reconciled') return 'Conciliada';
		return 'Aberta';
	}

	function paymentClass(value: string) {
		if (value === 'paid') return 'status-pill info';
		if (value === 'reconciled') return 'status-pill success';
		return 'status-pill neutral';
	}

	function openDeleteDialog(expense: PageData['expenses']['items'][number]) {
		pendingDelete = {
			id: expense.id,
			description: expense.description,
			amount: formatCents(expense.amountCents)
		};

		if (!deleteDialog?.open) deleteDialog?.showModal();
	}

	function closeDeleteDialog() {
		deleteDialog?.close();
	}

	function openSupportCatalogDialog() {
		if (!supportCatalogDialog?.open) supportCatalogDialog?.showModal();
	}

	function closeSupportCatalogDialog() {
		supportCatalogDialog?.close();
	}

	function clearDeleteDialog() {
		pendingDelete = null;
	}

	function nextPageHref() {
		const params: string[] = [];
		const addParam = (key: string, value: string | number) => {
			params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
		};

		if (data.filters.from) addParam('from', data.filters.from);
		if (data.filters.to) addParam('to', data.filters.to);
		if (data.filters.categoryId) addParam('categoryId', data.filters.categoryId);
		if (data.filters.reviewStatus) addParam('reviewStatus', data.filters.reviewStatus);
		if (data.filters.paymentStatus) addParam('paymentStatus', data.filters.paymentStatus);
		if (data.filters.q) addParam('q', data.filters.q);
		if (data.expenses.nextCursor) addParam('cursor', data.expenses.nextCursor);
		const query = params.join('&');
		return query ? `${expensesPath}?${query}` : expensesPath;
	}

	function closeDeleteDialogFromBackdrop(event: MouseEvent) {
		if (event.target === deleteDialog) closeDeleteDialog();
	}

	function closeSupportCatalogDialogFromBackdrop(event: MouseEvent) {
		if (event.target === supportCatalogDialog) closeSupportCatalogDialog();
	}

	function catalogUsageLabel(item: PageData['catalogs']['paymentMethods'][number]) {
		const expensePart = item.expenseCount === 1 ? '1 despesa' : `${item.expenseCount} despesas`;
		if (item.recurringCount === 0) return item.expenseCount === 0 ? 'Sem uso' : expensePart;

		const recurringPart =
			item.recurringCount === 1 ? '1 recorrencia' : `${item.recurringCount} recorrencias`;
		return item.expenseCount === 0 ? recurringPart : `${expensePart} + ${recurringPart}`;
	}

	function catalogRemoveLabel(item: PageData['catalogs']['paymentMethods'][number]) {
		return item.expenseCount > 0 ? 'Arquivar' : 'Excluir';
	}

	function hasCatalogOption(items: { id: number }[], id?: number | null) {
		return id ? items.some((item) => item.id === id) : false;
	}

	function catalogItems(kind: SupportCatalogKind): SupportCatalogItem[] {
		if (kind === 'paymentMethod') return data.catalogs.paymentMethods;
		if (kind === 'vendor') return data.catalogs.vendors;
		return data.catalogs.costCenters;
	}

	function setSupportCatalogTab(kind: SupportCatalogKind) {
		supportCatalogTab = kind;
	}

	function updateSupportCatalogSearch(kind: SupportCatalogKind, value: string) {
		supportCatalogSearch[kind] = value;
		supportCatalogPage[kind] = 1;
	}

	function goToSupportCatalogPage(page: number) {
		supportCatalogPage[supportCatalogTab] = Math.min(Math.max(page, 1), supportCatalogPageCount);
	}
</script>

<svelte:head>
	<title>Despesas | Expense Manager</title>
</svelte:head>

<section class="page-section">
	<div class="section-heading">
		<div>
			<span class="eyebrow">Lancamentos</span>
			<h2>Despesas</h2>
		</div>
	</div>

	{#if form?.message}
		<p class="notice danger">{form.message}</p>
	{/if}

	<section class="panel expense-create-panel">
		<div class="panel-heading">
			<h3>Nova despesa</h3>
			<button
				class="button secondary support-catalog-trigger"
				type="button"
				onclick={openSupportCatalogDialog}
			>
				<Plus size={16} />
				<span>Cadastros</span>
			</button>
		</div>

		<form method="post" action="?/create" class="form-grid expense-create-form">
			<input type="hidden" name="returnTo" value={data.returnTo} />
			<label class="expense-field description-field">
				<span>Descricao</span>
				<input name="description" required maxlength="160" />
			</label>

			<label class="expense-field amount-field">
				<span>Valor da parcela</span>
				<input name="amount" inputmode="decimal" placeholder="0,00" required />
			</label>

			<label class="expense-field">
				<span>Data</span>
				<input name="expenseDate" type="date" required />
			</label>

			<label class="expense-field">
				<span>Categoria</span>
				<select name="categoryId" required>
					<option value="">Selecione</option>
					{#each data.categories as category (category.id)}
						<option value={category.id}>{category.icon ?? '💼'} {category.name}</option>
					{/each}
				</select>
			</label>

			<label class="expense-field">
				<span>Pagamento</span>
				<select name="paymentMethodId">
					<option value="">Selecione</option>
					{#each data.catalogs.paymentMethods as paymentMethod (paymentMethod.id)}
						<option value={paymentMethod.id}>{paymentMethod.name}</option>
					{/each}
				</select>
			</label>

			<label class="expense-field">
				<span>Fornecedor</span>
				<select name="vendorId">
					<option value="">Selecione</option>
					{#each data.catalogs.vendors as vendor (vendor.id)}
						<option value={vendor.id}>{vendor.name}</option>
					{/each}
				</select>
			</label>

			<label class="expense-field">
				<span>Centro de custo</span>
				<select name="costCenterId">
					<option value="">Selecione</option>
					{#each data.catalogs.costCenters as costCenter (costCenter.id)}
						<option value={costCenter.id}>{costCenter.name}</option>
					{/each}
				</select>
			</label>

			<label class="expense-field">
				<span>Competencia</span>
				<input name="competencyMonth" type="month" />
			</label>

			<label class="expense-field">
				<span>Parcelas</span>
				<input name="installments" type="number" min="1" max="120" value="1" />
			</label>

			<label class="expense-field notes-field">
				<span>Notas</span>
				<input name="notes" maxlength="1000" />
			</label>

			<button class="button primary expense-submit" type="submit">
				<Plus size={18} />
				<span>Adicionar</span>
			</button>
		</form>
	</section>

	<dialog
		{@attach captureSupportCatalogDialog}
		class="app-dialog support-catalog-dialog"
		aria-labelledby="support-catalog-title"
		onclick={closeSupportCatalogDialogFromBackdrop}
	>
		<div class="dialog-card support-catalog-card">
			<div class="dialog-heading">
				<span class="dialog-icon">
					<Plus size={20} />
				</span>
				<div>
					<h3 id="support-catalog-title">Cadastros de apoio</h3>
					<p>Adicione opcoes para pagamento, fornecedor e centro de custo.</p>
				</div>
			</div>

			<div class="support-catalog-summary" aria-label="Totais cadastrados">
				<span>{data.catalogs.paymentMethods.length} pagamentos</span>
				<span>{data.catalogs.vendors.length} fornecedores</span>
				<span>{data.catalogs.costCenters.length} centros de custo</span>
			</div>

			<div class="support-catalog-tabs" role="tablist" aria-label="Tipo de cadastro">
				{#each supportCatalogTabs as tab (tab.kind)}
					<button
						class="support-catalog-tab"
						type="button"
						role="tab"
						id={`support-catalog-tab-${tab.kind}`}
						aria-selected={supportCatalogTab === tab.kind}
						aria-controls={`support-catalog-panel-${tab.kind}`}
						onclick={() => setSupportCatalogTab(tab.kind)}
					>
						<span>{tab.label}</span>
						<strong>{catalogItems(tab.kind).length}</strong>
					</button>
				{/each}
			</div>

			<div
				class="support-catalog-active-panel"
				id={`support-catalog-panel-${supportCatalogTab}`}
				role="tabpanel"
				aria-labelledby={`support-catalog-tab-${supportCatalogTab}`}
			>
				<form
					method="post"
					action="?/createCatalog"
					class="support-catalog-form support-catalog-create-form"
				>
					<input type="hidden" name="returnTo" value={data.returnTo} />
					<input type="hidden" name="kind" value={supportCatalogTab} />
					<label>
						<span>{activeCatalogMeta.createLabel}</span>
						<input
							name="name"
							required
							minlength="2"
							maxlength={activeCatalogMeta.maxLength}
							placeholder={activeCatalogMeta.placeholder}
						/>
					</label>
					<button class="button secondary" type="submit">
						<Plus size={16} />
						<span>Criar</span>
					</button>
				</form>

				<div class="support-catalog-toolbar">
					<label class="support-catalog-search">
						<span>Buscar {activeCatalogMeta.singular}</span>
						<div class="input-with-icon">
							<Search size={16} />
							<input
								value={supportCatalogSearch[supportCatalogTab]}
								placeholder={`Buscar em ${activeCatalogMeta.label.toLocaleLowerCase('pt-BR')}`}
								aria-label={`Buscar ${activeCatalogMeta.singular}`}
								oninput={(event) =>
									updateSupportCatalogSearch(
										supportCatalogTab,
										(event.currentTarget as HTMLInputElement).value
									)}
							/>
						</div>
					</label>
					<div class="support-catalog-page-size" aria-label="Itens por pagina">
						<span>Exibicao</span>
						<strong>{supportCatalogPageSize} por pagina</strong>
					</div>
				</div>

				<div class="support-catalog-list-heading">
					<strong>{activeCatalogMeta.label}</strong>
					<span>
						{supportCatalogResultStart}-{supportCatalogResultEnd} de {filteredSupportCatalogItems.length}
					</span>
				</div>

				<div class="support-catalog-list">
					{#each paginatedSupportCatalogItems as item (item.id)}
						<div class="support-catalog-row">
							<form method="post" action="?/updateCatalog" class="support-catalog-edit-form">
								<input type="hidden" name="returnTo" value={data.returnTo} />
								<input type="hidden" name="kind" value={supportCatalogTab} />
								<input type="hidden" name="id" value={item.id} />
								<label>
									<span>{catalogUsageLabel(item)}</span>
									<input
										name="name"
										value={item.name}
										required
										minlength="2"
										maxlength={activeCatalogMeta.maxLength}
										aria-label={`Editar ${activeCatalogMeta.singular} ${item.name}`}
									/>
								</label>
								<button class="button secondary" type="submit">
									<Save size={15} />
									<span>Salvar</span>
								</button>
							</form>
							<form method="post" action="?/removeCatalog" class="support-catalog-remove-form">
								<input type="hidden" name="returnTo" value={data.returnTo} />
								<input type="hidden" name="kind" value={supportCatalogTab} />
								<input type="hidden" name="id" value={item.id} />
								<button
									class="button secondary danger"
									type="submit"
									aria-label={`${catalogRemoveLabel(item)} ${activeCatalogMeta.singular} ${item.name}`}
								>
									<Trash2 size={15} />
									<span>{catalogRemoveLabel(item)}</span>
								</button>
							</form>
						</div>
					{:else}
						<p class="support-catalog-empty">
							{activeCatalogQuery ? 'Nenhum resultado para a busca.' : activeCatalogMeta.empty}
						</p>
					{/each}
				</div>

				{#if supportCatalogPageCount > 1}
					<div class="support-catalog-pagination">
						<button
							class="button secondary"
							type="button"
							disabled={activeSupportCatalogPage === 1}
							aria-label={`Pagina anterior de ${activeCatalogMeta.label.toLocaleLowerCase('pt-BR')}`}
							onclick={() => goToSupportCatalogPage(activeSupportCatalogPage - 1)}
						>
							<ChevronLeft size={16} />
							<span>Anterior</span>
						</button>
						<span>Pagina {activeSupportCatalogPage} de {supportCatalogPageCount}</span>
						<button
							class="button secondary"
							type="button"
							disabled={activeSupportCatalogPage === supportCatalogPageCount}
							aria-label={`Proxima pagina de ${activeCatalogMeta.label.toLocaleLowerCase('pt-BR')}`}
							onclick={() => goToSupportCatalogPage(activeSupportCatalogPage + 1)}
						>
							<span>Proxima</span>
							<ChevronRight size={16} />
						</button>
					</div>
				{/if}
			</div>

			<div class="dialog-actions single">
				<button class="button secondary" type="button" onclick={closeSupportCatalogDialog}
					>Fechar</button
				>
			</div>
		</div>
	</dialog>

	<section class="panel expense-list-panel">
		<div class="expense-list-heading">
			<div>
				<h3>Despesas lancadas</h3>
				<p>
					{data.expenses.items.length} de {data.expenseSummary.itemCount} itens exibidos
				</p>
			</div>
			<strong>{formatCents(data.expenseSummary.totalCents)}</strong>
		</div>

		<form method="get" class="expense-filter-form">
			<label>
				<span>Inicio</span>
				<input type="date" name="from" value={data.filters.from ?? ''} />
			</label>
			<label>
				<span>Fim</span>
				<input type="date" name="to" value={data.filters.to ?? ''} />
			</label>
			<label>
				<span>Categoria</span>
				<select name="categoryId" aria-label="Categoria">
					<option value="">Todas</option>
					{#each data.categories as category (category.id)}
						<option value={category.id} selected={data.filters.categoryId === category.id}
							>{category.icon ?? '💼'} {category.name}</option
						>
					{/each}
				</select>
			</label>
			<label>
				<span>Revisao</span>
				<select name="reviewStatus" aria-label="Revisao">
					<option value="">Todas</option>
					<option value="pending" selected={data.filters.reviewStatus === 'pending'}
						>Pendente</option
					>
					<option value="approved" selected={data.filters.reviewStatus === 'approved'}
						>Aprovada</option
					>
					<option value="rejected" selected={data.filters.reviewStatus === 'rejected'}
						>Rejeitada</option
					>
				</select>
			</label>
			<label>
				<span>Pagamento</span>
				<select name="paymentStatus" aria-label="Pagamento">
					<option value="">Todos</option>
					<option value="unpaid" selected={data.filters.paymentStatus === 'unpaid'}>Aberta</option>
					<option value="paid" selected={data.filters.paymentStatus === 'paid'}>Paga</option>
					<option value="reconciled" selected={data.filters.paymentStatus === 'reconciled'}
						>Conciliada</option
					>
				</select>
			</label>
			<label class="filter-search">
				<span>Busca</span>
				<input name="q" placeholder="Buscar" value={data.filters.q ?? ''} />
			</label>
			<button class="button secondary filter-button" type="submit">
				<Search size={17} />
				<span>Filtrar</span>
			</button>
			{#if hasActiveFilters()}
				<a class="button secondary filter-button" href={expensesPath}>
					<RotateCcw size={17} />
					<span>Limpar</span>
				</a>
			{/if}
		</form>

		{#if data.expenses.items.length === 0}
			<p class="empty">Nenhuma despesa encontrada.</p>
		{:else}
			<div class="expense-table" aria-label="Despesas lancadas">
				<div class="expense-table-header" aria-hidden="true">
					<span>Data</span>
					<span>Descricao</span>
					<span>Categoria</span>
					<span>Pagamento</span>
					<span>Notas</span>
					<span>Valor</span>
					<span>Acoes</span>
				</div>

				{#each data.expenses.items as expense (expense.id)}
					<article class="expense-table-item">
						<details
							class="expense-table-details"
							ontoggle={(event) => prepareExpenseDetails(expense.id, event)}
						>
							<summary class="expense-table-row">
								<span class="expense-table-date">
									<LocalizedDate value={expense.expenseDate} />
								</span>
								<span class="expense-table-description">
									<strong>{expense.description}</strong>
									{#if expense.installmentsTotal}
										<small>{expense.installmentNumber}/{expense.installmentsTotal}</small>
									{/if}
									{#if expense.attachments.length > 0}
										<small class="expense-attachment-count">
											<Paperclip size={12} />
											{expense.attachments.length}
										</small>
									{/if}
									<span class={reviewClass(expense.reviewStatus)}
										>{reviewLabel(expense.reviewStatus)}</span
									>
								</span>
								<span
									class="expense-category expense-table-category"
									style={`--category-color:${expense.categoryColor}`}
								>
									<span>{expense.categoryIcon ?? '💼'}</span>
									{expense.categoryName}
								</span>
								<span class="expense-table-muted expense-table-payment">
									{expense.paymentMethod || '-'}
									<span class={paymentClass(expense.paymentStatus)}
										>{paymentLabel(expense.paymentStatus)}</span
									>
								</span>
								<span class="expense-table-muted expense-table-note">
									{expense.vendor || expense.costCenter || expense.notes || '-'}
									{#if expense.vendor && expense.costCenter}
										<small>{expense.costCenter}</small>
									{:else if expense.reviewStatus === 'rejected' && expense.reviewRejectionReason}
										<small>{expense.reviewRejectionReason}</small>
									{/if}
								</span>
								<span class="expense-table-amount">{formatCents(expense.amountCents)}</span>
								<span class="expense-table-action">
									<Pencil size={15} />
									Editar
								</span>
							</summary>

							{#if hasPreparedExpenseDetails(expense.id)}
								<form
									method="post"
									action="?/update"
									class="expense-edit-form expense-edit-form-table"
								>
									<input type="hidden" name="id" value={expense.id} />
									<input type="hidden" name="returnTo" value={data.returnTo} />
									<label>
										<span>Descricao</span>
										<input name="description" value={expense.description} required />
									</label>
									<label>
										<span>Valor</span>
										<input name="amount" value={amountInputValue(expense.amountCents)} required />
									</label>
									<label>
										<span>Data</span>
										<input name="expenseDate" type="date" value={expense.expenseDate} required />
									</label>
									<label>
										<span>Categoria</span>
										<select name="categoryId" required>
											{#each data.categories as category (category.id)}
												<option value={category.id} selected={category.id === expense.categoryId}
													>{category.icon ?? '💼'} {category.name}</option
												>
											{/each}
										</select>
									</label>
									<label>
										<span>Pagamento</span>
										<select name="paymentMethodId">
											<option value="">Selecione</option>
											{#if expense.paymentMethodId && !hasCatalogOption(data.catalogs.paymentMethods, expense.paymentMethodId)}
												<option value={expense.paymentMethodId} selected
													>{expense.paymentMethod ?? 'Pagamento arquivado'} (arquivado)</option
												>
											{/if}
											{#each data.catalogs.paymentMethods as paymentMethod (paymentMethod.id)}
												<option
													value={paymentMethod.id}
													selected={paymentMethod.id === expense.paymentMethodId}
													>{paymentMethod.name}</option
												>
											{/each}
										</select>
									</label>
									<label>
										<span>Fornecedor</span>
										<select name="vendorId">
											<option value="">Selecione</option>
											{#if expense.vendorId && !hasCatalogOption(data.catalogs.vendors, expense.vendorId)}
												<option value={expense.vendorId} selected
													>{expense.vendor ?? 'Fornecedor arquivado'} (arquivado)</option
												>
											{/if}
											{#each data.catalogs.vendors as vendor (vendor.id)}
												<option value={vendor.id} selected={vendor.id === expense.vendorId}
													>{vendor.name}</option
												>
											{/each}
										</select>
									</label>
									<label>
										<span>Centro de custo</span>
										<select name="costCenterId">
											<option value="">Selecione</option>
											{#if expense.costCenterId && !hasCatalogOption(data.catalogs.costCenters, expense.costCenterId)}
												<option value={expense.costCenterId} selected
													>{expense.costCenter ?? 'Centro de custo arquivado'} (arquivado)</option
												>
											{/if}
											{#each data.catalogs.costCenters as costCenter (costCenter.id)}
												<option
													value={costCenter.id}
													selected={costCenter.id === expense.costCenterId}
													>{costCenter.name}</option
												>
											{/each}
										</select>
									</label>
									<label>
										<span>Competencia</span>
										<input
											name="competencyMonth"
											type="month"
											value={expense.competencyMonth?.slice(0, 7) ?? ''}
										/>
									</label>
									<label class="edit-notes">
										<span>Notas</span>
										<input name="notes" value={expense.notes ?? ''} />
									</label>
									<button class="button primary" type="submit">
										<Save size={17} />
										<span>Atualizar</span>
									</button>
								</form>

								{#if data.permissions.canReview || data.permissions.canReconcile}
									<div class="expense-workflow-panel">
										<div class="workflow-summary">
											<span class={reviewClass(expense.reviewStatus)}>
												{reviewLabel(expense.reviewStatus)}
											</span>
											<span class={paymentClass(expense.paymentStatus)}>
												{paymentLabel(expense.paymentStatus)}
											</span>
										</div>
										{#if data.permissions.canReview}
											<form method="post" action="?/review" class="workflow-form">
												<input type="hidden" name="id" value={expense.id} />
												<input type="hidden" name="returnTo" value={data.returnTo} />
												<input type="hidden" name="reviewStatus" value="approved" />
												<button
													class="button secondary"
													type="submit"
													disabled={expense.reviewStatus === 'approved'}
												>
													<CheckCircle2 size={16} />
													<span>Aprovar</span>
												</button>
											</form>
											<form method="post" action="?/review" class="workflow-form reject-form">
												<input type="hidden" name="id" value={expense.id} />
												<input type="hidden" name="returnTo" value={data.returnTo} />
												<input type="hidden" name="reviewStatus" value="rejected" />
												<input name="reason" placeholder="Motivo" maxlength="500" />
												<button
													class="button secondary danger"
													type="submit"
													disabled={expense.reviewStatus === 'rejected'}
												>
													<XCircle size={16} />
													<span>Rejeitar</span>
												</button>
											</form>
										{/if}

										{#if data.permissions.canReconcile && expense.reviewStatus === 'approved'}
											<form method="post" action="?/payment" class="workflow-form">
												<input type="hidden" name="id" value={expense.id} />
												<input type="hidden" name="returnTo" value={data.returnTo} />
												<select name="paymentStatus" aria-label="Status de pagamento">
													<option value="unpaid" selected={expense.paymentStatus === 'unpaid'}
														>Aberta</option
													>
													<option value="paid" selected={expense.paymentStatus === 'paid'}
														>Paga</option
													>
													<option
														value="reconciled"
														selected={expense.paymentStatus === 'reconciled'}>Conciliada</option
													>
												</select>
												<input
													name="paidAt"
													type="date"
													value={expense.paidAt ?? ''}
													aria-label="Data de pagamento"
												/>
												<button class="button secondary" type="submit">
													<CreditCard size={16} />
													<span>Salvar pagamento</span>
												</button>
											</form>
										{/if}
									</div>
								{/if}

								<div class="attachment-panel">
									<div class="attachment-list">
										{#each expense.attachments as attachment (attachment.id)}
											<a
												class="attachment-chip"
												href={resolve(`/app/expenses/attachments/${attachment.id}`)}
											>
												<Paperclip size={15} />
												<span>{attachment.originalName}</span>
											</a>
										{:else}
											<span class="empty">Nenhum comprovante anexado.</span>
										{/each}
									</div>
									<form
										method="post"
										action="?/attach"
										enctype="multipart/form-data"
										class="attachment-form"
									>
										<input type="hidden" name="id" value={expense.id} />
										<input type="hidden" name="returnTo" value={data.returnTo} />
										<input
											name="attachment"
											type="file"
											accept="application/pdf,image/png,image/jpeg,image/webp,text/plain"
											aria-label="Comprovante"
										/>
										<button class="button secondary" type="submit">
											<Paperclip size={16} />
											<span>Anexar</span>
										</button>
									</form>
								</div>
							{/if}
						</details>

						<button
							class="icon-button danger expense-table-delete"
							type="button"
							aria-label={`Excluir ${expense.description}`}
							onclick={() => openDeleteDialog(expense)}
						>
							<Trash2 size={17} />
						</button>
					</article>
				{/each}
			</div>
		{/if}

		{#if data.expenses.nextCursor}
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a class="button secondary" href={nextPageHref()}>Proxima pagina</a>
		{/if}
	</section>

	<dialog
		{@attach captureDeleteDialog}
		class="app-dialog"
		aria-labelledby="delete-expense-title"
		onclick={closeDeleteDialogFromBackdrop}
		onclose={clearDeleteDialog}
	>
		{#if pendingDelete}
			<div class="dialog-card">
				<div class="dialog-heading">
					<span class="dialog-icon danger">
						<Trash2 size={20} />
					</span>
					<div>
						<h3 id="delete-expense-title">Excluir despesa?</h3>
						<p>
							{pendingDelete.description}
							<span>{pendingDelete.amount}</span>
						</p>
					</div>
				</div>

				<p class="dialog-muted">
					Essa acao remove o lancamento e atualiza os dashboards e relatorios.
				</p>

				<form method="post" action="?/delete" class="dialog-actions">
					<input type="hidden" name="id" value={pendingDelete.id} />
					<input type="hidden" name="returnTo" value={data.returnTo} />
					<button class="button secondary" type="button" onclick={closeDeleteDialog}
						>Cancelar</button
					>
					<button class="button danger" type="submit">
						<Trash2 size={17} />
						<span>Excluir</span>
					</button>
				</form>
			</div>
		{/if}
	</dialog>
</section>
