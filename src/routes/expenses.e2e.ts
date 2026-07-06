import { expect, type Locator, type Page, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({
	locale: 'pt-BR',
	extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
});

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerAndCreateWorkspace(page: Page, workspaceName = 'Despesas E2E') {
	await page.goto('/register');
	await page.getByLabel('Nome').fill('Expense Tester');
	await page.getByLabel('Email').fill(uniqueEmail('expenses'));
	await page.locator('input[name="password"]').fill(['test', 'password', '123'].join('-'));
	await page.locator('input[name="passwordConfirmation"]').fill(['test', 'password', '123'].join('-'));
	await page.getByRole('button', { name: 'Criar conta' }).click();

	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Nome').fill(workspaceName);
	await page.getByRole('button', { name: 'Criar workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
}

async function createCategory(
	page: Page,
	input = { name: 'Operacional', emoji: '🧰', color: '#2563eb' }
) {
	await page.goto('/app/categories');
	const form = page.locator('form.stack');
	await form.getByLabel('Nome').fill(input.name);
	await form.locator('input[name="color"]').fill(input.color);
	await form.locator('select[name="icon"]').selectOption(input.emoji);
	await form.getByRole('button', { name: 'Criar' }).click();
	await expect(page.locator('.category-edit input[name="name"]').first()).toHaveValue(input.name);
}

async function createCatalogFromDialog(
	page: Page,
	kind: 'paymentMethod' | 'vendor' | 'costCenter',
	name: string
) {
	await openCatalogDialog(page, kind);
	const form = page
		.getByRole('dialog', { name: 'Cadastros de apoio' })
		.locator('form.support-catalog-create-form');
	await form.getByLabel(createCatalogLabel(kind)).fill(name);
	await form.getByRole('button', { name: 'Criar' }).click();
	const dialog = page.getByRole('dialog', { name: 'Cadastros de apoio' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('status')).toHaveText('Item adicionado ao cadastro com sucesso.');
	await expect(dialog.getByLabel(`Editar ${catalogKindName(kind)} ${name}`)).toBeVisible();
	await dialog.getByRole('button', { name: 'Fechar' }).click();
	await expect(dialog).toBeHidden();
}

async function createCatalogByRequest(
	page: Page,
	kind: 'paymentMethod' | 'vendor' | 'costCenter',
	name: string
) {
	const response = await page.request.post('/app/expenses?/createCatalog', {
		form: {
			kind,
			name,
			returnTo: '/app/expenses'
		}
	});
	await expect(response).toBeOK();
}

async function createExpenseByRequest(
	page: Page,
	input: {
		categoryId: string;
		description: string;
		amount?: string;
		expenseDate?: string;
	}
) {
	const response = await page.request.post('/app/expenses?/create', {
		form: {
			categoryId: input.categoryId,
			description: input.description,
			amount: input.amount ?? '10,00',
			expenseDate: input.expenseDate ?? '2026-06-10',
			installments: '1',
			returnTo: '/app/expenses'
		}
	});
	await expect(response).toBeOK();
}

async function createExpenseFromForm(
	page: Page,
	input: {
		description: string;
		amount: string;
		date: string;
		category: string;
		payment?: string;
		vendor?: string;
		costCenter?: string;
		competency?: string;
		installments?: string;
		notes?: string;
	}
) {
	await page.goto('/app/expenses');
	const form = page.locator('form.expense-create-form');
	await form.getByLabel('Descrição').fill(input.description);
	await form.getByLabel('Valor da parcela').fill(input.amount);
	await form.getByLabel('Data', { exact: true }).fill(input.date);
	await form.getByLabel('Categoria').selectOption({ label: input.category });
	if (input.payment) await form.getByLabel('Pagamento').selectOption({ label: input.payment });
	if (input.vendor) await chooseSearchableOption(form, 'Fornecedor', input.vendor);
	if (input.costCenter) await chooseSearchableOption(form, 'Centro de custo', input.costCenter);
	if (input.competency) await form.getByLabel('Competência').fill(input.competency);
	if (input.installments) await form.getByLabel('Parcelas').fill(input.installments);
	if (input.notes) await form.getByLabel('Notas').fill(input.notes);
	await form.getByRole('button', { name: 'Adicionar' }).click();
	await expect(expenseRow(page, input.description).first()).toBeVisible();
}

async function openCatalogDialog(page: Page, kind: 'paymentMethod' | 'vendor' | 'costCenter') {
	await page.goto('/app/expenses');
	await page.getByRole('button', { name: 'Cadastros' }).click();
	const dialog = page.getByRole('dialog', { name: 'Cadastros de apoio' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('tab', { name: new RegExp(tabLabel(kind)) }).click();
	return dialog;
}

async function chooseSearchableOption(scope: Page | Locator, label: string, option: string) {
	const combobox = scope.getByRole('combobox', { name: label });
	await combobox.fill(option);
	await scope.getByRole('option', { name: option, exact: true }).click();
	await expect(combobox).toHaveValue(option);
}

async function clearSearchableOption(scope: Page | Locator, label: string) {
	await scope.getByRole('button', { name: `Limpar ${label}` }).click();
	await expect(scope.getByRole('combobox', { name: label })).toHaveValue('');
}

function expenseRow(page: Page, text: string) {
	return page.locator('.expense-table-item').filter({ hasText: text });
}

function createCatalogLabel(kind: 'paymentMethod' | 'vendor' | 'costCenter') {
	if (kind === 'paymentMethod') return 'Novo pagamento';
	if (kind === 'vendor') return 'Novo fornecedor';
	return 'Novo centro de custo';
}

function catalogKindName(kind: 'paymentMethod' | 'vendor' | 'costCenter') {
	if (kind === 'paymentMethod') return 'pagamento';
	if (kind === 'vendor') return 'fornecedor';
	return 'centro de custo';
}

function tabLabel(kind: 'paymentMethod' | 'vendor' | 'costCenter') {
	if (kind === 'paymentMethod') return 'Pagamentos';
	if (kind === 'vendor') return 'Fornecedores';
	return 'Centros de custo';
}

async function categoryIdByLabel(page: Page, label: string) {
	await page.goto('/app/expenses');
	const option = page
		.locator('form.expense-create-form select[name="categoryId"] option')
		.filter({ hasText: label });
	const value = await option.getAttribute('value');
	expect(value).toBeTruthy();
	return value!;
}

async function applyExpenseFilter(page: Page, configure: (filterForm: Locator) => Promise<void>) {
	await page.goto('/app/expenses');
	const filterForm = page.locator('form.expense-filter-form');
	await configure(filterForm);
	await filterForm.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page).toHaveURL(/\/app\/expenses\?/);
}

async function expectExpenseResults(page: Page, visible: string[], hidden: string[]) {
	for (const description of visible) {
		await expect(expenseRow(page, description)).toBeVisible();
	}
	for (const description of hidden) {
		await expect(expenseRow(page, description)).toHaveCount(0);
	}
}

async function updateExpensePaymentStatus(
	page: Page,
	description: string,
	status: 'paid' | 'reconciled',
	paidAt = '2026-08-12'
) {
	await page.goto('/app/expenses');
	let row = expenseRow(page, description);
	await row.locator('summary').click();
	await row.getByLabel('Status de pagamento').selectOption(status);
	await row.getByLabel('Data de pagamento').fill(paidAt);
	await row.getByRole('button', { name: 'Salvar pagamento' }).click();
	row = expenseRow(page, description);
	await expect(row).toContainText(status === 'paid' ? 'Paga' : 'Conciliada');
}

async function rejectExpense(page: Page, description: string) {
	await page.goto('/app/expenses');
	let row = expenseRow(page, description);
	await row.locator('summary').click();
	await row.locator('input[name="reason"]').fill('Rejeitada pelo E2E');
	await row.getByRole('button', { name: 'Rejeitar' }).click();
	row = expenseRow(page, description);
	await expect(row).toContainText('Rejeitada');
}

test('manages support catalogs from expenses', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page);

	await page.goto('/app/expenses');
	await page.getByRole('button', { name: 'Cadastros' }).click();
	await expect(page.getByRole('dialog', { name: 'Cadastros de apoio' })).toBeVisible();
	await page.getByRole('button', { name: 'Fechar' }).click();
	await expect(page.getByRole('dialog', { name: 'Cadastros de apoio' })).toBeHidden();

	await createCatalogFromDialog(page, 'paymentMethod', 'Cartão corporativo');
	await expect(
		page.locator('form.expense-create-form select[name="paymentMethodId"]')
	).toContainText('Cartão corporativo');

	await openCatalogDialog(page, 'paymentMethod');
	const paymentEdit = page.getByLabel('Editar pagamento Cartão corporativo');
	await paymentEdit.fill('Cartão central');
	await paymentEdit.locator('xpath=ancestor::form').getByRole('button', { name: 'Salvar' }).click();
	await expect(
		page.locator('form.expense-create-form select[name="paymentMethodId"]')
	).toContainText('Cartão central');

	await createCatalogFromDialog(page, 'vendor', 'Fornecedor temporário');
	await openCatalogDialog(page, 'vendor');
	await page.getByRole('button', { name: 'Excluir fornecedor Fornecedor temporário' }).click();
	await page.goto('/app/expenses');
	await page
		.locator('form.expense-create-form')
		.getByRole('combobox', { name: 'Fornecedor' })
		.fill('Fornecedor temporário');
	await expect(
		page.getByRole('option', { name: 'Fornecedor temporário', exact: true })
	).toHaveCount(0);

	await createCatalogFromDialog(page, 'vendor', 'ACME Serviços');
	await createCatalogFromDialog(page, 'costCenter', 'Obra Norte');
	await createExpenseFromForm(page, {
		description: 'Despesa com fornecedor usado',
		amount: '50,00',
		date: '2026-06-10',
		category: '🧰 Operacional',
		payment: 'Cartão central',
		vendor: 'ACME Serviços',
		costCenter: 'Obra Norte'
	});

	await openCatalogDialog(page, 'vendor');
	await page.getByRole('button', { name: 'Arquivar fornecedor ACME Serviços' }).click();
	await page.goto('/app/expenses');
	await expect(expenseRow(page, 'Despesa com fornecedor usado')).toContainText('ACME Serviços');
	const archivedVendorRow = expenseRow(page, 'Despesa com fornecedor usado');
	await archivedVendorRow.locator('summary').click();
	await expect(archivedVendorRow.getByRole('combobox', { name: 'Fornecedor' })).toHaveValue(
		'ACME Serviços (arquivado)'
	);
	await page
		.locator('form.expense-create-form')
		.getByRole('combobox', { name: 'Fornecedor' })
		.fill('ACME Serviços');
	await expect(page.getByRole('option', { name: 'ACME Serviços', exact: true })).toHaveCount(0);
});

test('validates support catalog errors, search and pagination', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page);
	await createCatalogByRequest(page, 'vendor', 'Fornecedor Duplicado');
	await createCatalogByRequest(page, 'vendor', 'Fornecedor Original');

	await openCatalogDialog(page, 'vendor');
	const createForm = page
		.getByRole('dialog', { name: 'Cadastros de apoio' })
		.locator('form.support-catalog-create-form');
	await createForm.evaluate((form) => form.setAttribute('novalidate', ''));
	await createForm.getByLabel('Novo fornecedor').fill('A');
	await createForm.getByRole('button', { name: 'Criar' }).click();
	await expect(page.getByRole('dialog', { name: 'Cadastros de apoio' })).toBeVisible();
	await expect(page.getByRole('alert')).toHaveText('Confira o cadastro auxiliar.');

	await openCatalogDialog(page, 'vendor');
	const originalVendorEdit = page.getByLabel('Editar fornecedor Fornecedor Original');
	await originalVendorEdit.fill('Fornecedor Duplicado');
	await originalVendorEdit
		.locator('xpath=ancestor::form')
		.getByRole('button', { name: 'Salvar' })
		.click();
	await expect(page.getByText('Fornecedor já existe.')).toBeVisible();

	for (let index = 1; index <= 10; index += 1) {
		await createCatalogByRequest(
			page,
			'vendor',
			`Fornecedor Lote ${String(index).padStart(2, '0')}`
		);
	}

	const dialog = await openCatalogDialog(page, 'vendor');
	await expect(dialog.getByText('1-8 de 12')).toBeVisible();
	await expect(dialog.getByText('Página 1 de 2')).toBeVisible();
	await dialog.getByRole('button', { name: 'Próxima página de fornecedores' }).click();
	await expect(dialog.getByText('Página 2 de 2')).toBeVisible();
	await expect(dialog.getByLabel('Editar fornecedor Fornecedor Lote 10')).toBeVisible();

	await dialog.getByLabel('Buscar fornecedor').fill('Lote 10');
	await expect(dialog.getByText('1-1 de 1')).toBeVisible();
	await expect(dialog.getByLabel('Editar fornecedor Fornecedor Lote 10')).toBeVisible();
	await expect(dialog.getByLabel('Editar fornecedor Fornecedor Lote 09')).toHaveCount(0);

	await dialog.getByLabel('Buscar fornecedor').fill('sem resultado');
	await expect(dialog.getByText('Nenhum resultado para a busca.')).toBeVisible();
});

test('covers keyboard, empty state and reset for searchable combos', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page);
	await createCatalogByRequest(page, 'vendor', 'Fornecedor Teclado');
	await createCatalogByRequest(page, 'costCenter', 'Centro Teclado');

	await page.goto('/app/expenses');
	const createForm = page.locator('form.expense-create-form');
	const vendor = createForm.getByRole('combobox', { name: 'Fornecedor' });
	await createForm.getByRole('button', { name: 'Abrir Fornecedor' }).click();
	await expect(createForm.getByRole('option', { name: 'Fornecedor Teclado' })).toBeVisible();

	await vendor.fill('sem fornecedor');
	await expect(createForm.getByText('Nenhum fornecedor encontrado.')).toBeVisible();
	await vendor.press('Escape');
	await expect(vendor).toHaveValue('');

	await vendor.fill('Fornecedor');
	await vendor.press('ArrowDown');
	await vendor.press('Enter');
	await expect(vendor).toHaveValue('Fornecedor Teclado');
	await clearSearchableOption(createForm, 'Fornecedor');

	await vendor.fill('Fornecedor inexistente');
	await createForm.getByLabel('Descrição').click();
	await expect(vendor).toHaveValue('');

	const costCenter = createForm.getByRole('combobox', { name: 'Centro de custo' });
	await costCenter.fill('Centro');
	await costCenter.press('ArrowDown');
	await costCenter.press('Enter');
	await expect(costCenter).toHaveValue('Centro Teclado');
	await clearSearchableOption(createForm, 'Centro de custo');
});

