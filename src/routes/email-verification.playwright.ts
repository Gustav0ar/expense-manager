import { expect, type Page, test } from '@playwright/test';

const password = 'test-password-123';

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerAccount(page: Page, input: { email: string; name: string }) {
	await page.goto('/register');
	await page.getByLabel('Name').fill(input.name);
	await page.getByLabel('Email').fill(input.email);
	await page.getByLabel('Password', { exact: true }).fill(password);
	await page.getByLabel('Confirm password').fill(password);
	await page.getByRole('button', { name: 'Create account' }).click();
}

test.use({
	locale: 'en-US',
	extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
});

test('requires email verification before first production login', async ({ page }) => {
	const email = uniqueEmail('verify-email');

	await registerAccount(page, { email, name: 'Verification User' });

	await expect(page).toHaveURL(/\/login\?verifyEmail=1$/);
	await expect(
		page.getByText('Account created. Check your email to verify your account before signing in.')
	).toBeVisible();

	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Login' }).click();

	await expect(page).toHaveURL(/\/login\?verifyEmail=1$/);
	await expect(
		page.getByText('Wait 2 minutes before requesting another verification email.')
	).toBeVisible();
});

test('rate limits verification email when an unverified account registers again too soon', async ({
	page
}) => {
	const email = uniqueEmail('verify-email-duplicate');

	await registerAccount(page, { email, name: 'Duplicate Verification User' });
	await expect(page).toHaveURL(/\/login\?verifyEmail=1$/);

	await registerAccount(page, { email, name: 'Duplicate Verification User' });

	await expect(
		page.getByText('Wait 2 minutes before requesting another verification email.')
	).toBeVisible();
});
