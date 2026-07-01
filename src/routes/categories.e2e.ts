import { expect, type Page, test } from '@playwright/test';
import { categoryEmojiValues } from '../lib/category-emojis';

test.describe.configure({ mode: 'serial' });
test.use({
	locale: 'pt-BR',
	extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
});

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerAndCreateWorkspace(page: Page, workspaceName = 'Categorias E2E') {
	await page.goto('/register');
	await page.getByLabel('Nome').fill('Category Tester');
	await page.getByLabel('Email').fill(uniqueEmail('categories'));
	await page.getByLabel('Senha').fill('test-password-123');
	await page.getByRole('button', { name: 'Criar conta' }).click();

	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Nome').fill(workspaceName);
	await page.getByRole('button', { name: 'Criar workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
}

function newCategoryForm(page: Page) {
	return page.locator('form.stack');
}

function categoryListPanel(page: Page) {
	return page
		.locator('section.panel')
		.filter({ has: page.getByRole('heading', { name: 'Lista' }) });
}

async function categoryRow(page: Page, name: string) {
	const rows = categoryListPanel(page).locator('.category-item');
	await expect
		.poll(async () =>
			rows.evaluateAll((items, expectedName) => {
				return items.some(
					(item) =>
						item.querySelector<HTMLInputElement>('input[name="name"]')?.value === expectedName
				);
			}, name)
		)
		.toBe(true);

	const index = await rows.evaluateAll((items, expectedName) => {
		return items.findIndex(
			(item) => item.querySelector<HTMLInputElement>('input[name="name"]')?.value === expectedName
		);
	}, name);
	expect(index).toBeGreaterThanOrEqual(0);
	return rows.nth(index);
}

function rulePanel(page: Page) {
	return page
		.locator('section.panel')
		.filter({ has: page.getByRole('heading', { name: 'Regras automáticas' }) });
}

function ruleForm(page: Page) {
	return rulePanel(page).locator('form[action="?/createRule"]');
}

function ruleRow(page: Page, name: string) {
	return rulePanel(page).locator('.category-item').filter({ hasText: name });
}

async function createCategory(
	page: Page,
	input: { name: string; color: string; emoji: (typeof categoryEmojiValues)[number] }
) {
	await page.goto('/app/categories');
	const form = newCategoryForm(page);
	await form.getByLabel('Nome').fill(input.name);
	await form.locator('input[name="color"]').fill(input.color);
	await form.locator('select[name="icon"]').selectOption(input.emoji);
	await form.getByRole('button', { name: 'Criar' }).click();

	const row = await categoryRow(page, input.name);
	await expect(row).toBeVisible();
	await expect(row.locator('input[name="color"]')).toHaveValue(input.color);
	await expect(row.locator('select[name="icon"]')).toHaveValue(input.emoji);
}

async function updateCategory(
	page: Page,
	currentName: string,
	input: { name: string; color: string; emoji: (typeof categoryEmojiValues)[number] }
) {
	const row = await categoryRow(page, currentName);
	const form = row.locator('form.category-edit');
	await form.locator('input[name="name"]').fill(input.name);
	await form.locator('input[name="color"]').fill(input.color);
	await form.locator('select[name="icon"]').selectOption(input.emoji);
	await form.getByRole('button', { name: 'Salvar' }).click();

	const updatedRow = await categoryRow(page, input.name);
	await expect(updatedRow).toBeVisible();
	await expect(updatedRow.locator('input[name="color"]')).toHaveValue(input.color);
	await expect(updatedRow.locator('select[name="icon"]')).toHaveValue(input.emoji);
}

async function createRule(
	page: Page,
	input: {
		name: string;
		categoryLabel: string;
		matchTarget: 'description' | 'vendor' | 'payment';
		pattern: string;
		priority: string;
	}
) {
	await page.goto('/app/categories');
	const form = ruleForm(page);
	await form.getByLabel('Nome').fill(input.name);
	await form.getByLabel('Categoria').selectOption({ label: input.categoryLabel });
	await form.getByLabel('Campo').selectOption(input.matchTarget);
	await form.getByLabel('Contém').fill(input.pattern);
	await form.getByLabel('Prioridade').fill(input.priority);
	await form.getByRole('button', { name: 'Criar regra' }).click();

	await expect(ruleRow(page, input.name)).toBeVisible();
}

test('creates and updates categories with business emojis and colors', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await page.goto('/app/categories');

	await expect(page.getByRole('heading', { name: 'Categorias' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Nova categoria' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Lista' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Regras automáticas' })).toBeVisible();
	await expect(page.getByText('Nenhuma regra criada.')).toBeVisible();

	const emojiOptions = await newCategoryForm(page)
		.locator('select[name="icon"] option')
		.evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
	expect(emojiOptions).toEqual([...categoryEmojiValues]);
	await expect(newCategoryForm(page).locator('select[name="icon"]')).toContainText(
		'💼 Administrativo'
	);
	await expect(newCategoryForm(page).locator('select[name="icon"]')).toContainText(
		'🧾 Contabilidade'
	);
	await expect(newCategoryForm(page).locator('select[name="icon"]')).toContainText(
		'👥 Funcionários'
	);
	await expect(newCategoryForm(page).locator('select[name="icon"]')).toContainText('🧰 Insumos');
	await expect(newCategoryForm(page).locator('select[name="icon"]')).toContainText('🧼 Limpeza');

	await createCategory(page, {
		name: 'Operacional',
		color: '#2563eb',
		emoji: '🧰'
	});

	await updateCategory(page, 'Operacional', {
		name: 'Administrativo',
		color: '#0f766e',
		emoji: '💼'
	});

	await createCategory(page, {
		name: 'Limpeza',
		color: '#14b8a6',
		emoji: '🧼'
	});

	await expect(categoryListPanel(page).locator('.category-item')).toHaveCount(2);
	await expect(await categoryRow(page, 'Administrativo')).toBeVisible();
	await expect(await categoryRow(page, 'Limpeza')).toBeVisible();
});

test('validates category creation and update errors', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await page.goto('/app/categories');

	const createForm = newCategoryForm(page);
	await createForm.evaluate((form) => form.setAttribute('novalidate', ''));
	await createForm.getByLabel('Nome').fill('A');
	await createForm.getByRole('button', { name: 'Criar' }).click();
	await expect(page.getByText('Confira os dados da categoria.')).toBeVisible();
	await expect(categoryListPanel(page).locator('.category-item')).toHaveCount(0);

	await createCategory(page, {
		name: 'Categoria válida',
		color: '#2563eb',
		emoji: '💼'
	});

	const row = await categoryRow(page, 'Categoria válida');
	const editForm = row.locator('form.category-edit');
	await editForm.evaluate((form) => form.setAttribute('novalidate', ''));
	await editForm.locator('input[name="name"]').fill('A');
	await editForm.getByRole('button', { name: 'Salvar' }).click();
	await expect(page.getByText('Confira os dados da categoria.')).toBeVisible();
	await expect(await categoryRow(page, 'Categoria válida')).toBeVisible();
});

test('archives categories and removes archived categories from active rule options', async ({
	page
}) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page, {
		name: 'Ativa',
		color: '#2563eb',
		emoji: '💼'
	});
	await createCategory(page, {
		name: 'Arquivável',
		color: '#dc2626',
		emoji: '📦'
	});

	const archivedRow = await categoryRow(page, 'Arquivável');
	await archivedRow.getByRole('button', { name: 'Arquivar' }).click();

	const mutedRow = await categoryRow(page, 'Arquivável');
	await expect(mutedRow).toHaveClass(/muted/);
	await expect(mutedRow.getByRole('button', { name: 'Arquivar' })).toHaveCount(0);
	const activeRow = await categoryRow(page, 'Ativa');
	await expect(activeRow.getByRole('button', { name: 'Arquivar' })).toBeVisible();

	const categoriesSelect = ruleForm(page).getByLabel('Categoria');
	await expect(categoriesSelect).toContainText('💼 Ativa');
	await expect(categoriesSelect).not.toContainText('📦 Arquivável');

	await updateCategory(page, 'Arquivável', {
		name: 'Arquivável renomeada',
		color: '#7c3aed',
		emoji: '📄'
	});
	await expect(await categoryRow(page, 'Arquivável renomeada')).toHaveClass(/muted/);
});

test('creates and archives automatic rules for every match target', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page, {
		name: 'Operacional',
		color: '#2563eb',
		emoji: '🧰'
	});

	await createRule(page, {
		name: 'Descrição obra',
		categoryLabel: '🧰 Operacional',
		matchTarget: 'description',
		pattern: 'obra',
		priority: '1'
	});
	await createRule(page, {
		name: 'Fornecedor ACME',
		categoryLabel: '🧰 Operacional',
		matchTarget: 'vendor',
		pattern: 'ACME',
		priority: '500'
	});
	await createRule(page, {
		name: 'Pagamento cartão',
		categoryLabel: '🧰 Operacional',
		matchTarget: 'payment',
		pattern: 'Cartão',
		priority: '1000'
	});

	const rules = rulePanel(page).locator('.category-item');
	await expect(rules).toHaveCount(3);
	await expect(rules.nth(0)).toContainText('Descrição obra');
	await expect(rules.nth(0)).toContainText('Descrição contém "obra" -> 🧰 Operacional');
	await expect(rules.nth(0)).toContainText('#1');
	await expect(rules.nth(1)).toContainText('Fornecedor ACME');
	await expect(rules.nth(1)).toContainText('Fornecedor contém "ACME" -> 🧰 Operacional');
	await expect(rules.nth(1)).toContainText('#500');
	await expect(rules.nth(2)).toContainText('Pagamento cartão');
	await expect(rules.nth(2)).toContainText('Pagamento contém "Cartão" -> 🧰 Operacional');
	await expect(rules.nth(2)).toContainText('#1000');

	const vendorRule = ruleRow(page, 'Fornecedor ACME');
	await vendorRule.getByRole('button', { name: 'Arquivar' }).click();
	const archivedRule = ruleRow(page, 'Fornecedor ACME');
	await expect(archivedRule).toHaveClass(/muted/);
	await expect(archivedRule.getByRole('button', { name: 'Arquivar' })).toHaveCount(0);
});