test('creates installment expenses, uses searchable combos and applies filters', async ({
	page
}) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page);
	await createCatalogFromDialog(page, 'paymentMethod', 'Boleto');
	await createCatalogFromDialog(page, 'vendor', 'Fornecedor Principal');
	await createCatalogFromDialog(page, 'costCenter', 'Centro Operacional');

	await page.goto('/app/expenses');
	const createForm = page.locator('form.expense-create-form');
	await createForm.getByLabel('Descrição').fill('Valor inválido');
	await createForm.getByLabel('Valor da parcela').fill('abc');
	await createForm.getByLabel('Data', { exact: true }).fill('2026-01-15');
	await createForm.getByLabel('Categoria').selectOption({ label: '🧰 Operacional' });
	await createForm.getByRole('button', { name: 'Adicionar' }).click();
	await expect(page.getByText('Confira os dados da despesa.')).toBeVisible();

	await createExpenseFromForm(page, {
		description: 'Compra parcelada',
		amount: '100,00',
		date: '2026-01-15',
		category: '🧰 Operacional',
		payment: 'Boleto',
		vendor: 'Fornecedor Principal',
		costCenter: 'Centro Operacional',
		competency: '2026-01',
		installments: '3',
		notes: 'Pedido 123'
	});

	await expect(expenseRow(page, 'Compra parcelada')).toHaveCount(3);
	await expect(page.locator('.expense-list-heading')).toContainText('R$ 300,00');
	await expect(expenseRow(page, 'Compra parcelada').filter({ hasText: '1/3' })).toBeVisible();
	await expect(expenseRow(page, 'Compra parcelada').filter({ hasText: '2/3' })).toBeVisible();
	await expect(expenseRow(page, 'Compra parcelada').filter({ hasText: '3/3' })).toBeVisible();

	const filterForm = page.locator('form.expense-filter-form');
	await filterForm.getByLabel('Início').fill('2026-02-01');
	await filterForm.getByLabel('Fim').fill('2026-02-28');
	await filterForm.getByLabel('Categoria').selectOption({ label: '🧰 Operacional' });
	await chooseSearchableOption(filterForm, 'Fornecedor', 'Fornecedor Principal');
	await clearSearchableOption(filterForm, 'Fornecedor');
	await chooseSearchableOption(filterForm, 'Fornecedor', 'Fornecedor Principal');
	await chooseSearchableOption(filterForm, 'Centro de custo', 'Centro Operacional');
	await filterForm.getByLabel('Competência').fill('2026-02');
	await filterForm.getByLabel('Revisão').selectOption('approved');
	await filterForm.getByLabel('Pagamento').selectOption('unpaid');
	await filterForm.getByLabel('Busca').fill('Compra parcelada');
	await filterForm.getByRole('button', { name: 'Filtrar' }).click();

	await expect(page).toHaveURL(/from=2026-02-01/);
	await expect(page).toHaveURL(/to=2026-02-28/);
	await expect(page).toHaveURL(/vendorId=\d+/);
	await expect(page).toHaveURL(/costCenterId=\d+/);
	await expect(page).toHaveURL(/competencyMonth=2026-02/);
	await expect(page).toHaveURL(/reviewStatus=approved/);
	await expect(page).toHaveURL(/paymentStatus=unpaid/);
	await expect(page).toHaveURL(/q=Compra\+parcelada|q=Compra%20parcelada/);
	await expect(expenseRow(page, 'Compra parcelada')).toHaveCount(1);
	await expect(expenseRow(page, 'Compra parcelada')).toContainText('2/3');
	await expect(page.locator('.expense-list-heading')).toContainText('R$ 100,00');

	await page.getByRole('link', { name: 'Limpar' }).click();
	await expect(page).toHaveURL(/\/app\/expenses$/);
	await expect(expenseRow(page, 'Compra parcelada')).toHaveCount(3);
});

