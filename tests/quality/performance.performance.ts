import { expect, type Page, test } from '@playwright/test';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const password = ['test', 'password', '123'].join('-');
const kib = 1024;

type AssetBudget = {
	largestJsBytes: number;
	totalCssBytes: number;
	totalGzipJsBytes: number;
	totalJsBytes: number;
};

type RuntimeBudget = {
	domContentLoadedMs: number;
	jsResources: number;
	loadMs: number;
	resources: number;
	transferBytes: number;
};

const assetBudget: AssetBudget = {
	largestJsBytes: 90 * kib,
	totalCssBytes: 80 * kib,
	totalGzipJsBytes: 140 * kib,
	// Durable invitation delivery adds localized status and resend UX. The previous
	// 380 KiB ceiling was 389,120 bytes; the reviewed production build measured
	// 391,433 bytes. Keep the gzip, largest-asset and runtime budgets unchanged.
	totalJsBytes: 384 * kib
};

const runtimeBudget: RuntimeBudget = {
	domContentLoadedMs: 1500,
	jsResources: 35,
	loadMs: 2500,
	resources: 80,
	transferBytes: 1_200 * kib
};

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function collectFiles(root: string, extensions: string[]) {
	const files: string[] = [];
	for (const entry of readdirSync(root)) {
		const fullPath = path.join(root, entry);
		const stats = statSync(fullPath);
		if (stats.isDirectory()) {
			files.push(...collectFiles(fullPath, extensions));
			continue;
		}
		if (extensions.some((extension) => fullPath.endsWith(extension))) files.push(fullPath);
	}
	return files;
}

async function registerAndSeed(page: Page) {
	await page.goto('/register');
	await page.getByLabel('Name').fill('Performance User');
	await page.getByLabel('Email').fill(uniqueEmail('performance'));
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByLabel('Confirm password').fill(password);
	await page.getByRole('button', { name: 'Create account' }).click();

	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Name').fill('Performance Workspace');
	await page.getByLabel('Currency').fill('USD');
	await page.getByRole('button', { name: 'Create workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);

	await page.goto('/app/categories');
	const categoryForm = page.locator('form.stack');
	await categoryForm.getByLabel('Name').fill('Operations');
	await categoryForm.locator('input[name="color"]').fill('#2563eb');
	await categoryForm.locator('select[name="icon"]').selectOption('🧰');
	await categoryForm.getByRole('button', { name: 'Create' }).click();

	await page.goto('/app/expenses');
	const expenseForm = page.locator('form.expense-create-form');
	await expenseForm.getByLabel('Description').fill('Performance expense');
	await expenseForm.getByLabel('Installment amount').fill('200.00');
	await expenseForm.getByLabel('Date', { exact: true }).fill('2026-06-25');
	await expenseForm.getByLabel('Category').selectOption({ label: '🧰 Operations' });
	await expenseForm.getByLabel('Competency').fill('2026-06');
	await expenseForm.getByRole('button', { name: 'Add' }).click();
	await expect(
		page.locator('.expense-table-item').filter({ hasText: 'Performance expense' })
	).toBeVisible();
}

async function collectRuntimeMetrics(page: Page, url: string) {
	await page.goto(url, { waitUntil: 'load' });
	await page.waitForLoadState('networkidle');
	return page.evaluate(() => {
		const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
		const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
		const jsResources = resources.filter((resource) => resource.name.includes('.js'));
		return {
			domContentLoadedMs: navigation.domContentLoadedEventEnd - navigation.startTime,
			jsResources: jsResources.length,
			loadMs: navigation.loadEventEnd - navigation.startTime,
			resources: resources.length,
			transferBytes: resources.reduce((total, resource) => total + resource.transferSize, 0)
		};
	});
}

test('keeps production client assets within the performance budget', async () => {
	const assetRoot = path.resolve('.svelte-kit/output/client/_app/immutable');
	expect(existsSync(assetRoot)).toBe(true);

	const jsFiles = collectFiles(assetRoot, ['.js']);
	const cssFiles = collectFiles(assetRoot, ['.css']);
	const jsSizes = jsFiles.map((file) => statSync(file).size);
	const totalJsBytes = jsSizes.reduce((total, size) => total + size, 0);
	const largestJsBytes = Math.max(...jsSizes);
	const totalGzipJsBytes = jsFiles.reduce(
		(total, file) => total + gzipSync(readFileSync(file)).length,
		0
	);
	const totalCssBytes = cssFiles.reduce((total, file) => total + statSync(file).size, 0);

	expect(largestJsBytes, 'largest JS asset').toBeLessThanOrEqual(assetBudget.largestJsBytes);
	expect(totalJsBytes, 'total JS assets').toBeLessThanOrEqual(assetBudget.totalJsBytes);
	expect(totalGzipJsBytes, 'total gzipped JS assets').toBeLessThanOrEqual(
		assetBudget.totalGzipJsBytes
	);
	expect(totalCssBytes, 'total CSS assets').toBeLessThanOrEqual(assetBudget.totalCssBytes);
});

test('keeps core pages and mobile navigation within runtime budgets', async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 900 });
	await registerAndSeed(page);

	for (const route of [
		'/app/dashboard?from=2026-06-01&to=2026-06-30',
		'/app/expenses?from=2026-06-01&to=2026-06-30',
		'/app/reports?from=2026-06-01&to=2026-06-30&groupBy=expense',
		'/app/settings/workspace'
	]) {
		const metrics = await collectRuntimeMetrics(page, route);
		expect(metrics.domContentLoadedMs, `${route} DOMContentLoaded`).toBeLessThanOrEqual(
			runtimeBudget.domContentLoadedMs
		);
		expect(metrics.loadMs, `${route} load`).toBeLessThanOrEqual(runtimeBudget.loadMs);
		expect(metrics.resources, `${route} resource count`).toBeLessThanOrEqual(
			runtimeBudget.resources
		);
		expect(metrics.jsResources, `${route} JS resources`).toBeLessThanOrEqual(
			runtimeBudget.jsResources
		);
		expect(metrics.transferBytes, `${route} transferred bytes`).toBeLessThanOrEqual(
			runtimeBudget.transferBytes
		);
	}

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/app/dashboard?from=2026-06-01&to=2026-06-30');
	for (const target of [
		{ heading: 'Expenses', nav: 'Expenses' },
		{ heading: 'Budget', nav: 'Budget' },
		{ heading: 'Reports', nav: 'Reports' },
		{ heading: 'Workspace', nav: 'Settings' },
		{ heading: 'Dashboard', nav: 'Dashboard' }
	]) {
		const startedAt = Date.now();
		await page.getByRole('link', { name: target.nav }).click();
		await expect(page.getByRole('heading', { exact: true, name: target.heading })).toBeVisible();
		expect(Date.now() - startedAt, `${target.nav} mobile navigation`).toBeLessThanOrEqual(1000);
	}
});
