import { expect, type Browser, type Locator, type Page, test } from '@playwright/test';
import { generateTotpCode } from '../lib/server/utils/totp';

test.describe.configure({ mode: 'serial' });
test.use({
	locale: 'pt-BR',
	extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
});

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function submitRegisterForm(
	page: Page,
	input: { email: string; name: string },
	buttonName = 'Criar conta'
) {
	const form = page.locator('form').filter({ has: page.getByRole('button', { name: buttonName }) });
	const password = ['test', 'password', '123'].join('-');
	await form.locator('input[name="name"]').fill(input.name);
	await form.locator('input[name="email"]').fill(input.email);
	await form.locator('input[name="password"]').fill(password);
	await form.locator('input[name="passwordConfirmation"]').fill(password);
	await expect(form.locator('input[name="name"]')).toHaveValue(input.name);
	await expect(form.locator('input[name="email"]')).toHaveValue(input.email);
	await expect(form.locator('input[name="password"]')).toHaveValue(password);
	await expect(form.locator('input[name="passwordConfirmation"]')).toHaveValue(password);
	await form.getByRole('button', { name: buttonName }).click();
}

async function registerAccount(
	page: Page,
	input: { email: string; name: string },
	options: { buttonName?: string; path?: string } = {}
) {
	const buttonName = options.buttonName ?? 'Criar conta';
	const path = options.path ?? '/register';

	for (let attempt = 0; attempt < 3; attempt += 1) {
		await page.goto(path);
		await page.waitForLoadState('networkidle');
		await submitRegisterForm(page, input, buttonName);

		try {
			await expect(page).not.toHaveURL(/\/register/, { timeout: 5000 });
			return;
		} catch (error) {
			if (attempt === 2) throw error;
		}
	}
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

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(() => {
		const viewportWidth = window.innerWidth;
		const documentWidth = document.documentElement.scrollWidth;
		const criticalSelectors = [
			'.app-shell',
			'.sidebar',
			'.nav-list',
			'.nav-item',
			'.main-panel',
			'.page-section',
			'.section-heading',
			'.panel',
			'.content-grid',
			'.form-grid',
			'.expense-create-form',
			'.expense-filter-form',
			'.expense-edit-form',
			'.expense-workflow-panel',
			'.category-list',
			'.category-item',
			'.category-edit',
			'.budget-item',
			'.budget-inline-form',
			'.notification-center',
			'.manager-grid',
			'.preference-card',
			'.history-card',
			'.choice-row',
			'.switch-row',
			'.recurring-item',
			'.table-wrap',
			'.support-catalog-form'
		];
		const overflowingElements = Array.from(document.querySelectorAll('body *'))
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					tag: element.tagName.toLowerCase(),
					className: element.getAttribute('class') ?? '',
					text: element.textContent?.trim().slice(0, 60) ?? '',
					left: Math.floor(rect.left),
					right: Math.ceil(rect.right),
					width: Math.ceil(rect.width)
				};
			})
			.filter(
				(element) => element.width > 0 && (element.left < -1 || element.right > viewportWidth + 1)
			);
		const internallyOverflowingElements = Array.from(
			document.querySelectorAll(criticalSelectors.join(','))
		)
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					tag: element.tagName.toLowerCase(),
					className: element.getAttribute('class') ?? '',
					text: element.textContent?.trim().slice(0, 60) ?? '',
					clientWidth: Math.ceil(element.clientWidth),
					scrollWidth: Math.ceil(element.scrollWidth),
					width: Math.ceil(rect.width),
					height: Math.ceil(rect.height),
					overflowingChildren: Array.from(element.children)
						.map((child) => {
							const childRect = child.getBoundingClientRect();
							return {
								className: child.getAttribute('class') ?? '',
								tag: child.tagName.toLowerCase(),
								left: Math.floor(childRect.left),
								right: Math.ceil(childRect.right),
								width: Math.ceil(childRect.width)
							};
						})
						.filter((child) => child.left < rect.left - 1 || child.right > rect.right + 1)
				};
			})
			.filter(
				(element) =>
					element.width > 0 && element.height > 0 && element.scrollWidth > element.clientWidth + 1
			);

		return { documentWidth, internallyOverflowingElements, overflowingElements, viewportWidth };
	});

	expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
	expect(overflow.overflowingElements).toEqual([]);
	expect(overflow.internallyOverflowingElements).toEqual([]);
}

async function expectCompactAdaptiveNavigation(page: Page, viewportWidth: number) {
	const sidebarHeight = await page.locator('.sidebar').evaluate((element) => {
		return Math.ceil(element.getBoundingClientRect().height);
	});

	if (viewportWidth > 640 && viewportWidth <= 980) {
		expect(sidebarHeight).toBeLessThanOrEqual(72);
	}
}

async function expectVisibleControlsHaveAccessibleNames(page: Page) {
	const violations = await page.evaluate(() => {
		const visible = (element: Element) => {
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return (
				style.display !== 'none' &&
				style.visibility !== 'hidden' &&
				rect.width > 0 &&
				rect.height > 0
			);
		};

		return Array.from(
			document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
				'input:not([type="hidden"]), select, textarea'
			)
		)
			.filter(visible)
			.filter(
				(element) =>
					element.labels?.length === 0 &&
					!element.getAttribute('aria-label') &&
					!element.getAttribute('aria-labelledby')
			)
			.map((element) => ({
				name: element.getAttribute('name'),
				placeholder: element.getAttribute('placeholder'),
				type: element.getAttribute('type') ?? element.tagName.toLowerCase()
			}));
	});

	expect(violations).toEqual([]);
}

async function expectMinimumInteractiveTargetSize(page: Page) {
	const violations = await page.evaluate(() => {
		const visible = (element: Element) => {
			const style = getComputedStyle(element);
			const rect = element.getBoundingClientRect();
			return (
				style.display !== 'none' &&
				style.visibility !== 'hidden' &&
				rect.width > 0 &&
				rect.height > 0
			);
		};

		return Array.from(
			document.querySelectorAll<HTMLElement>(
				'button, a, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]'
			)
		)
			.filter(visible)
			.filter((element) => {
				const rect = element.getBoundingClientRect();
				return rect.width < 32 || rect.height < 32;
			})
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return {
					label:
						element.getAttribute('aria-label') ??
						element.textContent?.replace(/\s+/g, ' ').trim().slice(0, 60) ??
						'',
					tag: element.tagName.toLowerCase(),
					width: Math.round(rect.width),
					height: Math.round(rect.height)
				};
			});
	});

	expect(violations).toEqual([]);
}

