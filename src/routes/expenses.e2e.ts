import { expect, type Browser, type Locator, type Page, test } from '@playwright/test';

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
	await page
		.locator('input[name="passwordConfirmation"]')
		.fill(['test', 'password', '123'].join('-'));
	await page.getByRole('button', { name: 'Criar conta' }).click();

	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Nome').fill(workspaceName);
	await page.getByRole('button', { name: 'Criar workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
}

async function registerAccount(page: Page, input: { email: string; name: string; next?: string }) {
	const target = input.next ? `/register?next=${encodeURIComponent(input.next)}` : '/register';
	await page.goto(target);
	await page.getByLabel('Nome').fill(input.name);
	await page.getByLabel('Email').fill(input.email);
	await page.locator('input[name="password"]').fill(['test', 'password', '123'].join('-'));
	await page
		.locator('input[name="passwordConfirmation"]')
		.fill(['test', 'password', '123'].join('-'));
	await page.getByRole('button', { name: 'Criar conta' }).click();
}

async function inviteAndAcceptMember(browser: Browser, page: Page) {
	await page.goto('/app/settings/users');
	const email = uniqueEmail('expenses-member');
	const inviteForm = page.locator('form[action="?/invite"]');
	await inviteForm.getByLabel('Email').fill(email);
	await inviteForm.getByLabel('Papel').selectOption('member');
	await inviteForm.getByRole('button', { name: 'Convidar' }).click();
	const inviteUrl = (await page.locator('.invite-url-row .invite-url-code').textContent())?.trim();
	expect(inviteUrl).toBeTruthy();

	const context = await browser.newContext({
		locale: 'pt-BR',
		extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
	});
	const memberPage = await context.newPage();
	const invitePath = new URL(inviteUrl!, 'http://localhost:4173').pathname;
	await registerAccount(memberPage, {
		email,
		name: 'Expense Member',
		next: invitePath
	});
	await expect(memberPage).toHaveURL(/\/invite\//);
	await memberPage.getByRole('button', { name: 'Aceitar convite' }).click();
	await expect(memberPage).toHaveURL(/\/app\/dashboard/);

	return { context, page: memberPage };
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

async function openSupportCatalogDialog(page: Page) {
	await page.goto('/app/expenses');
	await page.getByRole('button', { name: 'Cadastros' }).click();
	const dialog = page.getByRole('dialog', { name: 'Cadastros de apoio' });
	await expect(dialog).toBeVisible();
	return dialog;
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

async function createLargePngAttachment(page: Page) {
	const bytes = await page.evaluate(async () => {
		const width = 1024;
		const height = 1024;
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas is unavailable');
		const imageData = context.createImageData(width, height);
		let seed = 7;

		for (let index = 0; index < imageData.data.length; index += 4) {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			imageData.data[index] = seed & 255;
			imageData.data[index + 1] = (seed >>> 8) & 255;
			imageData.data[index + 2] = (seed >>> 16) & 255;
			imageData.data[index + 3] = 255;
		}

		context.putImageData(imageData, 0, 0);
		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((value) => {
				if (value) resolve(value);
				else reject(new Error('Could not create PNG attachment'));
			}, 'image/png');
		});
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});

	expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
	return Buffer.from(bytes);
}

async function openCatalogDialog(page: Page, kind: 'paymentMethod' | 'vendor' | 'costCenter') {
	const dialog = await openSupportCatalogDialog(page);
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

async function catalogIdByLabel(
	page: Page,
	kind: 'paymentMethod' | 'vendor' | 'costCenter',
	label: string
) {
	await page.goto('/app/expenses');
	const fieldName =
		kind === 'paymentMethod' ? 'paymentMethodId' : kind === 'vendor' ? 'vendorId' : 'costCenterId';
	const option = page
		.locator(`form.expense-create-form select[name="${fieldName}"] option`)
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

async function visibleBox(locator: Locator, name: string) {
	await expect(locator, `${name} should be visible`).toBeVisible();
	const box = await locator.boundingBox();
	expect(box, `${name} should have a rendered box`).not.toBeNull();
	return box!;
}

function expectCloseTo(actual: number, expected: number, label: string, tolerance = 4) {
	expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(tolerance);
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

test('keeps desktop expense table columns and delete action aligned', async ({ page }) => {
	await page.setViewportSize({ width: 1440, height: 900 });
	await registerAndCreateWorkspace(page);
	await createCategory(page, { name: 'Layout', emoji: '🧰', color: '#2563eb' });
	await createCatalogByRequest(page, 'paymentMethod', 'Pix Layout');
	await createCatalogByRequest(page, 'vendor', 'Fornecedor Layout');
	await createCatalogByRequest(page, 'costCenter', 'Centro Layout');
	await createExpenseFromForm(page, {
		description: 'Alinhamento desktop',
		amount: '123,45',
		date: '2026-06-16',
		category: '🧰 Layout',
		payment: 'Pix Layout',
		vendor: 'Fornecedor Layout',
		costCenter: 'Centro Layout',
		notes: 'Observação de layout'
	});

	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(`/app/expenses?q=${encodeURIComponent('Alinhamento desktop')}`);

	const table = page.locator('.expense-table');
	await expect(table).toHaveClass(/with-select/);
	const headerCells = table.locator('.expense-table-header > span');
	await expect(headerCells).toHaveText([
		'Revisão',
		'Data',
		'Descrição',
		'Categoria',
		'Pagamento',
		'Detalhes',
		'Valor',
		'Ações'
	]);

	const row = expenseRow(page, 'Alinhamento desktop').first();
	await expect(row).toBeVisible();
	const rowSummary = row.locator('.expense-table-row');
	const rowBox = await visibleBox(rowSummary, 'expense row');
	const columns = [
		{ header: 1, cell: row.locator('.expense-table-date'), label: 'date column left edge' },
		{
			header: 2,
			cell: row.locator('.expense-table-description'),
			label: 'description column left edge'
		},
		{ header: 3, cell: row.locator('.expense-table-category'), label: 'category column left edge' },
		{ header: 4, cell: row.locator('.expense-table-payment'), label: 'payment column left edge' },
		{ header: 5, cell: row.locator('.expense-table-note'), label: 'details column left edge' },
		{ header: 7, cell: row.locator('.expense-table-action'), label: 'actions column left edge' }
	];

	for (const column of columns) {
		const headerBox = await visibleBox(headerCells.nth(column.header), `${column.label} header`);
		const cellBox = await visibleBox(column.cell, `${column.label} cell`);
		expectCloseTo(cellBox.x, headerBox.x, column.label);
	}

	const valueHeaderBox = await visibleBox(headerCells.nth(6), 'value column header');
	const amountBox = await visibleBox(row.locator('.expense-table-amount'), 'amount column cell');
	expectCloseTo(
		amountBox.x + amountBox.width,
		valueHeaderBox.x + valueHeaderBox.width,
		'value column right edge'
	);

	const actionBox = await visibleBox(row.locator('.expense-table-action'), 'actions column cell');
	const deleteBox = await visibleBox(
		row.getByRole('button', { name: 'Excluir Alinhamento desktop' }),
		'delete action'
	);
	const rowCenter = rowBox.y + rowBox.height / 2;
	const actionCenter = actionBox.y + actionBox.height / 2;
	const deleteCenter = deleteBox.y + deleteBox.height / 2;
	expectCloseTo(deleteCenter, rowCenter, 'delete action row vertical center');
	expectCloseTo(deleteCenter, actionCenter, 'delete action field vertical center');

	await row.locator('summary').click();
	const editForm = row.locator('.expense-edit-form-table');
	const workflowPanel = row.locator('.expense-workflow-panel');
	await expect(editForm).toBeVisible();
	await expect(workflowPanel).toBeVisible();
	const editFormBox = await visibleBox(editForm, 'desktop edit form');
	const workflowPanelBox = await visibleBox(workflowPanel, 'desktop workflow panel');
	expectCloseTo(editFormBox.y, workflowPanelBox.y, 'expanded desktop panels top edge', 8);
	expect(
		editFormBox.x + editFormBox.width,
		'edit form should sit before workflow rail'
	).toBeLessThanOrEqual(workflowPanelBox.x + 1);
	expect(
		workflowPanelBox.width,
		'workflow rail should be compact instead of spanning the full row'
	).toBeLessThan(rowBox.width * 0.35);
});

test('keeps tablet expense actions compact above the edit form', async ({ page }) => {
	await page.setViewportSize({ width: 820, height: 1180 });
	await registerAndCreateWorkspace(page);
	await createCategory(page, { name: 'Tablet', emoji: '🧰', color: '#2563eb' });
	const tabletCategoryId = await categoryIdByLabel(page, 'Tablet');
	await createExpenseByRequest(page, {
		categoryId: tabletCategoryId,
		description: 'Alinhamento tablet',
		amount: '554,69',
		expenseDate: '2026-07-07'
	});

	await page.setViewportSize({ width: 820, height: 1180 });
	await page.goto(`/app/expenses?q=${encodeURIComponent('Alinhamento tablet')}`);
	const row = expenseRow(page, 'Alinhamento tablet').first();
	await expect(row).toBeVisible();
	await row.locator('summary').click();

	const rowBox = await visibleBox(row, 'tablet expense row');
	const workflowPanel = row.locator('.expense-workflow-panel');
	const editForm = row.locator('.expense-edit-form-table');
	const workflowBox = await visibleBox(workflowPanel, 'tablet workflow panel');
	const editFormBox = await visibleBox(editForm, 'tablet edit form');
	const summaryBox = await visibleBox(
		workflowPanel.locator('.workflow-summary'),
		'tablet workflow summary'
	);
	const approveBox = await visibleBox(
		workflowPanel.locator('.workflow-approve-form'),
		'tablet approve form'
	);
	const rejectBox = await visibleBox(workflowPanel.locator('.reject-form'), 'tablet reject form');
	const paymentBox = await visibleBox(
		workflowPanel.locator("form[action='?/payment']"),
		'tablet payment form'
	);

	expect(workflowBox.width, 'tablet workflow panel should use the row width').toBeGreaterThan(
		rowBox.width * 0.9
	);
	expect(editFormBox.width, 'tablet edit form should align to the workflow width').toBeGreaterThan(
		rowBox.width * 0.9
	);
	expect(summaryBox.y, 'status summary should be the first workflow row').toBeLessThan(
		approveBox.y
	);
	expectCloseTo(approveBox.y, rejectBox.y, 'tablet approve and reject row alignment', 8);
	expect(paymentBox.y, 'payment controls should sit below review controls').toBeGreaterThan(
		approveBox.y
	);
	expect(
		paymentBox.width,
		'payment controls should span the tablet workflow panel'
	).toBeGreaterThan(workflowBox.width * 0.9);
	expect(
		editFormBox.y,
		'edit form should start below tablet workflow panel'
	).toBeGreaterThanOrEqual(workflowBox.y + workflowBox.height - 8);
	expect(
		workflowBox.height,
		'tablet workflow panel should stay compact instead of creating a large empty band'
	).toBeLessThan(230);
});

test('keeps mobile expense cards and review actions aligned above navigation', async ({
	browser,
	page
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await registerAndCreateWorkspace(page);
	await createCategory(page, { name: 'Mobile', emoji: '🧰', color: '#2563eb' });
	await createCatalogByRequest(page, 'paymentMethod', 'Pix Mobile');
	await createCatalogByRequest(page, 'vendor', 'Fornecedor Mobile');
	await createCatalogByRequest(page, 'costCenter', 'Centro Mobile');
	const mobileCategoryId = await categoryIdByLabel(page, 'Mobile');
	const memberSession = await inviteAndAcceptMember(browser, page);
	try {
		await createExpenseByRequest(memberSession.page, {
			categoryId: mobileCategoryId,
			description: 'Mobile revisão',
			amount: '554,69',
			expenseDate: '2026-07-07'
		});
		await createExpenseByRequest(memberSession.page, {
			categoryId: mobileCategoryId,
			description: 'Mobile revisão meio',
			amount: '13,86',
			expenseDate: '2026-07-05'
		});
		await createExpenseByRequest(memberSession.page, {
			categoryId: mobileCategoryId,
			description: 'Mobile revisão baixa',
			amount: '16,46',
			expenseDate: '2026-07-03'
		});
	} finally {
		await memberSession.context.close();
	}

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/app/expenses');
	await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
	const row = expenseRow(page, 'Mobile revisão baixa').first();
	await expect(row).toBeVisible();

	const dateBox = await visibleBox(row.locator('.expense-table-date'), 'mobile date');
	const amountBox = await visibleBox(row.locator('.expense-table-amount'), 'mobile amount');
	const deleteBox = await visibleBox(
		row.getByRole('button', { name: 'Excluir Mobile revisão baixa' }),
		'mobile delete action'
	);
	expectCloseTo(
		dateBox.y + dateBox.height / 2,
		amountBox.y + amountBox.height / 2,
		'mobile date and amount vertical center',
		8
	);
	expectCloseTo(
		deleteBox.y + deleteBox.height / 2,
		amountBox.y + amountBox.height / 2,
		'mobile delete and amount vertical center',
		14
	);

	const categoryBox = await visibleBox(row.locator('.expense-table-category'), 'mobile category');
	const editBox = await visibleBox(row.locator('.expense-table-action'), 'mobile edit action');
	await expect(row.locator('.expense-table-action')).toContainText('Ações');
	expectCloseTo(
		categoryBox.y + categoryBox.height / 2,
		editBox.y + editBox.height / 2,
		'mobile category and edit vertical center',
		10
	);

	const selectLabel = row.locator('.expense-select-label');
	const unselectedStyle = await selectLabel.evaluate((element) => {
		const style = getComputedStyle(element);
		return {
			backgroundColor: style.backgroundColor,
			borderColor: style.borderColor,
			boxShadow: style.boxShadow
		};
	});
	const primaryColor = await page.evaluate(() => {
		const probe = document.createElement('span');
		probe.style.color = getComputedStyle(document.documentElement)
			.getPropertyValue('--color-primary')
			.trim();
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	const selectCheckbox = row.locator('.expense-select-checkbox');
	await selectCheckbox.check();
	await expect(selectCheckbox).toBeChecked();
	await expect(selectLabel).toHaveClass(/selected/);
	await expect
		.poll(async () => {
			const selectedStyle = await selectLabel.evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					backgroundColor: style.backgroundColor,
					borderColor: style.borderColor,
					boxShadow: style.boxShadow
				};
			});
			const checkboxStyle = await selectCheckbox.evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					backgroundColor: style.backgroundColor,
					borderColor: style.borderColor
				};
			});
			return (
				selectedStyle.backgroundColor === primaryColor &&
				checkboxStyle.backgroundColor === 'rgba(0, 0, 0, 0)' &&
				selectedStyle.borderColor !== unselectedStyle.borderColor &&
				selectedStyle.boxShadow !== unselectedStyle.boxShadow
			);
		}, 'selected checkbox control should fill with the primary color')
		.toBe(true);
	const bulkActionBar = page.locator('.bulk-action-bar');
	await expect(bulkActionBar).toBeVisible();
	await expect
		.poll(async () => {
			const bulkBox = await bulkActionBar.boundingBox();
			const bottomNavBox = await page.locator('.sidebar').boundingBox();
			if (!bulkBox || !bottomNavBox) return false;
			return bulkBox.y + bulkBox.height <= bottomNavBox.y - 10;
		}, 'bulk review actions should stay above mobile nav after selecting a pending expense')
		.toBe(true);
	await expect(bulkActionBar.getByRole('button', { name: 'Aprovar' })).toHaveClass(
		/review-approve/
	);
	const filterForm = page.locator('form.expense-filter-form');
	await filterForm.getByLabel('Busca').fill('Mobile revisão baixa');
	await filterForm.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page).toHaveURL(/q=Mobile/);
	await expect(bulkActionBar).toBeHidden();
	await expect(selectCheckbox).not.toBeChecked();

	await row.locator('summary').click();
	const workflowPanel = row.locator('.expense-workflow-panel');
	await expect(workflowPanel).toBeVisible();
	const approveButton = row.getByRole('button', { name: 'Aprovar' });
	await expect(approveButton).toBeVisible();
	await expect
		.poll(async () => {
			const workflowBox = await workflowPanel.boundingBox();
			const bottomNavBox = await page.locator('.sidebar').boundingBox();
			if (!workflowBox || !bottomNavBox) return false;
			return workflowBox.y + workflowBox.height <= bottomNavBox.y - 4;
		}, 'expanded workflow actions should move above mobile nav after opening')
		.toBe(true);
	await expect(approveButton).toHaveClass(/review-approve/);
});

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
	const paymentDialog = page.getByRole('dialog', { name: 'Cadastros de apoio' });
	await expect(paymentDialog).toBeVisible();
	await expect(paymentDialog.getByRole('status')).toHaveText('Item atualizado com sucesso.');
	await expect(
		page.locator('form.expense-create-form select[name="paymentMethodId"]')
	).toContainText('Cartão central');
	await page.keyboard.press('Escape');
	await expect(paymentDialog).toBeHidden();
	await openCatalogDialog(page, 'paymentMethod');
	await expect(
		page.getByRole('dialog', { name: 'Cadastros de apoio' }).getByRole('status')
	).toHaveCount(0);
	await page.keyboard.press('Escape');

	await createCatalogFromDialog(page, 'paymentMethod', 'Pagamento recorrente');
	const recurringCategoryId = await categoryIdByLabel(page, 'Operacional');
	const recurringPaymentId = await catalogIdByLabel(page, 'paymentMethod', 'Pagamento recorrente');
	const recurringResponse = await page.request.post('/app/planning?/createRecurring', {
		form: {
			categoryId: recurringCategoryId,
			description: 'Recorrência com catálogo exclusivo',
			amount: '25,00',
			frequency: 'monthly',
			intervalCount: '1',
			startDate: '2099-01-01',
			endDate: '',
			paymentMethodId: recurringPaymentId,
			notes: '',
			returnTo: '/app/planning'
		}
	});
	await expect(recurringResponse).toBeOK();
	const recurringDialog = await openCatalogDialog(page, 'paymentMethod');
	await expect(
		recurringDialog.getByRole('button', {
			name: 'Arquivar pagamento Pagamento recorrente'
		})
	).toBeVisible();
	await recurringDialog.getByRole('button', { name: 'Fechar' }).click();

	await createCatalogFromDialog(page, 'vendor', 'Fornecedor temporário');
	await openCatalogDialog(page, 'vendor');
	await page.getByRole('button', { name: 'Excluir fornecedor Fornecedor temporário' }).click();
	const vendorDialog = page.getByRole('dialog', { name: 'Cadastros de apoio' });
	await expect(vendorDialog).toBeVisible();
	await expect(vendorDialog.getByRole('status')).toHaveText('Item excluído com sucesso.');
	await expect(vendorDialog.getByLabel('Editar fornecedor Fornecedor temporário')).toHaveCount(0);
	await vendorDialog.getByRole('button', { name: 'Fechar' }).click();
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
	await expect(page.getByRole('dialog', { name: 'Cadastros de apoio' })).toBeVisible();
	await expect(
		page.getByRole('dialog', { name: 'Cadastros de apoio' }).getByRole('status')
	).toHaveText('Item arquivado com sucesso.');
	await page
		.getByRole('dialog', { name: 'Cadastros de apoio' })
		.getByRole('button', { name: 'Fechar' })
		.click();
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

test('manages categories from the expenses support dialog', async ({ page }) => {
	await registerAndCreateWorkspace(page);

	let dialog = await openSupportCatalogDialog(page);
	const categoriesTab = dialog.getByRole('tab', { name: /Categorias/ });
	await categoriesTab.click();
	await expect(categoriesTab).toHaveAttribute('aria-selected', 'true');

	const createForm = dialog.locator('form.support-catalog-category-form');
	await createForm.getByLabel('Nova categoria').fill('Categoria Sem Uso');
	await createForm.getByLabel('Cor').fill('#0f766e');
	await createForm.getByLabel('Emoji').selectOption('🧾');
	await createForm.getByRole('button', { name: 'Criar' }).click();

	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('status')).toHaveText('Categoria criada com sucesso.');
	await expect(dialog.getByLabel('Editar categoria Categoria Sem Uso')).toBeVisible();
	await dialog.getByRole('button', { name: 'Excluir categoria Categoria Sem Uso' }).click();

	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('status')).toHaveText('Categoria excluída com sucesso.');
	await expect(dialog.getByLabel('Editar categoria Categoria Sem Uso')).toHaveCount(0);

	const categoryCreateForm = dialog.locator('form.support-catalog-category-form');
	await categoryCreateForm.getByLabel('Nova categoria').fill('Categoria Dialog');
	await categoryCreateForm.getByLabel('Cor').fill('#0f766e');
	await categoryCreateForm.getByLabel('Emoji').selectOption('🧾');
	await categoryCreateForm.getByRole('button', { name: 'Criar' }).click();

	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('status')).toHaveText('Categoria criada com sucesso.');
	await expect(dialog.getByLabel('Editar categoria Categoria Dialog')).toBeVisible();
	await expect(page.locator('form.expense-create-form select[name="categoryId"]')).toContainText(
		'Categoria Dialog'
	);

	const editForm = dialog
		.getByLabel('Editar categoria Categoria Dialog')
		.locator('xpath=ancestor::form');
	await editForm.getByLabel('Editar categoria Categoria Dialog').fill('Categoria Revisada');
	await editForm.getByLabel('Cor Categoria Dialog').fill('#2563eb');
	await editForm.getByLabel('Emoji Categoria Dialog').selectOption('🧰');
	await editForm.getByRole('button', { name: 'Salvar' }).click();

	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('status')).toHaveText('Categoria atualizada com sucesso.');
	await expect(page.locator('form.expense-create-form select[name="categoryId"]')).toContainText(
		'Categoria Revisada'
	);
	await expect(
		page.locator('form.expense-create-form select[name="categoryId"]')
	).not.toContainText('Categoria Dialog');
	await dialog.getByRole('button', { name: 'Fechar' }).click();

	await createExpenseFromForm(page, {
		description: 'Categoria vinculada',
		amount: '25,00',
		date: '2026-06-12',
		category: '🧰 Categoria Revisada'
	});

	dialog = await openSupportCatalogDialog(page);
	await dialog.getByRole('tab', { name: /Categorias/ }).click();
	await expect(dialog.getByLabel('Editar categoria Categoria Revisada')).toBeVisible();
	await dialog.getByRole('button', { name: 'Arquivar categoria Categoria Revisada' }).click();

	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('status')).toHaveText('Categoria arquivada com sucesso.');
	await expect(
		page.locator('form.expense-create-form select[name="categoryId"]')
	).not.toContainText('Categoria Revisada');

	await expect(dialog.getByLabel('Editar categoria Categoria Revisada')).toHaveCount(0);
	await dialog.getByRole('button', { name: /Categorias arquivadas/ }).click();
	await expect(dialog.getByLabel('Editar categoria Categoria Revisada')).toBeVisible();
	await dialog.getByRole('button', { name: 'Restaurar categoria Categoria Revisada' }).click();

	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('status')).toHaveText('Categoria restaurada com sucesso.');
	await expect(page.locator('form.expense-create-form select[name="categoryId"]')).toContainText(
		'Categoria Revisada'
	);
});