test('filters expenses independently by date, category, vendor, cost center and competency', async ({
	page
}) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page);
	await createCategory(page, { name: 'Administrativo', emoji: '💼', color: '#0f766e' });
	await createCatalogByRequest(page, 'paymentMethod', 'Boleto');
	await createCatalogByRequest(page, 'vendor', 'Fornecedor Norte');
	await createCatalogByRequest(page, 'vendor', 'Fornecedor Sul');
	await createCatalogByRequest(page, 'costCenter', 'Centro Norte');
	await createCatalogByRequest(page, 'costCenter', 'Centro Sul');

	await createExpenseFromForm(page, {
		description: 'Filtro operacional junho',
		amount: '110,00',
		date: '2026-06-10',
		category: '🧰 Operacional',
		payment: 'Boleto',
		vendor: 'Fornecedor Norte',
		costCenter: 'Centro Norte',
		competency: '2026-06'
	});
	await createExpenseFromForm(page, {
		description: 'Filtro administrativo julho',
		amount: '210,00',
		date: '2026-07-12',
		category: '💼 Administrativo',
		payment: 'Boleto',
		vendor: 'Fornecedor Sul',
		costCenter: 'Centro Sul',
		competency: '2026-07'
	});

	await applyExpenseFilter(page, async (filterForm) => {
		await filterForm.getByLabel('Início').fill('2026-07-01');
	});
	await expectExpenseResults(page, ['Filtro administrativo julho'], ['Filtro operacional junho']);

	await applyExpenseFilter(page, async (filterForm) => {
		await filterForm.getByLabel('Fim').fill('2026-06-30');
	});
	await expectExpenseResults(page, ['Filtro operacional junho'], ['Filtro administrativo julho']);

	await applyExpenseFilter(page, async (filterForm) => {
		await filterForm.getByLabel('Categoria').selectOption({ label: '💼 Administrativo' });
	});
	await expectExpenseResults(page, ['Filtro administrativo julho'], ['Filtro operacional junho']);

	await applyExpenseFilter(page, async (filterForm) => {
		await chooseSearchableOption(filterForm, 'Fornecedor', 'Fornecedor Norte');
	});
	await expectExpenseResults(page, ['Filtro operacional junho'], ['Filtro administrativo julho']);

	await applyExpenseFilter(page, async (filterForm) => {
		await chooseSearchableOption(filterForm, 'Centro de custo', 'Centro Sul');
	});
	await expectExpenseResults(page, ['Filtro administrativo julho'], ['Filtro operacional junho']);

	await applyExpenseFilter(page, async (filterForm) => {
		await filterForm.getByLabel('Competência').fill('2026-06');
	});
	await expectExpenseResults(page, ['Filtro operacional junho'], ['Filtro administrativo julho']);
});

