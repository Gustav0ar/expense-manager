import { expect, test } from '@playwright/test';

test.use({
	locale: 'en-US',
	extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
});

test('blocks self-service registration when ALLOW_REGISTRATION is false', async ({ page }) => {
	await page.goto('/login');
	await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Create account' })).toHaveCount(0);

	await page.goto('/register');
	await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
	await expect(page.getByText('Registration is currently closed.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Create account' })).toHaveCount(0);

	const routeResponse = await page.request.post('/register', {
		form: {
			name: 'Locked User',
			email: `locked-${Date.now()}@example.com`,
			password: ['test', 'password', '123'].join('-'),
			next: '/app'
		}
	});
	expect(routeResponse.status()).toBe(200);
	expect(await routeResponse.text()).toContain('Registration is currently closed.');

	const apiResponse = await page.request.post('/api/auth/sign-up/email', {
		data: {
			name: 'Locked API User',
			email: `locked-api-${Date.now()}@example.com`,
			password: ['test', 'password', '123'].join('-')
		},
		headers: {
			Origin: 'http://localhost:4174'
		}
	});
	expect(apiResponse.status()).toBe(403);
	expect(await apiResponse.text()).toContain('Registration is currently closed.');
});
