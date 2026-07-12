import { expect, type Locator, type Page, test } from '@playwright/test';
import { registerAndCreateWorkspace } from '../playwright/fixtures';

async function registerAndSeed(page: Page) {
	await registerAndCreateWorkspace(page, {
		currency: 'USD',
		emailPrefix: 'visual',
		locale: 'en-US',
		userName: 'Visual User',
		workspaceName: 'Visual Workspace'
	});

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

	await page.goto('/app/planning?section=budgets&periodMonth=2026-06');
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

	await page.goto('/app/planning?section=imports&periodMonth=2026-06');
	let importForm = page.locator('form[action="?/importExpenses"]');
	await importForm.getByLabel('Format').selectOption('ofx');
	await importForm.locator('input[type="file"]').setInputFiles({
		name: 'visual-reconciliation.ofx',
		mimeType: 'application/x-ofx',
		buffer: Buffer.from(
			'<OFX><BANKACCTFROM><BANKID>001<ACCTID>visual</BANKACCTFROM><BANKTRANLIST><STMTTRN><DTPOSTED>20260625<TRNAMT>-125.40<FITID>visual-match<NAME>Visual expense</STMTTRN></BANKTRANLIST></OFX>'
		)
	});
	await importForm.getByRole('button', { name: 'Import' }).click();
	const reconciliation = page.locator('.reconciliation-workspace');
	await expect(
		reconciliation.getByRole('heading', { name: 'Reconcile OFX transactions' })
	).toBeVisible();
	await capture(page, reconciliation, 'ofx-reconciliation-desktop.png');
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
	await capture(page, reconciliation, 'ofx-reconciliation-mobile.png');
	await page.setViewportSize({ width: 1280, height: 900 });
	await reconciliation.getByRole('button', { name: 'Match' }).click();

	importForm = page.locator('form[action="?/importExpenses"]');
	await importForm.getByLabel('Default category').selectOption({ label: '🧰 Operations' });
	await importForm.locator('input[type="file"]').setInputFiles({
		name: 'visual-preview.csv',
		mimeType: 'text/csv',
		buffer: Buffer.from(
			[
				'date,description,amount',
				'2026-06-25,Visual expense,125.40',
				'2026-06-26,Preview proposal,42.75',
				'2026-06-27,Invalid preview row,'
			].join('\n')
		)
	});
	await importForm.getByRole('button', { name: 'Import' }).click();
	const preview = page.locator('.import-preview');
	await expect(preview.getByRole('heading', { name: 'Import preview' })).toBeVisible();
	await expect(preview.getByRole('checkbox')).toHaveCount(2);
	const selectProposed = preview.getByRole('button', { name: 'Select proposed' });
	await selectProposed.focus();
	await selectProposed.press('Tab');
	await expect(preview.getByRole('button', { name: 'Clear selection' })).toBeFocused();
	await expect(preview).toContainText('1 duplicates');
	await expect(preview).toContainText('1 failures');
	await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 1280);
	await capture(page, preview, 'import-preview-desktop.png');

	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
	await capture(page, preview, 'import-preview-mobile.png');

	await page.goto('/app/expenses?from=2026-06-01&to=2026-06-30');
	await expect(page.getByRole('heading', { exact: true, name: 'Expenses' })).toBeVisible();
	await capture(page, page.locator('.app-shell'), 'expenses-mobile.png');

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/app/planning?periodMonth=2026-06');
	const notificationCenter = page.locator('.notification-center');
	await expect(notificationCenter.getByRole('heading', { name: 'Budget alerts' })).toBeVisible();
	await capture(page, notificationCenter, 'budget-notifications-desktop.png');
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
	await expect(notificationCenter.locator('.rail-labels span:nth-child(2)')).toBeHidden();
	await capture(page, notificationCenter, 'budget-notifications-mobile.png');

	await page.setViewportSize({ width: 1280, height: 900 });
	await page.goto('/app/expenses?q=Visual%20expense');
	await expenseRow(page, 'Visual expense')
		.getByRole('button', { name: 'Delete Visual expense' })
		.click();
	await page
		.getByRole('dialog', { name: 'Delete expense?' })
		.getByRole('button', { name: 'Delete', exact: true })
		.click();
	await page.goto('/app/expenses/trash');
	const trashPage = page.locator('.trash-page');
	await expect(trashPage.getByRole('heading', { name: 'Expense trash' })).toBeVisible();
	await capture(page, trashPage, 'expense-trash-desktop.png');
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.locator('html')).toHaveJSProperty('scrollWidth', 390);
	await capture(page, trashPage, 'expense-trash-mobile.png');
});