test('filters expenses independently by review, payment and text search', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page);
	await createCatalogByRequest(page, 'paymentMethod', 'Boleto');

	await createExpenseFromForm(page, {
		description: 'Filtro busca aberta',
		amount: '90,00',
		date: '2026-08-10',
		category: '🧰 Operacional',
		payment: 'Boleto',
		notes: 'Contrato aberto'
	});
	await createExpenseFromForm(page, {
		description: 'Filtro busca paga',
		amount: '190,00',
		date: '2026-08-11',
		category: '🧰 Operacional',
		payment: 'Boleto',
		notes: 'Contrato quitado'
	});
	await createExpenseFromForm(page, {
		description: 'Filtro busca rejeitada',
		amount: '290,00',
		date: '2026-08-12',
		category: '🧰 Operacional',
		payment: 'Boleto',
		notes: 'Contrato rejeitado'
	});

	await updateExpensePaymentStatus(page, 'Filtro busca paga', 'paid');
	await rejectExpense(page, 'Filtro busca rejeitada');

	await applyExpenseFilter(page, async (filterForm) => {
		await filterForm.getByLabel('Revisão').selectOption('rejected');
	});
	await expectExpenseResults(
		page,
		['Filtro busca rejeitada'],
		['Filtro busca aberta', 'Filtro busca paga']
	);

	await applyExpenseFilter(page, async (filterForm) => {
		await filterForm.getByLabel('Pagamento').selectOption('paid');
	});
	await expectExpenseResults(
		page,
		['Filtro busca paga'],
		['Filtro busca aberta', 'Filtro busca rejeitada']
	);

	await applyExpenseFilter(page, async (filterForm) => {
		await filterForm.getByLabel('Pagamento').selectOption('unpaid');
	});
	await expectExpenseResults(
		page,
		['Filtro busca aberta', 'Filtro busca rejeitada'],
		['Filtro busca paga']
	);

	await applyExpenseFilter(page, async (filterForm) => {
		await filterForm.getByLabel('Busca').fill('busca paga');
	});
	await expectExpenseResults(
		page,
		['Filtro busca paga'],
		['Filtro busca aberta', 'Filtro busca rejeitada']
	);

	await applyExpenseFilter(page, async (filterForm) => {
		await filterForm.getByLabel('Busca').fill('sem despesa correspondente');
	});
	await expect(page.getByText('Nenhuma despesa encontrada.')).toBeVisible();
});

