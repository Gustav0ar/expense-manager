import { expect, type Page, test } from '@playwright/test';
import {
	createWorkspace,
	registerAccount,
	testPassword,
	uniqueEmail
} from '../playwright/fixtures';

const password = process.env.SMOKE_PASSWORD ?? testPassword;
const isExternalSmoke = Boolean(process.env.SMOKE_BASE_URL);
const runWriteSmoke = !isExternalSmoke || process.env.SMOKE_WRITE_TESTS === 'true';

async function loginOrRegister(page: Page) {
	const configuredEmail = process.env.SMOKE_EMAIL;

	if (configuredEmail) {
		await page.goto('/login');
		await page.getByLabel('Email').fill(configuredEmail);
		await page.getByLabel('Password').fill(password);
		await page.getByRole('button', { name: 'Login' }).click();
	} else {
		await registerAccount(page, {
			email: uniqueEmail('smoke'),
			name: 'Smoke User',
			password
		});
	}

	if (page.url().includes('/app/onboarding')) {
		await createWorkspace(page, {
			currency: 'USD',
			name: 'Smoke Workspace'
		});
	}

	await expect(page).toHaveURL(/\/app\/dashboard/);
}

test('passes read-only post-deploy smoke checks', async ({ page }) => {
	const health = await page.request.get('/api/health');
	await expect(health).toBeOK();
	await expect(await health.json()).toEqual(
		expect.objectContaining({
			database: 'ok',
			ok: true
		})
	);

	await page.goto('/login');
	await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();

	await page.goto('/app/dashboard');
	await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fdashboard/);
	await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
});

test('passes write post-deploy smoke checks when enabled', async ({ page }) => {
	test.skip(
		!runWriteSmoke,
		'Set SMOKE_WRITE_TESTS=true, and optionally SMOKE_EMAIL/SMOKE_PASSWORD, to run write smoke checks against a deployed environment.'
	);

	await loginOrRegister(page);
	await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

	const categoryName = `Smoke ${Date.now().toString(36)}`;
	await page.goto('/app/categories');
	const categoryForm = page.locator('form.stack');
	await categoryForm.getByLabel('Name').fill(categoryName);
	await categoryForm.locator('input[name="color"]').fill('#2563eb');
	await categoryForm.locator('select[name="icon"]').selectOption('💼');
	await categoryForm.getByRole('button', { name: 'Create' }).click();
	await expect(page.locator('.category-edit input[name="name"]').first()).toHaveValue(categoryName);

	const expenseDescription = `Smoke expense ${Date.now().toString(36)}`;
	await page.goto('/app/expenses');
	const expenseForm = page.locator('form.expense-create-form');
	await expenseForm.getByLabel('Description').fill(expenseDescription);
	await expenseForm.getByLabel('Installment amount').fill('10.00');
	await expenseForm.getByLabel('Date', { exact: true }).fill('2026-06-30');
	await expenseForm.getByLabel('Category').selectOption({ label: `💼 ${categoryName}` });
	await expenseForm.getByLabel('Competency').fill('2026-06');
	await expenseForm.getByRole('button', { name: 'Add' }).click();
	await expect(
		page.locator('.expense-table-item').filter({ hasText: expenseDescription })
	).toBeVisible();

	await page.goto('/app/dashboard?from=2026-06-01&to=2026-06-30');
	await expect(page.locator('.metric-card').filter({ hasText: 'Total' })).toContainText('$10.00');
});