test('exposes keyboard tabs and expense table relationships', async ({ page }) => {
	await registerAndCreateWorkspace(page);

	const dialog = await openSupportCatalogDialog(page);
	const paymentsTab = dialog.getByRole('tab', { name: /Pagamentos/ });
	const vendorsTab = dialog.getByRole('tab', { name: /Fornecedores/ });
	const categoriesTab = dialog.getByRole('tab', { name: /Categorias/ });
	const panel = dialog.getByRole('tabpanel');

	await paymentsTab.focus();
	await paymentsTab.press('ArrowRight');
	await expect(vendorsTab).toBeFocused();
	await expect(vendorsTab).toHaveAttribute('aria-selected', 'true');
	await vendorsTab.press('End');
	await expect(categoriesTab).toBeFocused();
	await expect(categoriesTab).toHaveAttribute('aria-selected', 'true');
	await categoriesTab.press('Home');
	await expect(paymentsTab).toBeFocused();
	await expect(paymentsTab).toHaveAttribute('aria-selected', 'true');
	await expect(paymentsTab).toHaveAttribute('aria-controls', 'support-catalog-panel');
	await expect(panel).toHaveAttribute('id', 'support-catalog-panel');
	await dialog.getByRole('button', { name: 'Fechar' }).click();

	await createCategory(page);
	await createExpenseFromForm(page, {
		description: 'Linha acessível',
		amount: '42,00',
		date: '2026-06-15',
		category: '🧰 Operacional'
	});

	const table = page.getByRole('table', { name: 'Despesas lançadas' });
	await expect(table).toBeVisible();
	for (const heading of [
		'Revisão',
		'Data',
		'Descrição',
		'Categoria',
		'Pagamento',
		'Detalhes',
		'Valor',
		'Ações'
	]) {
		await expect(table.getByRole('columnheader', { name: heading })).toBeAttached();
	}

	const expenseTableRow = table.getByRole('row').filter({ hasText: 'Linha acessível' });
	await expect(expenseTableRow).toHaveAttribute('aria-expanded', 'false');
	await expect(expenseTableRow.getByRole('cell')).toHaveCount(8);
	await expenseTableRow.focus();
	await expenseTableRow.press('Enter');
	await expect(expenseTableRow).toHaveAttribute('aria-expanded', 'true');
	await expect(table.locator('.expense-details-cell[role="cell"]')).toBeVisible();
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

	await createForm.getByLabel('Valor da parcela').fill('1.000.000.000,01');
	await createForm.getByRole('button', { name: 'Adicionar' }).click();
	await expect(createForm.locator('#err-amount')).toHaveText('Valor excede o máximo permitido.');
	await expect(createForm.getByLabel('Descrição')).toHaveValue('Valor inválido');
	await expect(createForm.getByLabel('Valor da parcela')).toHaveValue('1.000.000.000,01');
	await expect(createForm.getByLabel('Data', { exact: true })).toHaveValue('2026-01-15');
	await expect(createForm.getByLabel('Categoria')).toHaveValue(/\d+/);

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
	const receiptBody = Buffer.alloc(700 * 1024, 'a');
	await row.locator('input[type="file"]').setInputFiles({
		name: 'recibo.txt',
		mimeType: 'text/plain',
		buffer: receiptBody
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
	expect((await attachmentResponse.body()).length).toBe(receiptBody.length);

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

test('compresses image attachments in the browser before upload', async ({ page }) => {
	test.setTimeout(60_000);

	await registerAndCreateWorkspace(page);
	await createCategory(page);
	await createExpenseFromForm(page, {
		description: 'Despesa com imagem',
		amount: '90,00',
		date: '2026-06-23',
		category: '🧰 Operacional'
	});

	const originalImage = await createLargePngAttachment(page);
	let row = expenseRow(page, 'Despesa com imagem');
	await row.locator('summary').click();
	await row.locator('input[type="file"]').setInputFiles({
		name: 'recibo-grande.png',
		mimeType: 'image/png',
		buffer: originalImage
	});
	await row.getByRole('button', { name: 'Anexar' }).click();

	row = expenseRow(page, 'Despesa com imagem');
	await expect(row.locator('.expense-attachment-count')).toContainText('1');
	if ((await row.locator('details').getAttribute('open')) === null) {
		await row.locator('summary').click();
	}
	const attachment = row.locator('.attachment-chip').filter({ hasText: 'recibo-grande.jpg' });
	await expect(attachment).toBeVisible();
	const attachmentHref = await attachment.first().getAttribute('href');
	expect(attachmentHref).toBeTruthy();
	const attachmentResponse = await page.request.get(attachmentHref!);
	await expect(attachmentResponse).toBeOK();
	expect(attachmentResponse.headers()['content-type']).toContain('image/jpeg');
	const compressedImage = await attachmentResponse.body();
	expect(compressedImage.length).toBeLessThan(originalImage.length);
	expect(compressedImage.length).toBeLessThan(2 * 1024 * 1024);
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
	await expect(page.getByText('Anexo inválido.')).toHaveCount(1);
	await expect(row.getByText('Anexo inválido.')).toBeVisible();
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

test('moves an expense to the dedicated trash and restores it on desktop and mobile', async ({
	page
}) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page);
	await createExpenseFromForm(page, {
		description: 'Despesa recuperável',
		amount: '42,50',
		date: '2026-07-10',
		category: '🧰 Operacional'
	});

	await expenseRow(page, 'Despesa recuperável')
		.getByRole('button', { name: 'Excluir Despesa recuperável' })
		.click();
	const deleteDialog = page.getByRole('dialog', { name: 'Excluir despesa?' });
	await expect(deleteDialog).toContainText('poderá ser recuperada por 30 dias');
	await deleteDialog.getByRole('button', { name: 'Excluir', exact: true }).click();
	await expect(expenseRow(page, 'Despesa recuperável')).toBeHidden();

	await page.getByRole('link', { name: 'Ver lixeira' }).click();
	await expect(page).toHaveURL(/\/app\/expenses\/trash$/);
	await expect(page.getByRole('heading', { name: 'Lixeira de despesas' })).toBeVisible();
	const trashItem = page.locator('.trash-item').filter({ hasText: 'Despesa recuperável' });
	await expect(trashItem).toContainText('Excluída em');
	await expect(trashItem).toContainText('Exclusão permanente em');

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(trashItem.getByRole('button', { name: 'Restaurar' })).toBeVisible();
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
	await trashItem.getByRole('button', { name: 'Restaurar' }).focus();
	await expect(trashItem.getByRole('button', { name: 'Restaurar' })).toBeFocused();
	await page.keyboard.press('Enter');
	await expect(page.getByText('A lixeira está vazia')).toBeVisible();

	await page.getByRole('link', { name: 'Voltar para despesas' }).click();
	await expect(expenseRow(page, 'Despesa recuperável')).toBeVisible();
});

test('reaches every trashed expense beyond 100 rows and preserves cursor navigation', async ({
	page
}) => {
	test.setTimeout(60_000);
	await registerAndCreateWorkspace(page, 'Paginação da lixeira');
	await createCategory(page);

	await page.goto('/app/planning?section=imports&periodMonth=2026-07');
	const importForm = page.locator('form[action="?/importExpenses"]');
	await importForm.getByLabel('Categoria padrão').selectOption({ label: '🧰 Operacional' });
	const descriptions = Array.from(
		{ length: 105 },
		(_, index) => `Lixeira paginada ${String(index + 1).padStart(3, '0')}`
	);
	await importForm.locator('input[type="file"]').setInputFiles({
		name: 'lixeira-paginada.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			[
				'date,description,amount',
				...descriptions.map(
					(description, index) => `2026-07-10,${description},${(index + 1).toFixed(2)}`
				)
			].join('\n')
		)
	});
	await importForm.getByRole('button', { name: 'Importar' }).click();
	await page.getByRole('button', { name: 'Confirmar despesas selecionadas' }).click();
	await expect(page.getByText('105 despesas importadas.')).toBeVisible();

	const batch = page.locator('tbody tr').filter({ hasText: 'lixeira-paginada.csv' });
	page.once('dialog', (dialog) => dialog.accept());
	await batch.getByRole('button', { name: 'Desfazer importação' }).click();
	await expect(
		page.getByText('Despesas importadas desfeitas: 105. Despesas protegidas ignoradas: 0.')
	).toBeVisible();

	await page.goto('/app/expenses/trash');
	await expect(page.locator('.trash-item')).toHaveCount(100);
	const firstPage = await page.locator('.trash-item h3').allTextContents();
	await page.getByRole('link', { name: 'Próxima página' }).click();
	await expect(page).toHaveURL(/\/app\/expenses\/trash\?cursor=/);
	await expect(page.getByRole('link', { name: 'Primeira página' })).toBeVisible();
	await expect(page.locator('.trash-item')).toHaveCount(5);
	const secondPage = await page.locator('.trash-item h3').allTextContents();
	const reached = [...firstPage, ...secondPage];
	expect(new Set(reached).size).toBe(105);
	expect([...reached].sort()).toEqual([...descriptions].sort());

	const cursorUrl = page.url();
	await page.locator('.trash-item').first().getByRole('button', { name: 'Restaurar' }).click();
	await expect(page).toHaveURL(cursorUrl);
	await expect(page.locator('.trash-item')).toHaveCount(4);
	await page.getByRole('link', { name: 'Primeira página' }).click();
	await expect(page).toHaveURL(/\/app\/expenses\/trash$/);
	await expect(page.locator('.trash-item')).toHaveCount(100);
});