test('edits, reviews, pays, attaches and deletes an expense', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page);
	await createCategory(page, { name: 'Administrativo', emoji: '💼', color: '#0f766e' });
	await createCatalogFromDialog(page, 'paymentMethod', 'Pix');
	await createCatalogFromDialog(page, 'vendor', 'Fornecedor A');
	await createCatalogFromDialog(page, 'costCenter', 'Centro A');
	await createCatalogFromDialog(page, 'vendor', 'Fornecedor B');
	await createCatalogFromDialog(page, 'costCenter', 'Centro B');

	await createExpenseFromForm(page, {
		description: 'Fluxo completo',
		amount: '120,00',
		date: '2026-06-20',
		category: '🧰 Operacional',
		payment: 'Pix',
		vendor: 'Fornecedor A',
		costCenter: 'Centro A',
		notes: 'Nota inicial'
	});

	let row = expenseRow(page, 'Fluxo completo');
	await row.locator('summary').click();
	await expect(row.locator('.expense-edit-form')).toBeVisible();
	await row.getByLabel('Descrição').fill('Fluxo atualizado');
	await row.getByLabel('Valor').fill('230,10');
	await row.getByLabel('Categoria').selectOption({ label: '💼 Administrativo' });
	await chooseSearchableOption(row, 'Fornecedor', 'Fornecedor B');
	await chooseSearchableOption(row, 'Centro de custo', 'Centro B');
	await row.getByLabel('Competência').fill('2026-06');
	await row.getByLabel('Notas').fill('Nota atualizada');
	await row.getByRole('button', { name: 'Atualizar' }).click();

	row = expenseRow(page, 'Fluxo atualizado');
	await expect(row).toContainText('R$ 230,10');
	await expect(row).toContainText('Fornecedor B');
	await expect(row).toContainText('Administrativo');

	await row.locator('summary').click();
	await row.locator('input[name="reason"]').fill('Duplicada');
	await row.getByRole('button', { name: 'Rejeitar' }).click();
	row = expenseRow(page, 'Fluxo atualizado');
	await expect(row).toContainText('Rejeitada');
	await row.locator('summary').click();
	await row.getByRole('button', { name: 'Aprovar' }).click();
	row = expenseRow(page, 'Fluxo atualizado');
	await expect(row).toContainText('Aprovada');

	await row.locator('summary').click();
	await row.getByLabel('Status de pagamento').selectOption('paid');
	await row.getByLabel('Data de pagamento').fill('2026-06-21');
	await row.getByRole('button', { name: 'Salvar pagamento' }).click();
	row = expenseRow(page, 'Fluxo atualizado');
	await expect(row).toContainText('Paga');
	await row.locator('summary').click();
	await row.getByLabel('Status de pagamento').selectOption('reconciled');
	await row.getByRole('button', { name: 'Salvar pagamento' }).click();
	row = expenseRow(page, 'Fluxo atualizado');
	await expect(row).toContainText('Conciliada');

	await row.locator('summary').click();
	await row.locator('input[type="file"]').setInputFiles({
		name: 'recibo.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('recibo fluxo completo')
	});
	await row.getByRole('button', { name: 'Anexar' }).click();
	row = expenseRow(page, 'Fluxo atualizado');
	await expect(row.locator('.expense-attachment-count')).toContainText('1');
	await row.locator('summary').click();
	const attachment = row.locator('.attachment-chip').filter({ hasText: 'recibo.txt' });
	const attachmentHref = await attachment.first().getAttribute('href');
	expect(attachmentHref).toBeTruthy();
	const attachmentResponse = await page.request.get(attachmentHref!);
	await expect(attachmentResponse).toBeOK();
	expect(await attachmentResponse.text()).toBe('recibo fluxo completo');

	await row.getByRole('button', { name: 'Excluir Fluxo atualizado' }).click();
	await expect(page.getByRole('dialog', { name: 'Excluir despesa?' })).toBeVisible();
	await page.getByRole('button', { name: 'Cancelar' }).click();
	await expect(page.getByRole('dialog', { name: 'Excluir despesa?' })).toBeHidden();
	await expect(expenseRow(page, 'Fluxo atualizado')).toBeVisible();

	await expenseRow(page, 'Fluxo atualizado')
		.getByRole('button', { name: 'Excluir Fluxo atualizado' })
		.click();
	await page.getByRole('button', { name: 'Excluir', exact: true }).click();
	await expect(expenseRow(page, 'Fluxo atualizado')).toBeHidden();
	await expect(page.getByText('Nenhuma despesa encontrada.')).toBeVisible();
});

