import { expect, type Page, test } from '@playwright/test';

const password = ['test', 'password', '123'].join('-');

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerAccount(page: Page, input: { email: string; name: string }) {
	await page.goto('/register');
	await page.getByLabel('Name').fill(input.name);
	await page.getByLabel('Email').fill(input.email);
	await page.getByLabel('Password').fill(password);
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
		page.getByText(
			'Verify your email before signing in. Check your inbox for the verification link.'
		)
	).toBeVisible();
});