async function registerAndCreateWorkspace(page: Page, workspaceName = 'Minhas despesas') {
	const email = uniqueEmail('user');

	await page.goto('/register');
	await page.waitForLoadState('networkidle');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
	await submitRegisterForm(page, { email, name: 'Test User' });

	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Nome').fill(workspaceName);
	await page.getByRole('button', { name: 'Criar workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);

	return { email, workspaceName };
}

async function createCategory(
	page: Page,
	input = { name: 'Alimentação', emoji: '🍽️', color: '#2563eb' }
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

async function categoryIdByLabel(page: Page, label: string) {
	await page.goto('/app/expenses');
	const value = await page
		.locator('form.expense-create-form select[name="categoryId"] option')
		.filter({ hasText: label })
		.getAttribute('value');
	expect(value).toBeTruthy();
	return value!;
}

async function acceptInviteAsUser(browser: Browser, inviteUrl: string, email: string) {
	const context = await browser.newContext({
		locale: 'pt-BR',
		extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
	});
	const page = await context.newPage();
	const invitePath = new URL(inviteUrl, 'http://localhost:4173').pathname;
	await page.goto(`/register?next=${encodeURIComponent(invitePath)}`);
	await submitRegisterForm(page, { email, name: 'Member User' });
	await expect(page).toHaveURL(/\/invite\//);
	await page.getByRole('button', { name: 'Aceitar convite' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);

	return { context, page };
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
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('status')).toHaveText('Item adicionado ao cadastro com sucesso.');
	await expect(dialog.getByLabel(`Editar ${catalogKindName(kind)} ${name}`)).toBeVisible();
	await dialog.getByRole('button', { name: 'Fechar' }).click();
	await expect(dialog).toBeHidden();
	if (kind === 'paymentMethod') {
		await expect(page.locator(`select[name="${catalogSelectName(kind)}"]`).first()).toContainText(
			name
		);
		return;
	}
	await chooseSearchableOption(
		page.locator('form.expense-create-form'),
		kind === 'vendor' ? 'Fornecedor' : 'Centro de custo',
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

async function chooseSearchableOption(scope: Page | Locator, label: string, option: string) {
	const combobox = scope.getByRole('combobox', { name: label });
	await combobox.fill(option);
	await scope.getByRole('option', { name: option, exact: true }).click();
	await expect(combobox).toHaveValue(option);
}

async function expectSearchableOptionAbsent(scope: Page | Locator, label: string, option: string) {
	const combobox = scope.getByRole('combobox', { name: label });
	await combobox.fill(option);
	await expect(scope.getByRole('option', { name: option, exact: true })).toHaveCount(0);
	await combobox.press('Escape');
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
		categoryLabel: '🍽️ Alimentação',
		payment: 'Pix',
		notes: 'Compra semanal',
		vendor: 'Fornecedor padrão',
		costCenter: 'Operação',
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
	await form.getByLabel('Descrição').fill(input.description);
	await form.getByLabel('Valor da parcela').fill(input.amount);
	await form.getByLabel('Data', { exact: true }).fill(input.date);
	await form.getByLabel('Categoria').selectOption({ label: input.categoryLabel });
	await form.getByLabel('Pagamento').selectOption({ label: input.payment });
	if (input.vendor) await chooseSearchableOption(form, 'Fornecedor', input.vendor);
	if (input.costCenter) {
		await chooseSearchableOption(form, 'Centro de custo', input.costCenter);
	}
	if (input.competencyMonth) await form.getByLabel('Competência').fill(input.competencyMonth);
	await form.getByLabel('Notas').fill(input.notes);
	await form.getByRole('button', { name: 'Adicionar' }).click();

	const row = page.locator('.expense-table-item').filter({ hasText: input.description });
	await expect(row).toBeVisible();
	await expect(row).toContainText(`R$ ${input.amount}`);
	await expect(row).toContainText('Aprovada');
	return row;
}

test.describe('english locale defaults', () => {
	test.use({
		locale: 'en-US',
		extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
	});

	test('uses English, USD and allows locale and currency override', async ({ page }) => {
		const email = uniqueEmail('english');

		await page.goto('/register');
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
		await registerAccount(page, { email, name: 'Test User' }, { buttonName: 'Create account' });

		await expect(page).toHaveURL(/\/app\/onboarding/);
		await expect(page.getByRole('heading', { name: 'New workspace' })).toBeVisible();
		await expect(page.getByLabel('Currency')).toHaveValue('USD');
		await page.getByLabel('Name').fill('My expenses');
		expect(
			await page.locator('form').evaluate((form) => {
				const controls = Array.from(
					(form as HTMLFormElement).querySelectorAll<HTMLInputElement | HTMLSelectElement>(
						'input, select'
					)
				);
				return {
					valid: (form as HTMLFormElement).checkValidity(),
					controls: controls.map((control) => ({
						name: control.name,
						value: control.value,
						valid: control.validity.valid,
						message: control.validationMessage
					}))
				};
			})
		).toEqual(
			expect.objectContaining({
				valid: true
			})
		);
		await page.getByRole('button', { name: 'Create workspace' }).click();
		await expect(page).toHaveURL(/\/app\/dashboard/);
		await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

		await page.goto('/app/categories');
		const categoryForm = page.locator('form.stack');
		await categoryForm.getByLabel('Name').fill('Operations');
		await categoryForm.locator('input[name="color"]').fill('#2563eb');
		await categoryForm.locator('select[name="icon"]').selectOption('💼');
		await categoryForm.getByRole('button', { name: 'Create' }).click();

		// Change locale and currency BEFORE creating expenses (currency guard blocks changes after)
		await page.goto('/app/settings/workspace');
		await page
			.locator('form[action="?/updateLocale"]')
			.getByLabel('Language')
			.selectOption('pt-BR');
		await expect(
			page.locator('form[action="?/updateLocale"]').getByRole('button', { name: 'Save' })
		).toHaveCount(0);
		await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
		const updateForm = page.locator('form[action="?/update"]');
		await updateForm.getByLabel('Moeda').fill('BRL');
		await updateForm.getByRole('button', { name: 'Salvar' }).click();

		await page.goto('/app/expenses');
		const expenseForm = page.locator('form.expense-create-form');
		await expenseForm.getByLabel('Descrição').fill('Office supplies');
		await expenseForm.getByLabel('Valor da parcela').fill('123,45');
		await expenseForm.getByLabel('Data', { exact: true }).fill('2026-06-25');
		await expenseForm.getByLabel('Categoria').selectOption({ label: '💼 Operations' });
		await expenseForm.getByRole('button', { name: 'Adicionar' }).click();
		await expect(
			page.locator('.expense-table-item').filter({ hasText: 'Office supplies' })
		).toContainText('R$ 123,45');

		await page.goto('/app/dashboard?from=2026-06-01&to=2026-06-30');
		await expect(page.locator('.metric-card').filter({ hasText: 'Total' })).toContainText(
			'R$ 123,45'
		);
	});
});

test('protects private screens and reports invalid authentication', async ({ page }) => {
	await page.goto('/app/dashboard');
	await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fdashboard/);

	await page.getByLabel('Email').fill(uniqueEmail('missing'));
	await page.getByLabel('Senha').fill('wrong-password');
	await page.getByRole('button', { name: 'Entrar' }).click();
	await expect(page.getByText('Credenciais inválidas.')).toBeVisible();

	await page.goto('/login?next=https://evil.example/app');
	await expect(page.locator('input[name="next"]')).toHaveValue('/app');

	await page.goto('/reset-password?token=invalid-token-value');
	await page.getByLabel('Senha').fill('new-password-123');
	await page.getByRole('button', { name: 'Salvar senha' }).click();
	await expect(page.getByText('Token inválido ou expirado.')).toBeVisible();
});

test('covers dashboard, categories, expenses and reports happy path', async ({ page }) => {
	await registerAndCreateWorkspace(page);

	await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
	await expect(page.locator('.topbar')).toHaveCount(0);
	await expect(page.locator('main').getByText('Minhas despesas')).toHaveCount(0);
	await expect(page.getByText('Total')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Distribuição por categoria' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Evolução mensal' })).toBeVisible();
	expect((await page.request.get('/app/dashboard?from=2026-02-31&to=2026-03-01')).status()).toBe(
		400
	);
	expect((await page.request.get('/app/expenses?from=2026-07-01&to=2026-06-01')).status()).toBe(
		400
	);
	expect((await page.request.get('/app/expenses?vendorId=abc')).status()).toBe(400);
	expect((await page.request.get('/app/expenses?competencyMonth=2026-13')).status()).toBe(400);
	expect((await page.request.get('/app/reports?vendorId=abc')).status()).toBe(400);
	expect((await page.request.get('/app/reports?competencyMonth=2026-13')).status()).toBe(400);
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
	await page.goto('/app/expenses');
	const expenseFilterForm = page.locator('form.expense-filter-form');
	await chooseSearchableOption(expenseFilterForm, 'Fornecedor', 'Fornecedor padrão');
	await chooseSearchableOption(expenseFilterForm, 'Centro de custo', 'Operação');
	await expenseFilterForm.getByLabel('Competência').fill('2026-06');
	await expenseFilterForm.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page).toHaveURL(/vendorId=\d+/);
	await expect(page).toHaveURL(/costCenterId=\d+/);
	await expect(page).toHaveURL(/competencyMonth=2026-06/);
	await expect(page.locator('.expense-table-item').filter({ hasText: 'Mercado' })).toBeVisible();
	const badReview = await page.request.post('/app/expenses?/review', {
		form: { id: '0', reviewStatus: 'pending' }
	});
	expect(badReview.status()).toBe(200);
	expect(await badReview.text()).toContain('Confira os dados da revisão.');
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
	await expect(page.locator('svg[aria-label="Despesas por mês"]')).toBeVisible();
	await expect(page.locator('svg[aria-label="Despesas por semana"]')).toBeVisible();
	await expect(page.locator('.metric-card').filter({ hasText: 'Orçamento' })).toBeVisible();
	await expect(page.locator('.panel').filter({ hasText: 'Ranking por categoria' })).toContainText(
		'Alimentação'
	);
	await expect(page.locator('.panel').filter({ hasText: 'Ranking por semana' })).toContainText(
		localizedWeek
	);

	await page.goto('/app/settings/workspace');
	const updateWorkspaceForm = page.locator('form[action="?/update"]');
	await updateWorkspaceForm.getByLabel('Início da semana').selectOption('0');
	await updateWorkspaceForm.getByRole('button', { name: 'Salvar' }).click();
	await page.goto('/app/dashboard?from=2026-06-01&to=2026-06-30');
	const localizedSundayWeek = await browserDateLabel(page, '2026-06-21');
	await expect(page.locator('.panel').filter({ hasText: 'Ranking por semana' })).toContainText(
		localizedSundayWeek
	);

	await page.goto('/app/reports?from=2026-06-01&to=2026-06-30&groupBy=category');
	await expect(page.getByRole('cell', { name: 'Alimentação' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'R$ 125,40' })).toBeVisible();
	const reportFilterForm = page.locator('form.form-grid').first();
	await chooseSearchableOption(reportFilterForm, 'Fornecedor', 'Fornecedor padrão');
	await chooseSearchableOption(reportFilterForm, 'Centro de custo', 'Operação');
	await reportFilterForm.getByLabel('Competência').fill('2026-06');
	await reportFilterForm.getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/vendorId=\d+/);
	await expect(page).toHaveURL(/costCenterId=\d+/);
	await expect(page).toHaveURL(/competencyMonth=2026-06/);
	const filteredReportUrl = new URL(page.url());
	const reportVendorId = filteredReportUrl.searchParams.get('vendorId');
	const reportCostCenterId = filteredReportUrl.searchParams.get('costCenterId');
	expect(reportVendorId).toBeTruthy();
	expect(reportCostCenterId).toBeTruthy();
	await expect(page.getByRole('cell', { name: 'Alimentação' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'R$ 125,40' })).toBeVisible();

	await page.getByLabel('Agrupar').selectOption('month');
	await page.getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/groupBy=month/);
	const localizedMonth = await browserMonthLabel(page, '2026-06-01');
	await expect(page.getByRole('cell', { name: localizedMonth })).toBeVisible();

	await page.getByLabel('Agrupar').selectOption('payment');
	await page.getByRole('button', { name: 'Gerar' }).click();
	await expect(page.getByRole('cell', { name: 'Pix' })).toBeVisible();

	await page.getByLabel('Agrupar').selectOption('expense');
	await page.getByRole('button', { name: 'Gerar' }).click();
	await expect(page).toHaveURL(/groupBy=expense/);
	await expect(page.getByRole('heading', { name: 'Analítico' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Mercado' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Fornecedor padrão' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Operação' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Conciliada' })).toBeVisible();
	await page.getByLabel('Busca').fill('Fornecedor padrão');
	await page.getByRole('button', { name: 'Gerar' }).click();
	await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Fornecedor padrão');
	await expect(page.getByRole('cell', { name: 'Mercado' })).toBeVisible();

	const csv = await page.request.get(
		'/app/reports/export.csv?from=2026-06-01&to=2026-06-30&groupBy=category'
	);
	await expect(csv).toBeOK();
	await expect(await csv.text()).toContain('"Alimentação",12540');
	const filteredCsv = await page.request.get(
		`/app/reports/export.csv?from=2026-06-01&to=2026-06-30&groupBy=category&vendorId=${reportVendorId}&costCenterId=${reportCostCenterId}&competencyMonth=2026-06`
	);
	await expect(filteredCsv).toBeOK();
	await expect(await filteredCsv.text()).toContain('"Alimentação",12540');
	const analyticalCsv = await page.request.get(
		`/app/reports/export.csv?from=2026-06-01&to=2026-06-30&groupBy=expense&q=${encodeURIComponent('Fornecedor padrão')}`
	);
	await expect(analyticalCsv).toBeOK();
	const analyticalCsvText = await analyticalCsv.text();
	expect(analyticalCsvText).toContain('description,category,vendor,cost_center');
	expect(analyticalCsvText).toContain('"Mercado"');
	expect(analyticalCsvText).toContain('"Fornecedor padrão"');
	expect(analyticalCsvText).toContain('"Operação"');
	expect(analyticalCsvText).toContain('12540');
});

