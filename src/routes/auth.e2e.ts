import { expect, type APIResponse, type Page, test } from '@playwright/test';
import { testPassword as password, uniqueEmail } from '../../tests/playwright/fixtures';

test.use({
	locale: 'pt-BR',
	extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
});

function loginForm(page: Page) {
	return page.locator('form').filter({ has: page.getByRole('button', { name: 'Entrar' }) });
}

function registerForm(page: Page) {
	return page.locator('form').filter({ has: page.getByRole('button', { name: 'Criar conta' }) });
}

async function expectActionMessage(response: APIResponse, message: string) {
	expect(response.status()).toBe(200);
	expect(await response.text()).toContain(message);
}

async function registerAccount(
	page: Page,
	input: { email: string; name?: string; next?: string; password?: string }
) {
	const search = input.next ? `?next=${encodeURIComponent(input.next)}` : '';
	await page.goto(`/register${search}`);
	const form = registerForm(page);
	await form.getByLabel('Nome').fill(input.name ?? 'Auth User');
	await form.getByLabel('Email').fill(input.email);
	await form.locator('input[name="password"]').fill(input.password ?? password);
	await form.locator('input[name="passwordConfirmation"]').fill(input.password ?? password);
	await form.getByRole('button', { name: 'Criar conta' }).click();
}

