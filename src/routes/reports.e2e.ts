import { expect, type Browser, type Locator, type Page, test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({
	locale: 'pt-BR',
	extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
});

const workspaceName = 'Relatórios E2E';
const password = ['test', 'password', '123'].join('-');

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerAccount(page: Page, input: { email: string; name: string; next?: string }) {
	const search = input.next ? `?next=${encodeURIComponent(input.next)}` : '';

	for (let attempt = 0; attempt < 3; attempt += 1) {
		await page.goto(`/register${search}`);
		await page.waitForLoadState('networkidle');
		const form = page
			.locator('form')
			.filter({ has: page.getByRole('button', { name: 'Criar conta' }) });
		await expect(form.getByRole('button', { name: 'Criar conta' })).toBeVisible();
		await fillRegisterForm(form, input);
		await form.getByRole('button', { name: 'Criar conta' }).click();

		try {
			await expect(page).not.toHaveURL(/\/register/, { timeout: 5000 });
			return;
		} catch (error) {
			if (attempt === 2) throw error;
		}
	}
}

async function fillRegisterForm(form: Locator, input: { email: string; name: string }) {
	const name = form.locator('input[name="name"]');
	const email = form.locator('input[name="email"]');
	const passwordInput = form.locator('input[name="password"]');
	const passwordConfirmationInput = form.locator('input[name="passwordConfirmation"]');

	await name.fill(input.name);
	await email.fill(input.email);
	await passwordInput.fill(password);
	await passwordConfirmationInput.fill(password);
	await expect(name).toHaveValue(input.name);
	await expect(email).toHaveValue(input.email);
	await expect(passwordInput).toHaveValue(password);
	await expect(passwordConfirmationInput).toHaveValue(password);
}

async function browserDateLabel(page: Page, value: string, compact = false) {
	return page.evaluate(
		({ dateValue, compactWidth }) => {
			return new Intl.DateTimeFormat(undefined, {
				timeZone: 'UTC',
				day: '2-digit',
				month: '2-digit',
				year: compactWidth ? undefined : 'numeric'
			}).format(new Date(`${dateValue}T00:00:00Z`));
		},
		{ dateValue: value, compactWidth: compact }
	);
}

async function browserMonthLabel(page: Page, value: string, compact = false) {
	return page.evaluate(
		({ dateValue, compactWidth }) => {
			return new Intl.DateTimeFormat(undefined, {
				timeZone: 'UTC',
				month: compactWidth ? '2-digit' : 'short',
				year: compactWidth ? '2-digit' : 'numeric'
			}).format(new Date(`${dateValue}T00:00:00Z`));
		},
		{ dateValue: value, compactWidth: compact }
	);
}

async function registerAndCreateWorkspace(page: Page) {
	await registerAccount(page, {
		name: 'Report Tester',
		email: uniqueEmail('reports')
	});

	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Nome').fill(workspaceName);
	await page.getByRole('button', { name: 'Criar workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);

	const response = await page.request.post('/app/settings/workspace?/update', {
		form: {
			name: workspaceName,
			weekStartsOn: '1',
			currency: 'BRL'
		}
	});
	await expect(response).toBeOK();
}

async function createCategoryByRequest(
	page: Page,
	input: { name: string; color: string; icon: string }
) {
	const response = await page.request.post('/app/categories?/create', {
		form: input
	});
	await expect(response).toBeOK();
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

async function createExpenseFromForm(
	page: Page,
	input: {
		description: string;
		amount: string;
		date: string;
		category: string;
		payment: string;
		vendor: string;
		costCenter: string;
		competency: string;
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
	await form.getByLabel('Pagamento').selectOption({ label: input.payment });
	await chooseSearchableOption(form, 'Fornecedor', input.vendor);
	await chooseSearchableOption(form, 'Centro de custo', input.costCenter);
	await form.getByLabel('Competência').fill(input.competency);
	if (input.installments) await form.getByLabel('Parcelas').fill(input.installments);
	if (input.notes) await form.getByLabel('Notas').fill(input.notes);
	await form.getByRole('button', { name: 'Adicionar' }).click();
	await expect(expenseRow(page, input.description).first()).toBeVisible();
}

async function chooseSearchableOption(scope: Page | Locator, label: string, option: string) {
	const combobox = scope.getByRole('combobox', { name: label });
	await combobox.fill(option);
	await scope.getByRole('option', { name: option, exact: true }).click();
	await expect(combobox).toHaveValue(option);
}

function expenseRow(page: Page, text: string) {
	return page.locator('.expense-table-item').filter({ hasText: text });
}

function reportForm(page: Page) {
	return page.locator('form.form-grid').first();
}

function analyticalRow(page: Page, description: string) {
	return page.locator('.analytical-report-table tbody tr').filter({ hasText: description });
}

async function updateExpensePaymentStatus(
	page: Page,
	description: string,
	status: 'paid' | 'reconciled',
	paidAt: string
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
	await row.locator('input[name="reason"]').fill('Rejeitada pelo relatório');
	await row.getByRole('button', { name: 'Rejeitar' }).click();
	row = expenseRow(page, description);
	await expect(row).toContainText('Rejeitada');
}

async function attachReceipt(page: Page, description: string) {
	await page.goto('/app/expenses');
	let row = expenseRow(page, description);
	await row.locator('summary').click();
	await row.locator('input[type="file"]').setInputFiles({
		name: 'relatorio-recibo.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('recibo para relatório')
	});
	await row.getByRole('button', { name: 'Anexar' }).click();
	row = expenseRow(page, description);
	await expect(row.locator('.expense-attachment-count')).toContainText('1');
}

async function setupReportFixture(
	page: Page,
	options: { browser?: Browser; includePending?: boolean } = {}
) {
	await registerAndCreateWorkspace(page);
	await createCategoryByRequest(page, {
		name: 'Operacional',
		color: '#2563eb',
		icon: '🧰'
	});
	await createCategoryByRequest(page, {
		name: 'Administrativo',
		color: '#0f766e',
		icon: '💼'
	});
	await createCatalogByRequest(page, 'paymentMethod', 'Pix');
	await createCatalogByRequest(page, 'paymentMethod', 'Boleto');
	await createCatalogByRequest(page, 'vendor', 'Fornecedor Norte');
	await createCatalogByRequest(page, 'vendor', 'Fornecedor Sul');
	await createCatalogByRequest(page, 'costCenter', 'Centro Obra');
	await createCatalogByRequest(page, 'costCenter', 'Centro Backoffice');

	await createExpenseFromForm(page, {
		description: 'Relatório obra junho',
		amount: '100,00',
		date: '2026-06-10',
		category: '🧰 Operacional',
		payment: 'Pix',
		vendor: 'Fornecedor Norte',
		costCenter: 'Centro Obra',
		competency: '2026-06',
		notes: 'Nota obra'
	});
	await createExpenseFromForm(page, {
		description: 'Relatório admin julho',
		amount: '250,00',
		date: '2026-07-12',
		category: '💼 Administrativo',
		payment: 'Boleto',
		vendor: 'Fornecedor Sul',
		costCenter: 'Centro Backoffice',
		competency: '2026-07',
		notes: 'Nota administrativa'
	});
	await createExpenseFromForm(page, {
		description: 'Relatório rejeitado agosto',
		amount: '90,00',
		date: '2026-08-05',
		category: '🧰 Operacional',
		payment: 'Boleto',
		vendor: 'Fornecedor Sul',
		costCenter: 'Centro Backoffice',
		competency: '2026-08',
		notes: 'Nota rejeitada'
	});
	await createExpenseFromForm(page, {
		description: 'Relatório parcelado',
		amount: '50,00',
		date: '2026-06-15',
		category: '🧰 Operacional',
		payment: 'Pix',
		vendor: 'Fornecedor Norte',
		costCenter: 'Centro Obra',
		competency: '2026-06',
		installments: '2',
		notes: 'Parcela relatório'
	});

	await updateExpensePaymentStatus(page, 'Relatório obra junho', 'reconciled', '2026-06-11');
	await attachReceipt(page, 'Relatório obra junho');
	await updateExpensePaymentStatus(page, 'Relatório admin julho', 'paid', '2026-07-13');
	await rejectExpense(page, 'Relatório rejeitado agosto');

	if (options.includePending && options.browser) {
		await createPendingExpenseAsMember(page, options.browser);
	}
}

async function createPendingExpenseAsMember(ownerPage: Page, browser: Browser) {
	const invitedEmail = uniqueEmail('reports-member');
	await ownerPage.goto('/app/settings/users');
	const inviteForm = ownerPage.locator('form[action="?/invite"]');
	await inviteForm.getByLabel('Email').fill(invitedEmail);
	await inviteForm.getByLabel('Papel').selectOption('member');
	await inviteForm.getByRole('button', { name: 'Convidar' }).click();
	const inviteUrlRow = ownerPage.locator('.invite-url-row');
	await expect(inviteUrlRow).toBeVisible();
	const inviteUrl = (await inviteUrlRow.locator('.invite-url-code').textContent())?.trim();
	expect(inviteUrl).toBeTruthy();
	const invitePath = new URL(inviteUrl!, 'http://localhost:4173').pathname;

	const memberContext = await browser.newContext({
		locale: 'pt-BR',
		extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
	});
	try {
		const memberPage = await memberContext.newPage();
		await registerAccount(memberPage, {
			name: 'Report Member',
			email: invitedEmail,
			next: invitePath
		});
		await expect(memberPage).toHaveURL(/\/invite\//);
		await memberPage.getByRole('button', { name: 'Aceitar convite' }).click();
		await expect(memberPage).toHaveURL(/\/app\/dashboard/);

		await createExpenseFromForm(memberPage, {
			description: 'Relatório pendente membro',
			amount: '70,00',
			date: '2026-06-18',
			category: '🧰 Operacional',
			payment: 'Pix',
			vendor: 'Fornecedor Norte',
			costCenter: 'Centro Obra',
			competency: '2026-06',
			notes: 'Despesa pendente'
		});
		await expect(expenseRow(memberPage, 'Relatório pendente membro')).toContainText('Pendente');
	} finally {
		await memberContext.close();
	}
}

test('covers grouped reports for every grouping and shared filter', async ({ page }) => {
	await setupReportFixture(page);

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=category');
	await expect(page.getByRole('heading', { name: 'Relatórios' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Operacional' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'R$ 200,00' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Administrativo' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'R$ 250,00' })).toBeVisible();

	const form = reportForm(page);
	await form.getByLabel('Agrupar').selectOption('payment');
	await form.getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/groupBy=payment/);
	await expect(page.getByRole('cell', { name: 'Pix' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Boleto' })).toBeVisible();

	await reportForm(page).getByLabel('Agrupar').selectOption('month');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/groupBy=month/);
	await expect(
		page.getByRole('cell', { name: await browserMonthLabel(page, '2026-06-01') })
	).toBeVisible();
	await expect(
		page.getByRole('cell', { name: await browserMonthLabel(page, '2026-07-01') })
	).toBeVisible();
	await expect(page.getByRole('cell', { name: 'R$ 150,00' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'R$ 300,00' })).toBeVisible();

	await reportForm(page).getByLabel('Agrupar').selectOption('year');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/groupBy=year/);
	await expect(page.getByRole('cell', { name: '2026', exact: true })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'R$ 450,00' })).toBeVisible();

	await reportForm(page).getByLabel('Agrupar').selectOption('week');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/groupBy=week/);
	await expect(
		page.getByRole('cell', { name: await browserDateLabel(page, '2026-06-08') })
	).toBeVisible();
	await expect(
		page.getByRole('cell', { name: await browserDateLabel(page, '2026-06-15') })
	).toBeVisible();

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=category');
	await reportForm(page)
		.locator('select[name="categoryId"]')
		.selectOption({ label: 'Operacional' });
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/categoryId=\d+/);
	await expect(page.getByRole('cell', { name: 'Operacional' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Administrativo' })).toHaveCount(0);

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=category');
	await chooseSearchableOption(reportForm(page), 'Fornecedor', 'Fornecedor Norte');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/vendorId=\d+/);
	await expect(page.getByRole('cell', { name: 'Operacional' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Administrativo' })).toHaveCount(0);

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=category');
	await chooseSearchableOption(reportForm(page), 'Centro de custo', 'Centro Backoffice');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/costCenterId=\d+/);
	await expect(page.getByRole('cell', { name: 'Administrativo' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'R$ 250,00' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Operacional' })).toHaveCount(0);

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=category');
	await reportForm(page).getByLabel('Competência').fill('2026-06');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/competencyMonth=2026-06/);
	await expect(page.getByRole('cell', { name: 'Operacional' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'R$ 150,00' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Administrativo' })).toHaveCount(0);
});

test('covers analytical report columns and analytical-only filters', async ({ page, browser }) => {
	await setupReportFixture(page, { browser, includePending: true });

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=expense');
	await expect(page.getByRole('heading', { name: 'Analítico' })).toBeVisible();
	await expect(page.locator('.report-summary-grid')).toContainText('6');
	await expect(page.locator('.report-summary-grid')).toContainText('R$ 610,00');
	await expect(page.locator('.report-summary-grid')).toContainText('R$ 450,00');
	await expect(page.locator('.report-summary-grid')).toContainText('R$ 90,00');
	await expect(page.locator('.report-summary-grid')).toContainText('R$ 70,00');

	const obraRow = analyticalRow(page, 'Relatório obra junho');
	await expect(obraRow.locator('td').nth(0)).toContainText(
		await browserDateLabel(page, '2026-06-10', true)
	);
	await expect(obraRow.locator('td').nth(1)).toContainText(
		await browserMonthLabel(page, '2026-06-01', true)
	);
	await expect(obraRow).toContainText('🧰 Operacional');
	await expect(obraRow).toContainText('Fornecedor Norte');
	await expect(obraRow).toContainText('Centro Obra');
	await expect(obraRow).toContainText('Pix');
	await expect(obraRow).toContainText('Aprovada');
	await expect(obraRow).toContainText('Conciliada');
	await expect(obraRow.locator('td').nth(9)).toContainText('-');
	await expect(obraRow.locator('td').nth(10)).toContainText('1');
	await expect(obraRow).toContainText('R$ 100,00');
	await expect(obraRow).toContainText('Nota obra');

	const installmentRows = analyticalRow(page, 'Relatório parcelado');
	await expect(installmentRows).toHaveCount(2);
	await expect(installmentRows.filter({ hasText: '1/2' })).toBeVisible();
	await expect(installmentRows.filter({ hasText: '2/2' })).toBeVisible();

	await reportForm(page).getByLabel('Revisão').selectOption('pending');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/reviewStatus=pending/);
	await expect(analyticalRow(page, 'Relatório pendente membro')).toBeVisible();
	await expect(analyticalRow(page, 'Relatório obra junho')).toHaveCount(0);

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=expense');
	await reportForm(page).getByLabel('Revisão').selectOption('rejected');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(analyticalRow(page, 'Relatório rejeitado agosto')).toBeVisible();
	await expect(analyticalRow(page, 'Relatório rejeitado agosto')).toContainText('Rejeitada');

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=expense');
	await reportForm(page).locator('select[name="paymentStatus"]').selectOption('paid');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(analyticalRow(page, 'Relatório admin julho')).toBeVisible();
	await expect(analyticalRow(page, 'Relatório admin julho')).toContainText('Paga');
	await expect(analyticalRow(page, 'Relatório obra junho')).toHaveCount(0);

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=expense');
	await reportForm(page).locator('select[name="paymentStatus"]').selectOption('reconciled');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(analyticalRow(page, 'Relatório obra junho')).toBeVisible();
	await expect(analyticalRow(page, 'Relatório obra junho')).toContainText('Conciliada');

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=expense');
	await reportForm(page).locator('select[name="paymentStatus"]').selectOption('unpaid');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(analyticalRow(page, 'Relatório parcelado')).toHaveCount(2);
	await expect(analyticalRow(page, 'Relatório rejeitado agosto')).toBeVisible();
	await expect(analyticalRow(page, 'Relatório pendente membro')).toBeVisible();

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=expense');
	await reportForm(page).getByLabel('Busca').fill('Fornecedor Sul');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Fornecedor Sul');
	await expect(analyticalRow(page, 'Relatório admin julho')).toBeVisible();
	await expect(analyticalRow(page, 'Relatório rejeitado agosto')).toBeVisible();
	await expect(analyticalRow(page, 'Relatório obra junho')).toHaveCount(0);

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=expense');
	await reportForm(page).getByLabel('Busca').fill('sem resultado');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect(page.getByText('Sem despesas no período.')).toBeVisible();
});

test('exports grouped and analytical CSV with every group option', async ({ page, browser }) => {
	await setupReportFixture(page, { browser, includePending: true });

	const categoryCsv = await page.request.get(
		'/app/reports/export.csv?from=2026-06-01&to=2026-08-31&groupBy=category'
	);
	await expect(categoryCsv).toBeOK();
	const categoryText = await categoryCsv.text();
	expect(categoryText).toContain('group,amount_cents');
	expect(categoryText).toContain('"Operacional",20000');
	expect(categoryText).toContain('"Administrativo",25000');

	const paymentCsv = await page.request.get(
		'/app/reports/export.csv?from=2026-06-01&to=2026-08-31&groupBy=payment'
	);
	await expect(paymentCsv).toBeOK();
	const paymentText = await paymentCsv.text();
	expect(paymentText).toContain('"Boleto",25000');
	expect(paymentText).toContain('"Pix",20000');

	const monthCsv = await page.request.get(
		'/app/reports/export.csv?from=2026-06-01&to=2026-08-31&groupBy=month'
	);
	await expect(monthCsv).toBeOK();
	expect(await monthCsv.text()).toContain('"2026-07-01",30000');

	const yearCsv = await page.request.get(
		'/app/reports/export.csv?from=2026-06-01&to=2026-08-31&groupBy=year'
	);
	await expect(yearCsv).toBeOK();
	expect(await yearCsv.text()).toContain('"2026-01-01",45000');

	const weekCsv = await page.request.get(
		'/app/reports/export.csv?from=2026-06-01&to=2026-08-31&groupBy=week'
	);
	await expect(weekCsv).toBeOK();
	expect(await weekCsv.text()).toContain('"2026-06-08",10000');

	await page.goto('/app/reports?from=2026-06-01&to=2026-08-31&groupBy=expense');
	await chooseSearchableOption(reportForm(page), 'Fornecedor', 'Fornecedor Sul');
	await chooseSearchableOption(reportForm(page), 'Centro de custo', 'Centro Backoffice');
	await reportForm(page).getByLabel('Competência').fill('2026-07');
	await reportForm(page).getByLabel('Revisão').selectOption('approved');
	await reportForm(page).locator('select[name="paymentStatus"]').selectOption('paid');
	await reportForm(page).getByLabel('Busca').fill('admin');
	await reportForm(page).getByRole('button', { name: 'Gerar' }).click();
	await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('admin');
	await expect.poll(() => new URL(page.url()).searchParams.get('vendorId')).toBeTruthy();
	await expect.poll(() => new URL(page.url()).searchParams.get('costCenterId')).toBeTruthy();
	await expect.poll(() => new URL(page.url()).searchParams.get('competencyMonth')).toBe('2026-07');
	await expect.poll(() => new URL(page.url()).searchParams.get('reviewStatus')).toBe('approved');
	await expect.poll(() => new URL(page.url()).searchParams.get('paymentStatus')).toBe('paid');
	await expect(analyticalRow(page, 'Relatório admin julho')).toBeVisible();
	await expect(analyticalRow(page, 'Relatório obra junho')).toHaveCount(0);
	const filteredUrl = new URL(page.url());
	const analyticalCsv = await page.request.get(`/app/reports/export.csv${filteredUrl.search}`);
	await expect(analyticalCsv).toBeOK();
	const analyticalText = await analyticalCsv.text();
	expect(analyticalText).toContain(
		'id,date,competency,description,category,vendor,cost_center,payment,amount_cents'
	);
	expect(analyticalText).toContain('"Relatório admin julho"');
	expect(analyticalText).toContain('"💼 Administrativo"');
	expect(analyticalText).toContain('"Fornecedor Sul"');
	expect(analyticalText).toContain('"Centro Backoffice"');
	expect(analyticalText).toContain('"Boleto"');
	expect(analyticalText).toContain('25000');
	expect(analyticalText).toContain('"Aprovada"');
	expect(analyticalText).toContain('"Paga"');
	expect(analyticalText).not.toContain('Relatório obra junho');
});

test('rejects invalid report filters on page and CSV export', async ({ page }) => {
	await registerAndCreateWorkspace(page);

	for (const query of [
		'from=2026-08-31&to=2026-06-01&groupBy=category',
		'from=2026-06-31&to=2026-08-31&groupBy=category',
		'from=2026-06-01&to=2026-08-31&groupBy=invalid',
		'from=2026-06-01&to=2026-08-31&groupBy=category&categoryId=abc',
		'from=2026-06-01&to=2026-08-31&groupBy=category&vendorId=abc',
		'from=2026-06-01&to=2026-08-31&groupBy=category&costCenterId=abc',
		'from=2026-06-01&to=2026-08-31&groupBy=expense&competencyMonth=2026-13',
		'from=2026-06-01&to=2026-08-31&groupBy=expense&reviewStatus=invalid',
		'from=2026-06-01&to=2026-08-31&groupBy=expense&paymentStatus=invalid',
		`from=2026-06-01&to=2026-08-31&groupBy=expense&q=${'a'.repeat(121)}`
	]) {
		expect((await page.request.get(`/app/reports?${query}`)).status()).toBe(400);
		expect((await page.request.get(`/app/reports/export.csv?${query}`)).status()).toBe(400);
	}
});
