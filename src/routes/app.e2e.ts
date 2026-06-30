import { expect, type Page, test } from '@playwright/test';
import { generateTotpCode } from '../lib/server/utils/totp';

test.describe.configure({ mode: 'serial' });

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function browserDateLabel(page: Page, value: string) {
	return page.evaluate((dateValue) => {
		return new Intl.DateTimeFormat(undefined, {
			timeZone: 'UTC',
			day: '2-digit',
			month: '2-digit',
			year: 'numeric'
		}).format(new Date(`${dateValue}T00:00:00Z`));
	}, value);
}

async function browserDateRangeLabel(page: Page, from: string, to: string) {
	return page.evaluate(
		([fromValue, toValue]) => {
			const formatter = new Intl.DateTimeFormat(undefined, {
				timeZone: 'UTC',
				day: '2-digit',
				month: '2-digit',
				year: 'numeric'
			});
			const fromDate = new Date(`${fromValue}T00:00:00Z`);
			const toDate = new Date(`${toValue}T00:00:00Z`);
			return typeof formatter.formatRange === 'function'
				? formatter.formatRange(fromDate, toDate)
				: `${formatter.format(fromDate)} a ${formatter.format(toDate)}`;
		},
		[from, to]
	);
}

async function browserMonthLabel(page: Page, value: string) {
	return page.evaluate((dateValue) => {
		return new Intl.DateTimeFormat(undefined, {
			timeZone: 'UTC',
			month: 'short',
			year: 'numeric'
		}).format(new Date(`${dateValue}T00:00:00Z`));
	}, value);
}