test('nav has exactly 5 items, Settings tab is active for all settings sub-routes, back-links work', async ({
	page
}) => {
	await registerAndCreateWorkspace(page);

	// Nav has 5 items (down from 7)
	await page.goto('/app/dashboard');
	await expect(page.locator('.nav-item')).toHaveCount(5);

	// Nav labels (pt-BR)
	const labels = ['Dashboard', 'Despesas', 'Orçamento', 'Relatórios', 'Ajustes'];
	for (const label of labels) {
		await expect(page.locator('.nav-item').filter({ hasText: label }).first()).toBeVisible();
	}

	// Settings tab lights up for /users, /security, /audit
	for (const subPath of ['/app/settings/users', '/app/settings/security', '/app/settings/audit']) {
		await page.goto(subPath);
		const settingsItem = page.locator('.nav-item[href="/app/settings/workspace"]');
		await expect(settingsItem).toHaveClass(/active/);
	}

	// Expenses tab lights up for /categories (Categories moved to Expenses dialog)
	await page.goto('/app/categories');
	const expensesItem = page.locator('.nav-item[href="/app/expenses"]');
	await expect(expensesItem).toHaveClass(/active/);

	// Users page has back link to settings
	await page.goto('/app/settings/users');
	await expect(
		page.locator('#main-content').getByRole('link', { name: /Ajustes/i })
	).toHaveAttribute('href', '/app/settings/workspace');

	// Settings page shows Users shortcut
	await page.goto('/app/settings/workspace');
	await expect(page.getByRole('link', { name: 'Usuários' })).toHaveAttribute(
		'href',
		'/app/settings/users'
	);

	// Support catalogs dialog shows Categories tab
	await page.goto('/app/expenses');
	await page.getByRole('button', { name: 'Cadastros' }).click();
	const dialog = page.getByRole('dialog', { name: 'Cadastros de apoio' });
	await expect(dialog).toBeVisible();
	const categoriesTab = dialog.getByRole('tab', { name: /Categorias/ });
	await expect(categoriesTab).toBeVisible();
	await expect(categoriesTab).toHaveAttribute('type', 'button');
	await expect(categoriesTab).toHaveAttribute('aria-controls', 'support-catalog-panel-category');
	await categoriesTab.click();
	await expect(categoriesTab).toHaveAttribute('aria-selected', 'true');
});

