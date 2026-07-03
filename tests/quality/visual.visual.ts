import { expect, type Locator, type Page, test } from '@playwright/test';

const password = 'test-password-123';

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerAndSeed(page: Page) {
	await page.goto('/register');
	await page.getByLabel('Name').fill('Visual User');
	await page.getByLabel('Email').fill(uniqueEmail('visual'));
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByLabel('Confirm password').fill(password);
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Name').fill('Visual Workspace');
	await page.getByLabel('Currency').fill('USD');
	await page.getByRole('button', { name: 'Create workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);

	await page.goto('/app/categories');
	const categoryForm = page.locator('form.stack');
	await categoryForm.getByLabel('Name').fill('Operations');
	await categoryForm.locator('input[name="color"]').fill('#2563eb');
	await categoryForm.locator('select[name="icon"]').selectOption('🧰');
	await categoryForm.getByRole('button', { name: 'Create' }).click();
	await expect(page.locator('.category-edit input[name="name"]').first()).toHaveValue('Operations');

	await page.goto('/app/expenses');
	const expenseForm = page.locator('form.expense-create-form');
	await expenseForm.getByLabel('Description').fill('Visual expense');
	await expenseForm.getByLabel('Installment amount').fill('125.40');
	await expenseForm.getByLabel('Date', { exact: true }).fill('2026-06-25');
	await expenseForm.getByLabel('Category').selectOption({ label: '🧰 Operations' });
	await expenseForm.getByLabel('Competency').fill('2026-06');
	await expenseForm.getByLabel('Notes').fill('Stable visual regression fixture');
	await expenseForm.getByRole('button', { name: 'Add' }).click();
	await expect(expenseRow(page, 'Visual expense')).toBeVisible();

	await page.goto('/app/planning?periodMonth=2026-06');
	const budgetForm = page.locator('form[action="?/upsertBudget"]').first();
	await budgetForm.getByLabel('Category').selectOption({ label: '🧰 Operations' });
	await budgetForm.getByLabel('Value').fill('500.00');
	await budgetForm.getByLabel('Alert (%)').fill('80');
	await budgetForm.getByRole('button', { name: 'Save' }).click();
	await expect(page.locator('.budget-item').filter({ hasText: 'Operations' })).toContainText(
		'$500.00'
	);
}

function expenseRow(page: Page, description: string) {
	return page.locator('.expense-table-item').filter({ hasText: description });
}

async function stabilize(page: Page) {
	await page.addStyleTag({
		content: `
			*, *::before, *::after {
				animation-duration: 0s !important;
				animation-delay: 0s !important;
				caret-color: transparent !important;
				transition-duration: 0s !important;
				transition-delay: 0s !important;
			}
		`
	});
	await page.locator('body').evaluate((body) => (body as HTMLElement).blur());
}

async function capture(page: Page, locator: Locator, name: string) {
	await stabilize(page);
	await expect(locator).toHaveScreenshot(name);
}

test('captures stable desktop and mobile app surfaces', async ({ page }) => {
	await registerAndSeed(page);

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/app/dashboard?from=2026-06-01&to=2026-06-30');
	await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
	await capture(page, page.locator('.app-shell'), 'dashboard-desktop.png');

	await page.goto('/app/categories');
	await expect(page.getByRole('heading', { name: 'Categories' })).toBeVisible();
	await capture(page, page.locator('.app-shell'), 'categories-desktop.png');

	await page.goto('/app/reports?from=2026-06-01&to=2026-06-30&groupBy=expense');
	await expect(page.getByRole('heading', { name: 'Analytical' })).toBeVisible();
	await capture(page, page.locator('.app-shell'), 'reports-analytical-desktop.png');

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30');
	await expect(page.getByRole('heading', { exact: true, name: 'Expenses' })).toBeVisible();
	await capture(page, page.locator('.app-shell'), 'expenses-mobile.png');
});