test('validates automatic rule errors', async ({ page }) => {
	await registerAndCreateWorkspace(page);
	await createCategory(page, {
		name: 'Operacional',
		color: '#2563eb',
		emoji: '🧰'
	});

	await page.goto('/app/categories');
	const form = ruleForm(page);
	await form.evaluate((element) => element.setAttribute('novalidate', ''));
	await form.getByLabel('Nome').fill('A');
	await form.getByLabel('Categoria').selectOption({ label: '🧰 Operacional' });
	await form.getByLabel('Campo').selectOption('description');
	await form.getByLabel('Contém').fill('A');
	await form.getByLabel('Prioridade').fill('0');
	await form.getByRole('button', { name: 'Criar regra' }).click();
	await expect(page.getByText('Confira os dados da regra.')).toBeVisible();
	await expect(rulePanel(page).locator('.category-item')).toHaveCount(0);

	await page.goto('/app/categories');
	const invalidTargetForm = ruleForm(page);
	await invalidTargetForm.evaluate((element) => element.setAttribute('novalidate', ''));
	await invalidTargetForm.getByLabel('Nome').fill('Regra inválida');
	await invalidTargetForm.getByLabel('Categoria').selectOption({ label: '🧰 Operacional' });
	await invalidTargetForm.locator('select[name="matchTarget"]').evaluate((selectElement) => {
		const select = selectElement as HTMLSelectElement;
		const option = document.createElement('option');
		option.value = 'invalid';
		option.textContent = 'Invalid';
		select.appendChild(option);
		select.value = 'invalid';
		select.dispatchEvent(new Event('change', { bubbles: true }));
	});
	await invalidTargetForm.getByLabel('Contém').fill('padrão');
	await invalidTargetForm.getByLabel('Prioridade').fill('100');
	await invalidTargetForm.getByRole('button', { name: 'Criar regra' }).click();
	await expect(page.getByText('Confira os dados da regra.')).toBeVisible();
	await expect(rulePanel(page).locator('.category-item')).toHaveCount(0);
});