async function registerAndCreateWorkspace(page: Page, workspaceName = 'Minhas despesas') {
	const email = uniqueEmail('user');

	await page.goto('/register');
	await page.waitForLoadState('networkidle');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
	await page.getByLabel('Nome').fill('Test User');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Senha').fill('test-password-123');
	await page.getByRole('button', { name: 'Criar conta' }).click();

	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Nome').fill(workspaceName);
	await page.getByRole('button', { name: 'Criar workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);

	return { email, workspaceName };
}

async function createCategory(
	page: Page,
	input = { name: 'Alimentacao', emoji: '🍽️', color: '#2563eb' }
) {
	await page.goto('/app/categories');
	const form = page.locator('form.stack');
	await form.getByLabel('Nome').fill(input.name);
	await form.locator('input[name="color"]').fill(input.color);
	await form.locator('select[name="icon"]').selectOption(input.emoji);
	await form.getByRole('button', { name: 'Criar' }).click();
	await expect(page.locator('.category-edit input[name="name"]').first()).toHaveValue(input.name);
	await expect(page.locator('.category-edit select[name="icon"]').first()).toHaveValue(input.emoji);
}

async function ensureExpenseCatalogs(
	page: Page,
	input: { payment?: string; vendor?: string; costCenter?: string }
) {
	if (input.payment)
		await createCatalogItem(page, 'paymentMethod', 'Novo pagamento', input.payment);
	if (input.vendor) await createCatalogItem(page, 'vendor', 'Novo fornecedor', input.vendor);
	if (input.costCenter) {
		await createCatalogItem(page, 'costCenter', 'Novo centro de custo', input.costCenter);
	}
}

async function createCatalogItem(
	page: Page,
	kind: 'paymentMethod' | 'vendor' | 'costCenter',
	fieldLabel: string,
	name: string
) {
	await page.goto('/app/expenses');
	await page.getByRole('button', { name: 'Cadastros' }).click();
	const dialog = page.getByRole('dialog', { name: 'Cadastros de apoio' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('tab', { name: new RegExp(catalogTabLabel(kind)) }).click();
	const form = dialog.locator('form.support-catalog-create-form').first();
	await form.getByLabel(fieldLabel).fill(name);
	await form.getByRole('button', { name: 'Criar' }).click();
	await expect(page.locator(`select[name="${catalogSelectName(kind)}"]`).first()).toContainText(
		name
	);
}

async function createCatalogItemByRequest(
	page: Page,
	kind: 'paymentMethod' | 'vendor' | 'costCenter',
	name: string
) {
	const response = await page.request.post('/app/expenses?/createCatalog', {
		form: { kind, name, returnTo: '/app/expenses' }
	});
	await expect(response).toBeOK();
}

async function updateCatalogItem(
	page: Page,
	kind: 'paymentMethod' | 'vendor' | 'costCenter',
	currentName: string,
	nextName: string
) {
	await page.goto('/app/expenses');
	await page.getByRole('button', { name: 'Cadastros' }).click();
	const dialog = page.getByRole('dialog', { name: 'Cadastros de apoio' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('tab', { name: new RegExp(catalogTabLabel(kind)) }).click();
	const input = dialog.getByLabel(`Editar ${catalogKindName(kind)} ${currentName}`);
	await input.fill(nextName);
	await input.locator('xpath=ancestor::form').getByRole('button', { name: 'Salvar' }).click();
}

async function removeCatalogItem(
	page: Page,
	kind: 'paymentMethod' | 'vendor' | 'costCenter',
	action: 'Arquivar' | 'Excluir',
	name: string
) {
	await page.goto('/app/expenses');
	await page.getByRole('button', { name: 'Cadastros' }).click();
	const dialog = page.getByRole('dialog', { name: 'Cadastros de apoio' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('tab', { name: new RegExp(catalogTabLabel(kind)) }).click();
	await dialog.getByRole('button', { name: `${action} ${catalogKindName(kind)} ${name}` }).click();
}

function catalogSelectName(kind: 'paymentMethod' | 'vendor' | 'costCenter') {
	if (kind === 'paymentMethod') return 'paymentMethodId';
	if (kind === 'vendor') return 'vendorId';
	return 'costCenterId';
}

function catalogKindName(kind: 'paymentMethod' | 'vendor' | 'costCenter') {
	if (kind === 'paymentMethod') return 'pagamento';
	if (kind === 'vendor') return 'fornecedor';
	return 'centro de custo';
}

function catalogTabLabel(kind: 'paymentMethod' | 'vendor' | 'costCenter') {
	if (kind === 'paymentMethod') return 'Pagamentos';
	if (kind === 'vendor') return 'Fornecedores';
	return 'Centros de custo';
}

type ExpenseFixtureInput = {
	description: string;
	amount: string;
	date: string;
	categoryLabel: string;
	payment: string;
	notes: string;
	vendor?: string;
	costCenter?: string;
	competencyMonth?: string;
};

async function createExpense(
	page: Page,
	input: ExpenseFixtureInput = {
		description: 'Mercado',
		amount: '125,40',
		date: '2026-06-25',
		categoryLabel: '🍽️ Alimentacao',
		payment: 'Pix',
		notes: 'Compra semanal',
		vendor: 'Fornecedor padrao',
		costCenter: 'Operacao',
		competencyMonth: '2026-06'
	}
) {
	await ensureExpenseCatalogs(page, {
		payment: input.payment,
		vendor: input.vendor,
		costCenter: input.costCenter
	});
	await page.goto('/app/expenses');
	const form = page.locator('form.expense-create-form');
	await form.getByLabel('Descricao').fill(input.description);
	await form.getByLabel('Valor da parcela').fill(input.amount);
	await form.getByLabel('Data', { exact: true }).fill(input.date);
	await form.getByLabel('Categoria').selectOption({ label: input.categoryLabel });
	await form.getByLabel('Pagamento').selectOption({ label: input.payment });
	if (input.vendor) await form.getByLabel('Fornecedor').selectOption({ label: input.vendor });
	if (input.costCenter) {
		await form.getByLabel('Centro de custo').selectOption({ label: input.costCenter });
	}
	if (input.competencyMonth) await form.getByLabel('Competencia').fill(input.competencyMonth);
	await form.getByLabel('Notas').fill(input.notes);
	await form.getByRole('button', { name: 'Adicionar' }).click();

	const row = page.locator('.expense-table-item').filter({ hasText: input.description });
	await expect(row).toBeVisible();
	await expect(row).toContainText(`R$ ${input.amount}`);
	await expect(row).toContainText('Aprovada');
	return row;
}

test('protects private screens and reports invalid authentication', async ({ page }) => {
	await page.goto('/app/dashboard');
	await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fdashboard/);

	await page.getByLabel('Email').fill(uniqueEmail('missing'));
	await page.getByLabel('Senha').fill('wrong-password');
	await page.getByRole('button', { name: 'Entrar' }).click();
	await expect(page.getByText('Credenciais invalidas.')).toBeVisible();

	await page.goto('/login?next=https://evil.example/app');
	await expect(page.locator('input[name="next"]')).toHaveValue('/app');

	await page.goto('/reset-password?token=invalid-token-value');
	await page.getByLabel('Senha').fill('new-password-123');
	await page.getByRole('button', { name: 'Salvar senha' }).click();
	await expect(page.getByText('Token invalido ou expirado.')).toBeVisible();
});

test('covers dashboard, categories, expenses and reports happy path', async ({ page }) => {
	await registerAndCreateWorkspace(page);

	await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
	await expect(page.locator('.topbar')).toHaveCount(0);
	await expect(page.locator('main').getByText('Minhas despesas')).toHaveCount(0);
	await expect(page.getByText('Total')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Distribuicao por categoria' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Evolucao mensal' })).toBeVisible();
	expect((await page.request.get('/app/dashboard?from=2026-02-31&to=2026-03-01')).status()).toBe(
		400
	);
	expect((await page.request.get('/app/expenses?from=2026-07-01&to=2026-06-01')).status()).toBe(
		400
	);
	expect(
		(await page.request.get('/app/reports/export.csv?from=2026-06-01&to=2026-06-31')).status()
	).toBe(400);

	await createCategory(page);
	const createdExpense = await createExpense(page);
	await expect(createdExpense).toContainText('Aberta');
	await expect(createdExpense.locator('.expense-edit-form')).toHaveCount(0);
	await createdExpense.locator('summary').click();
	await expect(createdExpense.locator('.expense-edit-form')).toBeVisible();
	await createdExpense.getByLabel('Status de pagamento').selectOption('reconciled');
	await createdExpense.getByLabel('Data de pagamento').fill('2026-06-25');
	await createdExpense.getByRole('button', { name: 'Salvar pagamento' }).click();
	await expect(page.locator('.expense-table-item').filter({ hasText: 'Mercado' })).toContainText(
		'Conciliada'
	);
	const badReview = await page.request.post('/app/expenses?/review', {
		form: { id: '0', reviewStatus: 'pending' }
	});
	expect(badReview.status()).toBe(200);
	expect(await badReview.text()).toContain('Confira os dados da revisao.');
	const badPayment = await page.request.post('/app/expenses?/payment', {
		form: { id: '0', paymentStatus: 'late' }
	});
	expect(badPayment.status()).toBe(200);
	expect(await badPayment.text()).toContain('Confira os dados do pagamento.');
	await createdExpense.getByRole('button', { name: 'Excluir Mercado' }).click();
	await expect(page.getByRole('dialog', { name: 'Excluir despesa?' })).toBeVisible();
	await page.getByRole('button', { name: 'Cancelar' }).click();
	await expect(page.getByRole('dialog', { name: 'Excluir despesa?' })).toBeHidden();

	await page.goto('/app/dashboard?from=2026-06-01&to=2026-06-30');
	const localizedRange = await browserDateRangeLabel(page, '2026-06-01', '2026-06-30');
	const localizedWeek = await browserDateLabel(page, '2026-06-22');
	await expect(page.locator('.metric-card').filter({ hasText: 'Total' })).toContainText(
		'R$ 125,40'
	);
	await expect(page.locator('.metric-card').filter({ hasText: 'Total' })).toContainText(
		localizedRange
	);
	await expect(page.locator('svg[aria-label="Despesas por categoria"]')).toBeVisible();
	await expect(page.locator('svg[aria-label="Despesas por mes"]')).toBeVisible();
	await expect(page.locator('svg[aria-label="Despesas por semana"]')).toBeVisible();
	await expect(page.locator('.metric-card').filter({ hasText: 'Orcamento' })).toBeVisible();
	await expect(page.locator('.panel').filter({ hasText: 'Ranking por categoria' })).toContainText(
		'Alimentacao'
	);
	await expect(page.locator('.panel').filter({ hasText: 'Ranking por semana' })).toContainText(
		localizedWeek
	);

	await page.goto('/app/settings/workspace');
	const updateWorkspaceForm = page.locator('form[action="?/update"]');
	await updateWorkspaceForm.getByLabel('Inicio da semana').selectOption('0');
	await updateWorkspaceForm.getByRole('button', { name: 'Salvar' }).click();
	await page.goto('/app/dashboard?from=2026-06-01&to=2026-06-30');
	const localizedSundayWeek = await browserDateLabel(page, '2026-06-21');
	await expect(page.locator('.panel').filter({ hasText: 'Ranking por semana' })).toContainText(
		localizedSundayWeek
	);

	await page.goto('/app/reports?from=2026-06-01&to=2026-06-30&groupBy=category');
	await expect(page.getByRole('cell', { name: 'Alimentacao' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'R$ 125,40' })).toBeVisible();

	await page.getByLabel('Agrupar').selectOption('month');
	await page.getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/groupBy=month/);
	const localizedMonth = await browserMonthLabel(page, '2026-06-01');
	await expect(page.getByRole('cell', { name: localizedMonth })).toBeVisible();

	await page.getByLabel('Agrupar').selectOption('payment');
	await page.getByRole('button', { name: 'Gerar' }).click();
	await expect(page.getByRole('cell', { name: 'Pix' })).toBeVisible();

	const csv = await page.request.get(
		'/app/reports/export.csv?from=2026-06-01&to=2026-06-30&groupBy=category'
	);
	await expect(csv).toBeOK();
	await expect(await csv.text()).toContain('"Alimentacao",12540');
});

test('shows validation errors and supports editing and deleting expenses', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page, { name: 'Administrativo', emoji: '💼', color: '#0f766e' });

	await page.goto('/app/categories');
	await page.locator('form.stack').getByLabel('Nome').fill('A');
	await page.locator('form.stack').getByRole('button', { name: 'Criar' }).click();
	await expect(page.getByText('Confira os dados da categoria.')).toBeVisible();

	await page.goto('/app/expenses');
	const expenseForm = page.locator('form.expense-create-form');
	await expenseForm.getByLabel('Descricao').fill('Servico');
	await expenseForm.getByLabel('Valor').fill('abc');
	await expenseForm.getByLabel('Data', { exact: true }).fill('2026-06-20');
	await expenseForm.getByLabel('Categoria').selectOption({ label: '💼 Administrativo' });
	await expenseForm.getByRole('button', { name: 'Adicionar' }).click();
	await expect(page.getByText('Confira os dados da despesa.')).toBeVisible();

	await createExpense(page, {
		description: 'Servico',
		amount: '200,00',
		date: '2026-06-20',
		categoryLabel: '💼 Administrativo',
		payment: 'Boleto',
		notes: 'Contrato mensal',
		vendor: 'Fornecedor B',
		costCenter: 'Administrativo',
		competencyMonth: '2026-06'
	});

	await updateCatalogItem(page, 'vendor', 'Fornecedor B', 'Fornecedor B Ltda');
	await expect(page.locator('.expense-table-item').filter({ hasText: 'Servico' })).toContainText(
		'Fornecedor B Ltda'
	);

	await createCatalogItem(page, 'vendor', 'Novo fornecedor', 'Fornecedor temporario');
	await removeCatalogItem(page, 'vendor', 'Excluir', 'Fornecedor temporario');
	await expect(
		page.locator('form.expense-create-form select[name="vendorId"]').first()
	).not.toContainText('Fornecedor temporario');

	await createCatalogItem(page, 'vendor', 'Novo fornecedor', 'Fornecedor duplicado');
	await updateCatalogItem(page, 'vendor', 'Fornecedor duplicado', 'Fornecedor B Ltda');
	await expect(page.getByText('Fornecedor ja existe.')).toBeVisible();
	await removeCatalogItem(page, 'vendor', 'Excluir', 'Fornecedor duplicado');

	await removeCatalogItem(page, 'vendor', 'Arquivar', 'Fornecedor B Ltda');
	await expect(
		page.locator('form.expense-create-form select[name="vendorId"]').first()
	).not.toContainText('Fornecedor B Ltda');
	const archivedVendorRow = page.locator('.expense-table-item').filter({ hasText: 'Servico' });
	await expect(archivedVendorRow).toContainText('Fornecedor B Ltda');
	await archivedVendorRow.locator('summary').click();
	await expect(archivedVendorRow.locator('select[name="vendorId"]')).toContainText(
		'Fornecedor B Ltda (arquivado)'
	);
	await archivedVendorRow.getByLabel('Descricao').fill('Servico com fornecedor arquivado');
	await archivedVendorRow.getByRole('button', { name: 'Atualizar' }).click();
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Servico com fornecedor arquivado' })
	).toContainText('Fornecedor B Ltda');

	for (let index = 1; index <= 10; index += 1) {
		await createCatalogItemByRequest(
			page,
			'vendor',
			`Fornecedor lote ${String(index).padStart(2, '0')}`
		);
	}
	await page.goto('/app/expenses');
	await page.getByRole('button', { name: 'Cadastros' }).click();
	const pagedCatalogDialog = page.getByRole('dialog', { name: 'Cadastros de apoio' });
	await pagedCatalogDialog.getByRole('tab', { name: /Fornecedores/ }).click();
	await expect(pagedCatalogDialog.getByText('Pagina 1 de 2')).toBeVisible();
	await pagedCatalogDialog.getByRole('button', { name: 'Proxima pagina de fornecedores' }).click();
	await expect(pagedCatalogDialog.getByText('Pagina 2 de 2')).toBeVisible();
	await expect(pagedCatalogDialog.getByLabel('Editar fornecedor Fornecedor lote 09')).toBeVisible();
	await pagedCatalogDialog.getByLabel('Buscar fornecedor').fill('lote 10');
	await expect(pagedCatalogDialog.getByText('1-1 de 1')).toBeVisible();
	await expect(pagedCatalogDialog.getByLabel('Editar fornecedor Fornecedor lote 10')).toBeVisible();

	await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30&q=Servico');
	await expect(page.locator('.expense-list-heading')).toContainText('1 de 1 itens exibidos');
	await expect(page.locator('.expense-list-heading')).toContainText('R$ 200,00');

	const filteredRow = page.locator('.expense-table-item').filter({ hasText: 'Servico' });
	await filteredRow.locator('summary').click();
	await filteredRow.getByLabel('Descricao').fill('Lancamento filtrado');
	await filteredRow.getByRole('button', { name: 'Atualizar' }).click();
	await expect(page).toHaveURL(/q=Servico/);
	await expect(page.getByText('Nenhuma despesa encontrada.')).toBeVisible();

	await page.goto('/app/expenses');
	const rowAfterFilterUpdate = page
		.locator('.expense-table-item')
		.filter({ hasText: 'Lancamento filtrado' });
	await rowAfterFilterUpdate.locator('summary').click();
	await rowAfterFilterUpdate.getByLabel('Descricao').fill('Servico');
	await rowAfterFilterUpdate.getByRole('button', { name: 'Atualizar' }).click();

	await ensureExpenseCatalogs(page, {
		vendor: 'Fornecedor atualizado',
		costCenter: 'Diretoria'
	});
	await page.goto('/app/expenses');
	const rowToUpdate = page.locator('.expense-table-item').filter({ hasText: 'Servico' });
	await rowToUpdate.locator('summary').click();
	await rowToUpdate.getByLabel('Descricao').fill('Servico atualizado');
	await rowToUpdate.getByLabel('Valor').fill('230,10');
	await rowToUpdate.getByLabel('Fornecedor').selectOption({ label: 'Fornecedor atualizado' });
	await rowToUpdate.getByLabel('Centro de custo').selectOption({ label: 'Diretoria' });
	await rowToUpdate.getByRole('button', { name: 'Atualizar' }).click();
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Servico atualizado' })
	).toContainText('R$ 230,10');
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Servico atualizado' })
	).toContainText('Fornecedor atualizado');

	const rejectedRow = page.locator('.expense-table-item').filter({ hasText: 'Servico atualizado' });
	await rejectedRow.locator('summary').click();
	await rejectedRow.locator('input[name="reason"]').fill('Duplicada');
	await rejectedRow.getByRole('button', { name: 'Rejeitar' }).click();
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Servico atualizado' })
	).toContainText('Rejeitada');

	const updatedRow = page.locator('.expense-table-item').filter({ hasText: 'Servico atualizado' });
	await updatedRow.getByRole('button', { name: 'Excluir Servico atualizado' }).click();
	await page.getByRole('button', { name: 'Excluir', exact: true }).click();
	await expect(updatedRow).toBeHidden();
	await expect(page.getByText('Nenhuma despesa encontrada.')).toBeVisible();
});