test('keeps core app screens responsive without horizontal overflow', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 800 });
	await registerAndCreateWorkspace(page);
	await createCategory(page);
	await createExpense(page);

	const routes = [
		{
			url: '/app/dashboard?from=2026-06-01&to=2026-06-30',
			assertReady: () => expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
		},
		{
			url: '/app/expenses',
			assertReady: () => expect(page.locator('.expense-create-panel')).toBeVisible()
		},
		{
			url: '/app/categories',
			assertReady: () => expect(page.getByRole('heading', { name: 'Categorias' })).toBeVisible()
		},
		{
			url: '/app/planning?periodMonth=2026-06-01',
			assertReady: () =>
				expect(page.getByRole('heading', { name: 'Orçamento', exact: true })).toBeVisible()
		},
		{
			url: '/app/reports?from=2026-06-01&to=2026-06-30&groupBy=expense',
			assertReady: () => expect(page.getByRole('heading', { name: 'Analítico' })).toBeVisible()
		},
		{
			url: '/app/settings/users',
			assertReady: () => expect(page.getByRole('heading', { name: 'Usuários' })).toBeVisible()
		},
		{
			url: '/app/settings/workspace',
			assertReady: () =>
				expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible()
		},
		{
			url: '/app/settings/security',
			assertReady: () => expect(page.getByRole('heading', { name: 'Segurança' })).toBeVisible()
		},
		{
			url: '/app/settings/audit',
			assertReady: () => expect(page.getByRole('heading', { name: 'Auditoria' })).toBeVisible()
		}
	];

	for (const viewport of [
		{ width: 1280, height: 800 },
		{ width: 1024, height: 768 },
		{ width: 912, height: 900 },
		{ width: 768, height: 900 },
		{ width: 390, height: 844 }
	]) {
		await page.setViewportSize(viewport);
		for (const route of routes) {
			await page.goto(route.url);
			await route.assertReady();
			await expectNoHorizontalOverflow(page);
			await expectCompactAdaptiveNavigation(page, viewport.width);
			await expectVisibleControlsHaveAccessibleNames(page);
			await expectMinimumInteractiveTargetSize(page);
		}
	}

	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/app/expenses');
	const responsiveHeader = page.locator('.expense-table-header');
	await expect(responsiveHeader).toBeAttached();
	const responsiveHeaderBox = await responsiveHeader.boundingBox();
	expect(responsiveHeaderBox).not.toBeNull();
	expect(responsiveHeaderBox!.width).toBeLessThanOrEqual(1);
	expect(responsiveHeaderBox!.height).toBeLessThanOrEqual(1);
	await expect(page.getByRole('columnheader', { name: 'Valor' })).toBeAttached();
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
	await expenseForm.getByLabel('Descrição').fill('Serviço');
	await expenseForm.getByLabel('Valor').fill('abc');
	await expenseForm.getByLabel('Data', { exact: true }).fill('2026-06-20');
	await expenseForm.getByLabel('Categoria').selectOption({ label: '💼 Administrativo' });
	await expenseForm.getByRole('button', { name: 'Adicionar' }).click();
	await expect(page.getByText('Confira os dados da despesa.')).toBeVisible();

	await createExpense(page, {
		description: 'Serviço',
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
	await expect(page.locator('.expense-table-item').filter({ hasText: 'Serviço' })).toContainText(
		'Fornecedor B Ltda'
	);

	await createCatalogItem(page, 'vendor', 'Novo fornecedor', 'Fornecedor temporário');
	await removeCatalogItem(page, 'vendor', 'Excluir', 'Fornecedor temporário');
	await expectSearchableOptionAbsent(
		page.locator('form.expense-create-form'),
		'Fornecedor',
		'Fornecedor temporário'
	);

	await createCatalogItem(page, 'vendor', 'Novo fornecedor', 'Fornecedor duplicado');
	await updateCatalogItem(page, 'vendor', 'Fornecedor duplicado', 'Fornecedor B Ltda');
	await expect(page.getByText('Fornecedor já existe.')).toBeVisible();
	await removeCatalogItem(page, 'vendor', 'Excluir', 'Fornecedor duplicado');

	await removeCatalogItem(page, 'vendor', 'Arquivar', 'Fornecedor B Ltda');
	await expectSearchableOptionAbsent(
		page.locator('form.expense-create-form'),
		'Fornecedor',
		'Fornecedor B Ltda'
	);
	const archivedVendorRow = page.locator('.expense-table-item').filter({ hasText: 'Serviço' });
	await expect(archivedVendorRow).toContainText('Fornecedor B Ltda');
	await archivedVendorRow.locator('summary').click();
	await expect(archivedVendorRow.getByRole('combobox', { name: 'Fornecedor' })).toHaveValue(
		'Fornecedor B Ltda (arquivado)'
	);
	await archivedVendorRow.getByLabel('Descrição').fill('Serviço com fornecedor arquivado');
	await archivedVendorRow.getByRole('button', { name: 'Atualizar' }).click();
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Serviço com fornecedor arquivado' })
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
	await expect(pagedCatalogDialog.getByText('Página 1 de 2')).toBeVisible();
	await pagedCatalogDialog.getByRole('button', { name: 'Próxima página de fornecedores' }).click();
	await expect(pagedCatalogDialog.getByText('Página 2 de 2')).toBeVisible();
	await expect(pagedCatalogDialog.getByLabel('Editar fornecedor Fornecedor lote 09')).toBeVisible();
	await pagedCatalogDialog.getByLabel('Buscar fornecedor').fill('lote 10');
	await expect(pagedCatalogDialog.getByText('1-1 de 1')).toBeVisible();
	await expect(pagedCatalogDialog.getByLabel('Editar fornecedor Fornecedor lote 10')).toBeVisible();

	await page.goto(`/app/expenses?from=2026-06-01&to=2026-06-30&q=${encodeURIComponent('Serviço')}`);
	await expect(page.locator('.expense-list-heading')).toContainText('1 de 1 itens exibidos');
	await expect(page.locator('.expense-list-heading')).toContainText('R$ 200,00');

	const filteredRow = page.locator('.expense-table-item').filter({ hasText: 'Serviço' });
	await filteredRow.locator('summary').click();
	await filteredRow.getByLabel('Descrição').fill('Lançamento filtrado');
	await filteredRow.getByRole('button', { name: 'Atualizar' }).click();
	await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('Serviço');
	await expect(page.getByText('Nenhuma despesa encontrada.')).toBeVisible();

	await page.goto('/app/expenses');
	const rowAfterFilterUpdate = page
		.locator('.expense-table-item')
		.filter({ hasText: 'Lançamento filtrado' });
	await rowAfterFilterUpdate.locator('summary').click();
	await rowAfterFilterUpdate.getByLabel('Descrição').fill('Serviço');
	await rowAfterFilterUpdate.getByRole('button', { name: 'Atualizar' }).click();

	await ensureExpenseCatalogs(page, {
		vendor: 'Fornecedor atualizado',
		costCenter: 'Diretoria'
	});
	await page.goto('/app/expenses');
	const rowToUpdate = page.locator('.expense-table-item').filter({ hasText: 'Serviço' });
	await rowToUpdate.locator('summary').click();
	await rowToUpdate.getByLabel('Descrição').fill('Serviço atualizado');
	await rowToUpdate.getByLabel('Valor').fill('230,10');
	await chooseSearchableOption(rowToUpdate, 'Fornecedor', 'Fornecedor atualizado');
	await chooseSearchableOption(rowToUpdate, 'Centro de custo', 'Diretoria');
	await rowToUpdate.getByRole('button', { name: 'Atualizar' }).click();
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Serviço atualizado' })
	).toContainText('R$ 230,10');
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Serviço atualizado' })
	).toContainText('Fornecedor atualizado');

	const rejectedRow = page.locator('.expense-table-item').filter({ hasText: 'Serviço atualizado' });
	await rejectedRow.locator('summary').click();
	await rejectedRow.locator('input[name="reason"]').fill('Duplicada');
	await rejectedRow.getByRole('button', { name: 'Rejeitar' }).click();
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Serviço atualizado' })
	).toContainText('Rejeitada');

	const updatedRow = page.locator('.expense-table-item').filter({ hasText: 'Serviço atualizado' });
	await updatedRow.getByRole('button', { name: 'Excluir Serviço atualizado' }).click();
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
	await inviteForm.getByLabel('Email').fill('email-inválido');
	await inviteForm.getByRole('button', { name: 'Convidar' }).click();
	await expect(page.getByText('Confira email e papel.')).toBeVisible();

	await inviteForm.getByLabel('Email').fill(uniqueEmail('invite'));
	await inviteForm.getByLabel('Papel').selectOption('viewer');
	await inviteForm.getByRole('button', { name: 'Convidar' }).click();
	await expect(page.locator('.invite-url-row')).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Visualizador' })).toBeVisible();

	await page.goto('/invite/token-invalido');
	await expect(page.getByText('Convite inválido ou expirado.')).toBeVisible();
});