async function createWorkspace(page: Page, name = 'Auth Workspace') {
	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Nome').fill(name);
	await page.getByRole('button', { name: 'Criar workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
}

async function logout(page: Page) {
	await page.request.post('/logout', { form: {} });
	await page.goto('/login');
	await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
}

async function login(page: Page, input: { email: string; next?: string; password?: string }) {
	const search = input.next ? `?next=${encodeURIComponent(input.next)}` : '';
	await page.goto(`/login${search}`);
	await page.getByLabel('Email').fill(input.email);
	await page.getByLabel('Senha').fill(input.password ?? password);
	await page.getByRole('button', { name: 'Entrar' }).click();
}

test('covers login and register screen navigation, banners and safe next values', async ({
	page
}) => {
	await page.goto('/login?registered=1&reset=1&next=https://evil.example/app');
	await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
	await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
	await expect(page.getByText('Conta criada. Entre para continuar.')).toBeVisible();
	await expect(page.getByText('Senha atualizada.')).toBeVisible();
	await expect(loginForm(page).locator('input[name="next"]')).toHaveValue('/app');
	await expect(page.getByRole('link', { name: 'Esqueci minha senha' })).toHaveAttribute(
		'href',
		'/forgot-password'
	);
	await expect(page.getByRole('link', { name: 'Criar conta' })).toHaveAttribute(
		'href',
		'/register'
	);

	await page.getByRole('link', { name: 'Criar conta' }).click();
	await expect(page).toHaveURL(/\/register$/);
	await expect(page.getByRole('heading', { name: 'Criar conta' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Já tenho uma conta' })).toHaveAttribute(
		'href',
		'/login'
	);

	await page.goto('/register?next=//evil.example');
	await expect(registerForm(page).locator('input[name="next"]')).toHaveValue('/app');
	await page.goto(`/register?next=${encodeURIComponent('/invite/test-token')}`);
	await expect(registerForm(page).locator('input[name="next"]')).toHaveValue('/invite/test-token');

	await page.goto(`/login?next=${encodeURIComponent('/app/settings/workspace?tab=security')}`);
	await expect(loginForm(page).locator('input[name="next"]')).toHaveValue(
		'/app/settings/workspace?tab=security'
	);
});

test('detects the browser language and allows manual language changes on login', async ({
	page
}) => {
	await page.goto('/login?next=/app/reports');
	await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
	await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
	await expect(page.getByLabel('Idioma')).toHaveValue('system');
	await expect(page.getByLabel('Idioma').locator('option[value="system"]')).toHaveText(
		'🌐 Idioma do dispositivo'
	);
	await expect(page.getByRole('button', { name: 'Aplicar' })).toHaveCount(0);

	await page.getByLabel('Idioma').selectOption('en');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
	await expect(page.getByLabel('Language')).toHaveValue('en');
	await expect(page.getByLabel('Language').locator('option[value="en"]')).toHaveText('🇺🇸 English');
	await expect(page.getByRole('button', { name: 'Apply' })).toHaveCount(0);
	await expect(page.locator('input[name="next"]')).toHaveValue('/app/reports');

	await page.getByLabel('Language').selectOption('system');
	await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
	await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
	await expect(page.getByLabel('Idioma')).toHaveValue('system');

	const invalidResponse = await page.request.post('/locale', {
		form: { locale: 'es', returnTo: 'https://evil.example/login' }
	});
	expect(invalidResponse.status()).toBe(400);
	expect(await invalidResponse.text()).toContain('Idioma inválido.');
});

test.describe('english auth screens', () => {
	test.use({
		locale: 'en-US',
		extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
	});

	test('uses English labels on login and register', async ({ page }) => {
		await page.goto('/login?registered=1&reset=1');
		await expect(page.locator('html')).toHaveAttribute('lang', 'en');
		await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
		await expect(page.getByText('Account created. Sign in to continue.')).toBeVisible();
		await expect(page.getByText('Password updated.')).toBeVisible();
		await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
		await expect(page.getByRole('link', { name: 'Create account' })).toBeVisible();

		await page.goto('/register');
		await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible();
		await expect(page.getByLabel('Name')).toBeVisible();
		await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
		await expect(page.getByLabel('Confirm password')).toBeVisible();
		await expect(page.getByRole('link', { name: 'I already have an account' })).toBeVisible();
	});

	test('maps registration provider errors to stable English app messages', async ({ browser }) => {
		const email = uniqueEmail('auth-provider-en');
		const firstContext = await browser.newContext({
			locale: 'en-US',
			extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
		});
		const duplicateContext = await browser.newContext({
			locale: 'en-US',
			extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
		});

		try {
			const firstPage = await firstContext.newPage();
			await firstPage.goto('/register');
			await firstPage.getByLabel('Name').fill('English Provider User');
			await firstPage.getByLabel('Email').fill(email);
			await firstPage.locator('input[name="password"]').fill(password);
			await firstPage.locator('input[name="passwordConfirmation"]').fill(password);
			await firstPage.getByRole('button', { name: 'Create account' }).click();
			await expect(firstPage).toHaveURL(/\/app\/onboarding/);

			const duplicatePage = await duplicateContext.newPage();
			await duplicatePage.goto('/register');
			await duplicatePage.getByLabel('Name').fill('Duplicate English User');
			await duplicatePage.getByLabel('Email').fill(email);
			await duplicatePage.locator('input[name="password"]').fill(password);
			await duplicatePage.locator('input[name="passwordConfirmation"]').fill(password);
			await duplicatePage.getByRole('button', { name: 'Create account' }).click();
			await expect(duplicatePage.getByText('Could not create the account.')).toBeVisible();
		} finally {
			await firstContext.close();
			await duplicateContext.close();
		}
	});
});

test('covers register validation, duplicate accounts, success and logged-in redirects', async ({
	browser,
	page
}) => {
	await page.goto('/register');
	const form = registerForm(page);
	await form.evaluate((element) => element.setAttribute('novalidate', ''));
	await expect(form.locator('input[name="password"]')).toHaveAttribute('type', 'password');
	await form.getByRole('button', { name: 'Mostrar senha' }).first().click();
	await expect(form.locator('input[name="password"]')).toHaveAttribute('type', 'text');
	await expect(form.getByRole('button', { name: 'Ocultar senha' }).first()).toBeVisible();
	await form.getByLabel('Nome').fill('A');
	await form.getByLabel('Email').fill('email-invalido');
	await form.locator('input[name="password"]').fill('short');
	await form.locator('input[name="passwordConfirmation"]').fill('short');
	await form.getByRole('button', { name: 'Criar conta' }).click();
	await expect(page.getByText('Confira nome, email e senha.')).toBeVisible();
	await expect(form.getByLabel('Nome')).toHaveValue('A');
	await expect(form.getByLabel('Email')).toHaveValue('email-invalido');

	await form.getByLabel('Nome').fill('Valid User');
	await form.getByLabel('Email').fill(uniqueEmail('auth-password-mismatch'));
	await form.locator('input[name="password"]').fill(password);
	await form.locator('input[name="passwordConfirmation"]').fill('different-password');
	await form.getByRole('button', { name: 'Criar conta' }).click();
	await expect(page.getByText('As senhas não conferem.')).toBeVisible();

	const email = uniqueEmail('auth-register');
	await registerAccount(page, { email, name: 'Registered User' });
	await createWorkspace(page, 'Cadastro Principal');

	const duplicateContext = await browser.newContext({
		locale: 'pt-BR',
		extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
	});
	try {
		const duplicatePage = await duplicateContext.newPage();
		await registerAccount(duplicatePage, { email, name: 'Duplicate User' });
		await expect(duplicatePage.getByRole('heading', { name: 'Criar conta' })).toBeVisible();
		await expect(duplicatePage.getByText('Não foi possível criar a conta.')).toBeVisible();
		await expect(registerForm(duplicatePage).getByLabel('Nome')).toHaveValue('Duplicate User');
		await expect(registerForm(duplicatePage).getByLabel('Email')).toHaveValue(email);
	} finally {
		await duplicateContext.close();
	}

	await page.goto('/register');
	await expect(page).toHaveURL(/\/app\/dashboard/);
	await page.goto('/login');
	await expect(page).toHaveURL(/\/app\/dashboard/);
});

test('covers login validation, invalid credentials, rate limiting, success and redirects', async ({
	page
}) => {
	const email = uniqueEmail('auth-login');
	await registerAccount(page, { email, name: 'Login User' });
	await createWorkspace(page, 'Login Principal');
	await logout(page);

	await page.goto('/login?next=//evil.example');
	await expect(loginForm(page).locator('input[name="next"]')).toHaveValue('/app');

	await page.goto('/login');
	const form = loginForm(page);
	await form.evaluate((element) => element.setAttribute('novalidate', ''));
	const rejectedPassword = ['browser', 'response', 'secret', 'must', 'not', 'leak'].join('-');
	await form.getByLabel('Email').fill('email-invalido');
	await form.getByLabel('Senha').fill(rejectedPassword);
	const invalidResponsePromise = page.waitForResponse(
		(response) => response.url().endsWith('/login') && response.request().method() === 'POST'
	);
	await form.getByRole('button', { name: 'Entrar' }).click();
	const invalidResponseBody = await (await invalidResponsePromise).text();
	await expect(page.getByText('Confira email e senha.')).toBeVisible();
	await expect(form.getByLabel('Email')).toHaveValue('email-invalido');
	await expect(form.getByLabel('Senha')).toHaveValue('');
	expect(invalidResponseBody).not.toContain(rejectedPassword);

	await page.goto('/login?next=/app/reports');
	await page.getByLabel('Email').fill(email);
	await page.getByLabel('Senha').fill(['wrong', 'password', '123'].join('-'));
	await page.getByRole('button', { name: 'Entrar' }).click();
	await expect(page.getByText('Credenciais inválidas.')).toBeVisible();
	await expect(loginForm(page).getByLabel('Email')).toHaveValue(email);
	await expect(loginForm(page).locator('input[name="next"]')).toHaveValue('/app/reports');

	const limitedEmail = uniqueEmail('auth-login-limit');
	for (let attempt = 0; attempt < 5; attempt += 1) {
		await expectActionMessage(
			await page.request.post('/login', {
				form: {
					email: limitedEmail,
					password: ['wrong', 'password', '123'].join('-'),
					next: '/app'
				}
			}),
			'Credenciais inválidas.'
		);
	}
	const limitedResponse = await page.request.post('/login', {
		form: { email: limitedEmail, password: ['wrong', 'password', '123'].join('-'), next: '/app' }
	});
	expect(limitedResponse.status()).toBe(429);
	expect(await limitedResponse.text()).toContain('Muitas tentativas.');

	await login(page, { email, next: '/app/settings/workspace?from=login' });
	await expect(page).toHaveURL(/\/app\/settings\/workspace\?from=login/);
	await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
});

test('covers forgot-password and reset-password entry points from login', async ({ page }) => {
	await page.goto('/login');
	await page.getByRole('link', { name: 'Esqueci minha senha' }).click();
	await expect(page).toHaveURL(/\/forgot-password$/);
	await expect(page.getByRole('heading', { name: 'Recuperar senha' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Voltar' })).toHaveAttribute('href', '/login');

	const recoverForm = page
		.locator('form')
		.filter({ has: page.getByRole('button', { name: 'Enviar' }) });
	await recoverForm.evaluate((element) => element.setAttribute('novalidate', ''));
	await recoverForm.getByLabel('Email').fill('email-invalido');
	await recoverForm.getByRole('button', { name: 'Enviar' }).click();
	await expect(page.getByText('Informe um email válido.')).toBeVisible();

	await recoverForm.getByLabel('Email').fill(uniqueEmail('auth-recover'));
	await recoverForm.getByRole('button', { name: 'Enviar' }).click();
	await expect(page.getByText('Se o email existir, você receberá as instruções.')).toBeVisible();
	await page.getByRole('link', { name: 'Voltar' }).click();
	await expect(page).toHaveURL(/\/login$/);

	await page.goto('/reset-password');
	await expect(page.getByRole('heading', { name: 'Nova senha' })).toBeVisible();
	await page.locator('form').evaluate((element) => element.setAttribute('novalidate', ''));
	await page.getByLabel('Senha').fill('short');
	await page.getByRole('button', { name: 'Salvar senha' }).click();
	await expect(page.getByText('Token ou senha inválidos.')).toBeVisible();

	await page.goto('/reset-password?token=invalid-token-with-enough-length');
	await page.getByLabel('Senha').fill('new-password-123');
	await page.getByRole('button', { name: 'Salvar senha' }).click();
	await expect(page.getByText('Token inválido ou expirado.')).toBeVisible();
});