test('covers workspace settings, theme, invitations and workspace switching', async ({ page }) => {
	const { workspaceName } = await registerAndCreateWorkspace(page, 'Matriz');

	await page.goto('/app/settings/workspace');
	const updateForm = page.locator('form[action="?/update"]');
	await updateForm.getByLabel('Nome').fill('A');
	await updateForm.getByRole('button', { name: 'Salvar' }).click();
	await expect(page.getByText('Confira os dados do workspace.')).toBeVisible();

	await page.goto('/app/settings/workspace');
	await page.getByLabel('Escuro').check();
	await page.getByRole('button', { name: 'Salvar tema' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await expect(page.getByLabel('Escuro')).toBeChecked();

	const createWorkspaceForm = page.locator('form[action="?/create"]');
	await createWorkspaceForm.getByLabel('Nome').fill('Filial');
	await createWorkspaceForm.getByLabel('Timezone').fill('America/Sao_Paulo');
	await createWorkspaceForm.getByRole('button', { name: 'Criar' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
	await page.goto('/app/settings/workspace');
	await expect(updateForm.getByLabel('Nome')).toHaveValue('Filial');

	const switchForm = page.locator('form[action="?/switchWorkspace"]');
	await switchForm.locator('select[name="workspaceId"]').selectOption({ label: workspaceName });
	await switchForm.getByRole('button', { name: 'Trocar' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
	await page.goto('/app/settings/workspace');
	await expect(updateForm.getByLabel('Nome')).toHaveValue(workspaceName);

	await page.goto('/app/settings/users');
	const inviteForm = page.locator('form[action="?/invite"]');
	await inviteForm.evaluate((form) => form.setAttribute('novalidate', ''));
	await inviteForm.getByLabel('Email').fill('email-invalido');
	await inviteForm.getByRole('button', { name: 'Convidar' }).click();
	await expect(page.getByText('Confira email e papel.')).toBeVisible();

	await inviteForm.getByLabel('Email').fill(uniqueEmail('invite'));
	await inviteForm.getByLabel('Papel').selectOption('viewer');
	await inviteForm.getByRole('button', { name: 'Convidar' }).click();
	await expect(page.getByText('Convite criado:')).toBeVisible();
	await expect(page.getByRole('cell', { name: 'viewer' })).toBeVisible();

	await page.goto('/invite/token-invalido');
	await expect(page.getByText('Convite invalido ou expirado.')).toBeVisible();
});

test('covers planning, imports, attachments and audit flows', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page, { name: 'Limpeza', emoji: '🧼', color: '#0f766e' });

	await page.goto('/app/planning?periodMonth=2026-06-01');
	const budgetForm = page.locator('form[action="?/upsertBudget"]').first();
	await budgetForm.getByLabel('Valor').fill('abc');
	await budgetForm.getByRole('button', { name: 'Salvar' }).click();
	await expect(page.getByText('Confira os dados do orcamento.')).toBeVisible();

	await page.goto('/app/planning?periodMonth=2026-06-01');
	await budgetForm.getByLabel('Categoria').selectOption({ label: '🧼 Limpeza' });
	await budgetForm.getByLabel('Valor').fill('500,00');
	await budgetForm.getByLabel('Alerta (%)').fill('70');
	await budgetForm.getByRole('button', { name: 'Salvar' }).click();
	await expect(page.locator('.budget-item').filter({ hasText: 'Limpeza' })).toContainText(
		'R$ 500,00'
	);
	await page.getByRole('button', { name: 'Enviar alertas' }).click();
	await expect(page.getByText('Nenhum alerta de orcamento para enviar.')).toBeVisible();

	const planningPaymentForm = page.locator('form.compact-support');
	await planningPaymentForm.getByLabel('Novo pagamento').fill('Boleto');
	await planningPaymentForm.getByRole('button', { name: 'Criar' }).click();
	await expect(
		page.locator('form[action="?/createRecurring"] select[name="paymentMethodId"]')
	).toContainText('Boleto');

	const recurringForm = page.locator('form[action="?/createRecurring"]');
	await recurringForm.getByLabel('Descricao').fill('Limpeza mensal');
	await recurringForm.getByLabel('Valor').fill('abc');
	await recurringForm.getByLabel('Categoria').selectOption({ label: '🧼 Limpeza' });
	await recurringForm.getByLabel('Pagamento').selectOption({ label: 'Boleto' });
	await recurringForm.getByLabel('Inicio').fill('2026-06-01');
	await recurringForm.getByRole('button', { name: 'Criar recorrencia' }).click();
	await expect(page.getByText('Confira os dados da recorrencia.')).toBeVisible();

	await page.goto('/app/planning?periodMonth=2026-06-01');
	await recurringForm.getByLabel('Descricao').fill('Limpeza mensal');
	await recurringForm.getByLabel('Valor').fill('90,00');
	await recurringForm.getByLabel('Categoria').selectOption({ label: '🧼 Limpeza' });
	await recurringForm.getByLabel('Pagamento').selectOption({ label: 'Boleto' });
	await recurringForm.getByLabel('Inicio').fill('2026-06-01');
	await recurringForm.getByRole('button', { name: 'Criar recorrencia' }).click();
	await expect(page.locator('.recurring-item').filter({ hasText: 'Limpeza mensal' })).toBeVisible();

	await page.goto('/app/planning?periodMonth=2026-05-01');
	let recurringItem = page.locator('.recurring-item').filter({ hasText: 'Limpeza mensal' });
	await recurringItem.getByRole('button', { name: 'Pausar' }).click();
	await expect(page).toHaveURL(/\/app\/planning\?periodMonth=2026-05-01$/);
	recurringItem = page.locator('.recurring-item').filter({ hasText: 'Limpeza mensal' });
	await recurringItem.getByRole('button', { name: 'Retomar' }).click();
	await expect(page).toHaveURL(/\/app\/planning\?periodMonth=2026-05-01$/);

	await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30');
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Limpeza mensal' })
	).toContainText('R$ 90,00');

	await page.goto('/app/planning');
	await page.getByRole('button', { name: 'Gerar vencidas' }).click();
	await expect(page.getByText('Nenhuma recorrencia vencida para gerar.')).toBeVisible();

	await page.goto('/app/planning');
	const importForm = page.locator('form[action="?/importExpenses"]');
	await importForm.evaluate((form) => form.setAttribute('novalidate', ''));
	await importForm.getByRole('button', { name: 'Importar' }).click();
	await expect(page.getByText('Confira arquivo e formato.')).toBeVisible();

	await importForm.locator('input[type="file"]').setInputFiles({
		name: 'falhas.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('Data;Descricao;Valor\nbad;;abc\n')
	});
	await importForm.getByRole('button', { name: 'Importar' }).click();
	await expect(page.getByText('Nenhuma despesa importada.')).toBeVisible();
	await expect(
		page.locator('.import-errors').getByText('Linha -: Linha 2: data, descricao ou valor invalido.')
	).toBeVisible();
	await expect(page.getByRole('cell', { name: 'falhas.csv' })).toBeVisible();
	await expect(
		page.locator('.import-failure-details').filter({ hasText: '1 falha' })
	).toBeVisible();

	await page.goto('/app/categories');
	const ruleForm = page.locator('form[action="?/createRule"]');
	await ruleForm.getByLabel('Nome').fill('Fornecedor ACME');
	await ruleForm.getByLabel('Categoria').selectOption({ label: '🧼 Limpeza' });
	await ruleForm.getByLabel('Campo').selectOption('vendor');
	await ruleForm.getByLabel('Contem').fill('ACME');
	await ruleForm.getByRole('button', { name: 'Criar regra' }).click();
	await expect(page.locator('.rule-summary').filter({ hasText: 'Fornecedor ACME' })).toBeVisible();

	await page.goto('/app/planning');
	const importFormWithRule = page.locator('form[action="?/importExpenses"]');
	await importFormWithRule.locator('input[type="file"]').setInputFiles({
		name: 'despesas.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			'Data;Descricao;Valor;Fornecedor;Centro de custo\n26/06/2026;Produto limpeza;35,50;ACME Servicos;Operacao\n'
		)
	});
	await importFormWithRule.getByRole('button', { name: 'Importar' }).click();
	await expect(page.getByText('1 despesas importadas.')).toBeVisible();
	await expect(page.getByRole('cell', { name: 'despesas.csv' })).toBeVisible();

	await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30');
	const importedRow = page.locator('.expense-table-item').filter({ hasText: 'Produto limpeza' });
	await expect(importedRow).toBeVisible();
	await importedRow.locator('summary').click();
	await importedRow.locator('input[type="file"]').setInputFiles({
		name: 'recibo.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('recibo teste')
	});
	await importedRow.getByRole('button', { name: 'Anexar' }).click();
	const importedRowWithAttachment = page
		.locator('.expense-table-item')
		.filter({ hasText: 'Produto limpeza' });
	await expect(importedRowWithAttachment.locator('.expense-attachment-count')).toContainText('1');
	await importedRowWithAttachment.locator('summary').click();
	await expect(importedRowWithAttachment).toContainText('recibo.txt');

	const attachmentHref = await page
		.locator('.attachment-chip')
		.filter({ hasText: 'recibo.txt' })
		.first()
		.getAttribute('href');
	expect(attachmentHref).toBeTruthy();
	const attachmentResponse = await page.request.get(attachmentHref!);
	await expect(attachmentResponse).toBeOK();
	expect(await attachmentResponse.text()).toBe('recibo teste');
	expect((await page.request.get('/app/expenses/attachments/not-a-number')).status()).toBe(404);

	await importedRow.getByRole('button', { name: 'Excluir Produto limpeza' }).click();
	await page.getByRole('button', { name: 'Excluir', exact: true }).click();
	await expect(importedRow).toBeHidden();
	expect((await page.request.get(attachmentHref!)).status()).toBe(404);

	await page.goto('/app/settings/audit');
	await expect(page.getByRole('cell', { name: 'expense_import.completed' })).toBeVisible();
	await page.getByLabel('Acao').fill('expense_attachment.created');
	await page.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page.getByRole('cell', { name: 'expense_attachment.created' })).toBeVisible();
});

test('covers MFA setup, challenge and invalid code handling', async ({ page }) => {
	const { email } = await registerAndCreateWorkspace(page);
	const invitedEmail = uniqueEmail('mfa-invite');

	await page.goto('/app/settings/users');
	const inviteForm = page.locator('form[action="?/invite"]');
	await inviteForm.getByLabel('Email').fill(invitedEmail);
	await inviteForm.getByLabel('Papel').selectOption('viewer');
	await inviteForm.getByRole('button', { name: 'Convidar' }).click();
	const inviteNotice = page.locator('.notice.success').filter({ hasText: 'Convite criado:' });
	await expect(inviteNotice).toBeVisible();
	const inviteUrl = (await inviteNotice.textContent())?.replace('Convite criado:', '').trim();
	expect(inviteUrl).toBeTruthy();
	const invitePath = new URL(inviteUrl!, 'http://localhost:4173').pathname;

	await page.goto('/app/settings/security');
	await page.getByRole('button', { name: 'Configurar MFA' }).click();
	const secret = (await page.locator('.setup-code strong').textContent())?.trim();
	expect(secret).toBeTruthy();
	await page.getByLabel('Codigo gerado no app').fill(generateTotpCode(secret!));
	await page.getByRole('button', { name: 'Ativar' }).click();
	await expect(page.getByText('MFA ativado.')).toBeVisible();
	await expect(page.locator('.recovery-grid code')).toHaveCount(10);

	await page.goto('/app/settings/security');
	await page.locator('form[action="?/disable"]').getByLabel('Codigo atual').fill('000000');
	await page
		.locator('form[action="?/disable"]')
		.getByRole('button', { name: 'Desativar MFA' })
		.click();
	await expect(page.getByText('Codigo MFA invalido.')).toBeVisible();

	await page.locator('form[action="/logout"] button').click();
	await expect(page).toHaveURL(/\/login/);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Senha').fill('test-password-123');
	await page.getByRole('button', { name: 'Entrar' }).click();
	await expect(page).toHaveURL(/\/mfa/);
	await page.goto(invitePath);
	await expect(page).toHaveURL(/\/mfa/);
	expect(page.url()).toContain(`next=${encodeURIComponent(invitePath)}`);
	await page.getByLabel('Codigo do autenticador ou recovery code').fill(generateTotpCode(secret!));
	await page.getByRole('button', { name: 'Verificar' }).click();
	await expect(page).toHaveURL(/\/invite\//);
	await expect(page.getByRole('button', { name: 'Aceitar convite' })).toBeVisible();
	await page.goto('/app/dashboard');
	await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