test('covers planning, imports, attachments and audit flows', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page, { name: 'Limpeza', emoji: '🧼', color: '#0f766e' });
	await createExpense(page, {
		description: 'Café Central mensal',
		amount: '42,35',
		date: '2026-07-10',
		categoryLabel: '🧼 Limpeza',
		payment: 'Boleto',
		notes: 'Candidata OFX A'
	});
	await createExpense(page, {
		description: 'Café Central alternativo',
		amount: '42,35',
		date: '2026-07-10',
		categoryLabel: '🧼 Limpeza',
		payment: 'Boleto',
		notes: 'Candidata OFX B'
	});

	await page.goto('/app/planning?periodMonth=2026-06-01');
	const budgetForm = page.locator('form[action="?/upsertBudget"]').first();
	await budgetForm.getByLabel('Categoria').selectOption({ label: '🧼 Limpeza' });
	await budgetForm.getByLabel('Valor').fill('1.000.000.000,01');
	await budgetForm.getByLabel('Alerta (%)').fill('73');
	await budgetForm.getByRole('button', { name: 'Salvar' }).click();
	await expect(page.locator('.notice')).toHaveText('Valor excede o máximo permitido.');
	await expect(budgetForm.getByLabel('Categoria')).toHaveValue(/\d+/);
	await expect(budgetForm.getByLabel('Valor')).toHaveValue('1.000.000.000,01');
	await expect(budgetForm.getByLabel('Alerta (%)')).toHaveValue('73');

	await page.goto('/app/planning?periodMonth=2026-06-01');
	await budgetForm.getByLabel('Categoria').selectOption({ label: '🧼 Limpeza' });
	await budgetForm.getByLabel('Valor').fill('500,00');
	await budgetForm.getByLabel('Alerta (%)').fill('70');
	await budgetForm.getByRole('button', { name: 'Salvar' }).click();
	await expect(page.locator('.budget-item').filter({ hasText: 'Limpeza' })).toContainText(
		'R$ 500,00'
	);
	await expect(page.getByText('Alertas automáticos desativados')).toBeVisible();
	const notificationSettings = page.locator('form.preference-card');
	const automaticAlerts = notificationSettings.getByRole('checkbox', {
		name: /Alertas automáticos por email/
	});
	await automaticAlerts.check();
	await notificationSettings
		.getByRole('button', { name: 'Salvar configurações de notificações' })
		.click();
	await expect(page.getByText('Preferências de alertas de orçamento salvas.')).toBeVisible();
	await expect(page.getByText('Alertas automáticos ativados')).toBeVisible();
	await automaticAlerts.uncheck();
	await notificationSettings
		.getByRole('button', { name: 'Salvar configurações de notificações' })
		.click();
	await expect(page.getByText('Preferências de alertas de orçamento salvas.')).toBeVisible();
	await expect(page.getByText('Alertas automáticos desativados')).toBeVisible();
	await page.getByRole('button', { name: 'Enviar alertas agora' }).click();
	await expect(page.getByText('Nenhum alerta de orçamento para enviar.')).toBeVisible();

	const planningPaymentForm = page.locator('form.compact-support');
	await planningPaymentForm.getByLabel('Novo pagamento').fill('Boleto');
	await planningPaymentForm.getByRole('button', { name: 'Criar' }).click();
	await expect(
		page.locator('form[action="?/createRecurring"] select[name="paymentMethodId"]')
	).toContainText('Boleto');

	const recurringForm = page.locator('form[action="?/createRecurring"]');
	await recurringForm.getByLabel('Descrição').fill('Limpeza mensal');
	await recurringForm.getByLabel('Valor').fill('abc');
	await recurringForm.getByLabel('Categoria').selectOption({ label: '🧼 Limpeza' });
	await recurringForm.getByLabel('Pagamento').selectOption({ label: 'Boleto' });
	await recurringForm.getByLabel('Início').fill('2026-06-01');
	await recurringForm.getByRole('button', { name: 'Criar recorrência' }).click();
	await expect(page.getByText('Confira os dados da recorrência.')).toBeVisible();

	await page.goto('/app/planning?periodMonth=2026-06-01');
	await recurringForm.getByLabel('Descrição').fill('Limpeza mensal');
	await recurringForm.getByLabel('Valor').fill('90,00');
	await recurringForm.getByLabel('Categoria').selectOption({ label: '🧼 Limpeza' });
	await recurringForm.getByLabel('Pagamento').selectOption({ label: 'Boleto' });
	await recurringForm.getByLabel('Início').fill('2026-06-01');
	await recurringForm.getByRole('button', { name: 'Criar recorrência' }).click();
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
	await expect(page.getByText('Nenhuma recorrência vencida para gerar.')).toBeVisible();

	await page.goto('/app/planning');
	const reconciliationUpload = page.locator('form[action="?/importExpenses"]');
	await reconciliationUpload.getByLabel('Formato').selectOption('ofx');
	await reconciliationUpload.locator('input[type="file"]').setInputFiles({
		name: 'conciliacao.ofx',
		mimeType: 'application/x-ofx',
		buffer: Buffer.from(
			`<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>001<ACCTID>1234<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>
			<STMTTRN><DTPOSTED>20260710<TRNAMT>-42.35<FITID>e2e-match<NAME>Café Central</STMTTRN>
			<STMTTRN><DTPOSTED>20260711<TRNAMT>-18.20<FITID>e2e-create<NAME>Táxi sem despesa</STMTTRN>
			<STMTTRN><DTPOSTED>20260712<TRNAMT>7.50<FITID>e2e-credit<NAME>Estorno</STMTTRN>
			</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
		)
	});
	await reconciliationUpload.getByRole('button', { name: 'Importar' }).click();
	await expect(
		page.getByText('3 lançamentos bancários preparados; 0 duplicatas e 0 falhas.')
	).toBeVisible();
	const reconciliation = page.locator('.reconciliation-workspace');
	await expect(
		reconciliation.getByRole('heading', { name: 'Conciliar lançamentos OFX' })
	).toBeVisible();
	const ambiguous = reconciliation
		.locator('.reconciliation-item')
		.filter({ hasText: 'Café Central' });
	await expect(ambiguous.getByRole('button', { name: 'Associar' })).toHaveCount(2);
	await ambiguous.getByRole('button', { name: 'Associar' }).first().focus();
	await expect(ambiguous.getByRole('button', { name: 'Associar' }).first()).toBeFocused();
	await ambiguous.getByRole('button', { name: 'Associar' }).first().press('Enter');
	await expect(page.getByText('Lançamento bancário associado e conciliado.')).toBeVisible();

	let unmatched = page.locator('.reconciliation-item').filter({ hasText: 'Táxi sem despesa' });
	await expect(
		unmatched.getByText('Nenhuma despesa elegível encontrada no intervalo de datas.')
	).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expectNoHorizontalOverflow(page);
	await expect(unmatched.locator('.bank-side')).toBeVisible();
	await expect(unmatched.locator('.candidate-side')).toBeVisible();
	await page.setViewportSize({ width: 1280, height: 900 });
	unmatched = page.locator('.reconciliation-item').filter({ hasText: 'Táxi sem despesa' });
	await unmatched.getByLabel('Categoria da nova despesa').selectOption({ label: '🧼 Limpeza' });
	await unmatched.getByRole('button', { name: 'Criar e conciliar' }).click();
	await expect(page.getByText('Despesa criada e conciliada.')).toBeVisible();
	const credit = page.locator('.reconciliation-item').filter({ hasText: 'Estorno' });
	await expect(credit.getByText('Crédito', { exact: true })).toBeVisible();
	await expect(credit.getByRole('button', { name: 'Criar e conciliar' })).toHaveCount(0);
	await credit.getByRole('button', { name: 'Ignorar' }).click();
	await expect(page.getByText('Lançamento bancário ignorado.')).toBeVisible();

	await page.goto('/app/planning');
	const importForm = page.locator('form[action="?/importExpenses"]');
	await importForm.evaluate((form) => form.setAttribute('novalidate', ''));
	await importForm.getByRole('button', { name: 'Importar' }).click();
	await expect(page.getByText('Confira arquivo e formato.')).toBeVisible();

	await importForm.locator('input[type="file"]').setInputFiles({
		name: 'falhas.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('Data;Descrição;Valor\nbad;;abc\n')
	});
	await importForm.getByRole('button', { name: 'Importar' }).click();
	await expect(
		page.getByText('Prévia da importação pronta. Revise antes de confirmar.')
	).toBeVisible();
	await expect(
		page
			.locator('.import-errors')
			.getByText(/Linha -: Linha 2: data, descri[cç][aã]o ou valor inv[aá]lido\./)
	).toBeVisible();
	const cancelPreview = page.getByRole('button', { name: 'Cancelar prévia' });
	await cancelPreview.focus();
	await expect(cancelPreview).toBeFocused();
	await cancelPreview.press('Enter');
	await expect(page).toHaveURL(/\/app\/planning\?periodMonth=2026-07$/);
	await expect(page.getByRole('heading', { name: 'Prévia da importação' })).toBeHidden();

	await page.goto('/app/categories');
	const ruleForm = page.locator('form[action="?/createRule"]');
	await ruleForm.getByLabel('Nome').fill('Fornecedor ACME');
	await ruleForm.getByLabel('Categoria').selectOption({ label: '🧼 Limpeza' });
	await ruleForm.getByLabel('Campo').selectOption('vendor');
	await ruleForm.getByLabel('Contém').fill('ACME');
	await ruleForm.getByRole('button', { name: 'Criar regra' }).click();
	await expect(page.locator('.rule-summary').filter({ hasText: 'Fornecedor ACME' })).toBeVisible();

	await page.goto('/app/planning');
	const importFormWithRule = page.locator('form[action="?/importExpenses"]');
	await importFormWithRule.locator('input[type="file"]').setInputFiles({
		name: 'despesas.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			'Data;Descrição;Valor;Fornecedor;Centro de custo\n26/06/2026;Produto limpeza;35,50;ACME Serviços;Operação\n'
		)
	});
	await importFormWithRule.getByRole('button', { name: 'Importar' }).click();
	await page.getByRole('button', { name: 'Confirmar despesas selecionadas' }).click();
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
	await expect(page.getByRole('cell', { name: 'expense_import.completed' }).first()).toBeVisible();
	await page.getByLabel('Ação').fill('expense_attachment.created');
	await page.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page.getByRole('cell', { name: 'expense_attachment.created' })).toBeVisible();
});

test('fully and partially undoes guarded import batches', async ({ page }) => {
	await registerAndCreateWorkspace(page, 'Undo de importações');
	await createCategory(page, { name: 'Limpeza', emoji: '🧼', color: '#0f766e' });

	await page.goto('/app/planning?periodMonth=2026-06');
	let undoImportForm = page.locator('form[action="?/importExpenses"]');
	await undoImportForm.getByLabel('Categoria padrão').selectOption({ label: '🧼 Limpeza' });
	await undoImportForm.locator('input[type="file"]').setInputFiles({
		name: 'undo-completo.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from('date,description,amount\n2026-06-28,Undo E2E completo,11.00\n')
	});
	await undoImportForm.getByRole('button', { name: 'Importar' }).click();
	await page.getByRole('button', { name: 'Confirmar despesas selecionadas' }).click();
	let undoBatchRow = page.locator('tbody tr').filter({ hasText: 'undo-completo.csv' });
	page.once('dialog', (dialog) => dialog.accept());
	await undoBatchRow.getByRole('button', { name: 'Desfazer importação' }).click();
	await expect(
		page.getByText('Despesas importadas desfeitas: 1. Despesas protegidas ignoradas: 0.')
	).toBeVisible();
	await page.goto('/app/expenses?q=Undo%20E2E%20completo');
	await expect(page.getByText('Nenhuma despesa encontrada.')).toBeVisible();

	await page.goto('/app/planning?periodMonth=2026-06');
	undoImportForm = page.locator('form[action="?/importExpenses"]');
	await undoImportForm.getByLabel('Categoria padrão').selectOption({ label: '🧼 Limpeza' });
	await undoImportForm.locator('input[type="file"]').setInputFiles({
		name: 'undo-parcial.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			[
				'date,description,amount',
				'2026-06-29,Undo E2E editada,12.00',
				'2026-06-29,Undo E2E elegível,13.00'
			].join('\n')
		)
	});
	await undoImportForm.getByRole('button', { name: 'Importar' }).click();
	await page.getByRole('button', { name: 'Confirmar despesas selecionadas' }).click();
	await page.goto('/app/expenses?q=Undo%20E2E%20editada');
	const protectedImportRow = page
		.locator('.expense-table-item')
		.filter({ hasText: 'Undo E2E editada' });
	await protectedImportRow.locator('summary').click();
	await protectedImportRow.getByLabel('Descrição').fill('Undo E2E protegida');
	await protectedImportRow.getByRole('button', { name: 'Atualizar' }).click();

	await page.goto('/app/planning?periodMonth=2026-06');
	undoBatchRow = page.locator('tbody tr').filter({ hasText: 'undo-parcial.csv' });
	page.once('dialog', (dialog) => dialog.accept());
	await undoBatchRow.getByRole('button', { name: 'Desfazer importação' }).click();
	await expect(
		page.getByText('Despesas importadas desfeitas: 1. Despesas protegidas ignoradas: 1.')
	).toBeVisible();
	await page.goto('/app/expenses?q=Undo%20E2E%20eleg%C3%ADvel');
	await expect(page.getByText('Nenhuma despesa encontrada.')).toBeVisible();
	await page.goto('/app/expenses?q=Undo%20E2E%20protegida');
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Undo E2E protegida' })
	).toBeVisible();
});

test('enforces review-sensitive business rules for members, recurrences and imports', async ({
	browser,
	page
}) => {
	test.setTimeout(60_000);

	await registerAndCreateWorkspace(page, 'Regras de negócio');
	await createCategory(page, { name: 'Limpeza', emoji: '🧼', color: '#0f766e' });
	await createCategory(page, { name: 'Insumos', emoji: '🧰', color: '#2563eb' });
	const cleaningCategoryId = await categoryIdByLabel(page, 'Limpeza');

	await page.goto('/app/settings/users');
	const memberEmail = uniqueEmail('business-member');
	const inviteForm = page.locator('form[action="?/invite"]');
	await inviteForm.getByLabel('Email').fill(memberEmail);
	await inviteForm.getByLabel('Papel').selectOption('member');
	await inviteForm.getByRole('button', { name: 'Convidar' }).click();
	const inviteUrlRow1 = page.locator('.invite-url-row');
	await expect(inviteUrlRow1).toBeVisible();
	const inviteUrl = (await inviteUrlRow1.locator('.invite-url-code').textContent())?.trim();
	expect(inviteUrl).toBeTruthy();

	const memberSession = await acceptInviteAsUser(browser, inviteUrl!, memberEmail);
	try {
		await memberSession.page.goto('/app/expenses');
		const memberCreateForm = memberSession.page.locator('form.expense-create-form');
		await memberCreateForm.getByLabel('Descrição').fill('Despesa membro');
		await memberCreateForm.getByLabel('Valor da parcela').fill('70,00');
		await memberCreateForm.getByLabel('Data', { exact: true }).fill('2026-06-12');
		await memberCreateForm.getByLabel('Categoria').selectOption({ label: '🧼 Limpeza' });
		await memberCreateForm.getByRole('button', { name: 'Adicionar' }).click();
		await expect(
			memberSession.page.locator('.expense-table-item').filter({ hasText: 'Despesa membro' })
		).toContainText('Pendente');

		await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30&q=Despesa%20membro');
		let ownerExpenseRow = page.locator('.expense-table-item').filter({ hasText: 'Despesa membro' });
		await expect(ownerExpenseRow).toBeVisible();
		await ownerExpenseRow.locator('summary').click();
		const ownerExpenseIdInput = ownerExpenseRow
			.locator('form.expense-edit-form input[name="id"]')
			.first();
		await expect(ownerExpenseIdInput).toHaveValue(/\d+/);
		const expenseId = await ownerExpenseIdInput.inputValue();
		expect(expenseId).toBeTruthy();

		const rejectionWithoutReason = await page.request.post('/app/expenses?/review', {
			form: {
				id: expenseId,
				reviewStatus: 'rejected',
				reason: '',
				returnTo: '/app/expenses'
			}
		});
		expect(await rejectionWithoutReason.text()).toContain('Confira os dados da revisão.');

		await expect(
			await page.request.post('/app/expenses?/review', {
				form: { id: expenseId, reviewStatus: 'approved', returnTo: '/app/expenses' }
			})
		).toBeOK();
		await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30&q=Despesa%20membro');
		ownerExpenseRow = page.locator('.expense-table-item').filter({ hasText: 'Despesa membro' });
		await expect(ownerExpenseRow).toContainText('Aprovada');

		await expect(
			await memberSession.page.request.post('/app/expenses?/update', {
				form: {
					id: expenseId,
					categoryId: cleaningCategoryId,
					description: 'Despesa membro revisada',
					amount: '75,00',
					expenseDate: '2026-06-12',
					installments: '1',
					returnTo: '/app/expenses'
				}
			})
		).toBeOK();
		await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30&q=Despesa%20membro%20revisada');
		ownerExpenseRow = page
			.locator('.expense-table-item')
			.filter({ hasText: 'Despesa membro revisada' });
		await expect(ownerExpenseRow).toContainText('Pendente');

		await expect(
			await page.request.post('/app/expenses?/review', {
				form: { id: expenseId, reviewStatus: 'approved', returnTo: '/app/expenses' }
			})
		).toBeOK();
		expect(
			(
				await memberSession.page.request.post('/app/expenses?/delete', {
					form: { id: expenseId, returnTo: '/app/expenses' }
				})
			).status()
		).toBe(403);

		await expect(
			await memberSession.page.request.post('/app/planning?/createRecurring', {
				form: {
					categoryId: cleaningCategoryId,
					description: 'Recorrência membro',
					amount: '33,00',
					frequency: 'monthly',
					intervalCount: '1',
					startDate: '2026-06-01',
					periodMonth: '2026-06'
				}
			})
		).toBeOK();
		await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30&q=Recorr%C3%AAncia%20membro');
		await expect(
			page.locator('.expense-table-item').filter({ hasText: 'Recorrência membro' })
		).toContainText('Pendente');
	} finally {
		await memberSession.context.close();
	}

	await page.goto('/app/categories');
	const ruleForm = page.locator('form[action="?/createRule"]');
	await ruleForm.getByLabel('Nome').fill('Fornecedor ACME para insumos');
	await ruleForm.getByLabel('Categoria').selectOption({ label: '🧰 Insumos' });
	await ruleForm.getByLabel('Campo').selectOption('vendor');
	await ruleForm.getByLabel('Contém').fill('ACME');
	await ruleForm.getByRole('button', { name: 'Criar regra' }).click();
	await expect(page.locator('.rule-summary').filter({ hasText: 'Fornecedor ACME' })).toBeVisible();

	await page.goto('/app/planning');
	let importForm = page.locator('form[action="?/importExpenses"]');
	await importForm
		.locator('select[name="defaultCategoryId"]')
		.selectOption({ label: '🧼 Limpeza' });
	await importForm.locator('input[type="file"]').setInputFiles({
		name: 'regra-com-padrao.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			'Data;Descrição;Valor;Fornecedor\n26/06/2026;Compra regra padrão;40,00;ACME Serviços\n'
		)
	});
	await importForm.getByRole('button', { name: 'Importar' }).click();
	await page.getByRole('button', { name: 'Confirmar despesas selecionadas' }).click();
	await expect(page.getByText('1 despesas importadas.')).toBeVisible();

	await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30&q=Compra%20regra%20padr%C3%A3o');
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Compra regra padrão' })
	).toContainText('Insumos');

	await page.goto('/app/planning');
	importForm = page.locator('form[action="?/importExpenses"]');
	await importForm.locator('select[name="sourceType"]').selectOption('ofx');
	await importForm
		.locator('select[name="defaultCategoryId"]')
		.selectOption({ label: '🧼 Limpeza' });
	await importForm.locator('input[type="file"]').setInputFiles({
		name: 'creditos.ofx',
		mimeType: 'application/x-ofx',
		buffer: Buffer.from(`<OFX><BANKTRANLIST>
			<STMTTRN><DTPOSTED>20260625120000[-3:BRT]<TRNAMT>42.35<NAME>Estorno</STMTTRN>
			<STMTTRN><DTPOSTED>20260626120000[-3:BRT]<TRNAMT>-21.10<NAME>Despesa OFX</STMTTRN>
		</BANKTRANLIST></OFX>`)
	});
	await importForm.getByRole('button', { name: 'Importar' }).click();
	await expect(
		page.getByText('2 lançamentos bancários preparados; 0 duplicatas e 0 falhas.')
	).toBeVisible();
	const stagedCredit = page.locator('.reconciliation-item').filter({ hasText: 'Estorno' });
	await expect(stagedCredit.getByText('Crédito', { exact: true })).toBeVisible();
	await stagedCredit.getByRole('button', { name: 'Ignorar' }).click();
	const stagedDebit = page.locator('.reconciliation-item').filter({ hasText: 'Despesa OFX' });
	await stagedDebit.getByLabel('Categoria da nova despesa').selectOption({ label: '🧼 Limpeza' });
	await stagedDebit.getByRole('button', { name: 'Criar e conciliar' }).click();
	await expect(page.getByText('Despesa criada e conciliada.')).toBeVisible();

	await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30&q=Despesa%20OFX');
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Despesa OFX' })
	).toBeVisible();
	await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30&q=Estorno');
	await expect(page.getByText('Nenhuma despesa encontrada.')).toBeVisible();
});

test('covers MFA setup, challenge and invalid code handling', async ({ page }) => {
	const { email } = await registerAndCreateWorkspace(page);
	const invitedEmail = uniqueEmail('mfa-invite');

	await page.goto('/app/settings/users');
	const inviteForm = page.locator('form[action="?/invite"]');
	await inviteForm.getByLabel('Email').fill(invitedEmail);
	await inviteForm.getByLabel('Papel').selectOption('viewer');
	await inviteForm.getByRole('button', { name: 'Convidar' }).click();
	const inviteUrlRow2 = page.locator('.invite-url-row');
	await expect(inviteUrlRow2).toBeVisible();
	const inviteUrl = (await inviteUrlRow2.locator('.invite-url-code').textContent())?.trim();
	expect(inviteUrl).toBeTruthy();
	const invitePath = new URL(inviteUrl!, 'http://localhost:4173').pathname;

	await page.goto('/app/settings/security');
	await page.getByRole('button', { name: 'Configurar MFA' }).click();
	const secret = (await page.locator('.setup-code strong').textContent())?.trim();
	expect(secret).toBeTruthy();
	// Claim the previous accepted counter during enrollment so the later challenge
	// can use the current counter without replaying a code or guessing future time.
	const previousCounterTimestamp = Math.floor(Date.now() / 30_000) * 30_000 - 30_000;
	await page
		.getByLabel('Código gerado no app')
		.fill(generateTotpCode(secret!, previousCounterTimestamp));
	await page.getByRole('button', { name: 'Ativar' }).click();
	await expect(page.getByText('MFA ativado.')).toBeVisible();
	await expect(page.locator('.recovery-grid code')).toHaveCount(10);

	await page.goto('/app/settings/security');
	await page.locator('form[action="?/disable"]').getByLabel('Código atual').fill('000000');
	await page
		.locator('form[action="?/disable"]')
		.getByRole('button', { name: 'Desativar MFA' })
		.click();
	await expect(page.getByText(/Código MFA inv[aá]lido\./)).toBeVisible();

	await page.locator('form[action="/logout"] button').click();
	await expect(page).toHaveURL(/\/login/);
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Senha').fill(['test', 'password', '123'].join('-'));
	await page.getByRole('button', { name: 'Entrar' }).click();
	await expect(page).toHaveURL(/\/mfa/);
	await page.goto(invitePath);
	await expect(page).toHaveURL(/\/mfa/);
	expect(page.url()).toContain(`next=${encodeURIComponent(invitePath)}`);
	await page.getByLabel('Código do autenticador ou recovery code').fill(generateTotpCode(secret!));
	await page.getByRole('button', { name: 'Verificar' }).click();
	await expect(page).toHaveURL(/\/invite\//);
	await expect(page.getByRole('button', { name: 'Aceitar convite' })).toBeVisible();
	await page.goto('/app/dashboard');
	await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