test('keeps the page stable on update and attachment errors', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page);
	await createExpenseFromForm(page, {
		description: 'Despesa com erros',
		amount: '80,00',
		date: '2026-06-22',
		category: '🧰 Operacional'
	});

	let row = expenseRow(page, 'Despesa com erros');
	await row.locator('summary').click();
	await row.getByLabel('Valor').fill('valor inválido');
	await row.getByRole('button', { name: 'Atualizar' }).click();
	await expect(page.getByText('Confira os dados da despesa.')).toBeVisible();
	await expect(page).toHaveURL(/\/app\/expenses/);
	await expect(expenseRow(page, 'Despesa com erros')).toBeVisible();

	row = expenseRow(page, 'Despesa com erros');
	await row.locator('summary').click();
	await row.locator('input[type="file"]').setInputFiles({
		name: 'vazio.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('')
	});
	await row.getByRole('button', { name: 'Anexar' }).click();
	await expect(page.getByText('Anexo inválido.')).toBeVisible();
	await expect(page).toHaveURL(/\/app\/expenses/);
	await expect(expenseRow(page, 'Despesa com erros')).toBeVisible();
});

test('navigates expense list pagination', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page);
	const categoryId = await categoryIdByLabel(page, 'Operacional');

	for (let index = 1; index <= 26; index += 1) {
		await createExpenseByRequest(page, {
			categoryId,
			description: `Despesa paginada ${String(index).padStart(2, '0')}`,
			amount: '10,00',
			expenseDate: `2026-06-${String(index).padStart(2, '0')}`
		});
	}

	await page.goto('/app/expenses');
	await expect(page.locator('.expense-table-item')).toHaveCount(25);
	await expect(page.getByRole('link', { name: 'Próxima página' })).toBeVisible();
	await page.getByRole('link', { name: 'Próxima página' }).click();
	await expect(page).toHaveURL(/cursor=/);
	await expect(page.locator('.expense-table-item')).toHaveCount(1);
	await expect(expenseRow(page, 'Despesa paginada 01')).toBeVisible();
});
