import {
	expect,
	type APIResponse,
	type Browser,
	type BrowserContext,
	type Page,
	test
} from '@playwright/test';
import { generateTotpCode } from '../lib/server/utils/totp';

test.describe.configure({ mode: 'serial' });
test.use({
	locale: 'pt-BR',
	extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
});

const password = ['test', 'password', '123'].join('-');

type UserSession = {
	context: BrowserContext;
	email: string;
	page: Page;
};

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerAccount(page: Page, input: { email: string; name: string; next?: string }) {
	const search = input.next ? `?next=${encodeURIComponent(input.next)}` : '';
	await page.goto(`/register${search}`);
	await page.getByLabel('Nome').fill(input.name);
	await page.getByLabel('Email').fill(input.email);
	await page.locator('input[name="password"]').fill(password);
	await page.locator('input[name="passwordConfirmation"]').fill(password);
	await page.getByRole('button', { name: 'Criar conta' }).click();
}

async function registerAndCreateWorkspace(page: Page, workspaceName = 'Ajustes E2E') {
	const email = uniqueEmail('settings-owner');
	await registerAccount(page, { email, name: 'Settings Owner' });
	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Nome').fill(workspaceName);
	await page.getByRole('button', { name: 'Criar workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
	return { email, workspaceName };
}

function currentWorkspaceForm(page: Page) {
	return page.locator('form[action="?/update"]');
}

function themeForm(page: Page) {
	return page.locator('form[action="?/updateTheme"]');
}

function localeForm(page: Page) {
	return page.locator('form[action="?/updateLocale"]');
}

function newWorkspaceForm(page: Page) {
	return page.locator('form[action="?/create"]');
}

function switchWorkspaceForm(page: Page) {
	return page.locator('form[action="?/switchWorkspace"]');
}

function securityDisableForm(page: Page) {
	return page.locator('form[action="?/disable"]');
}

function auditRows(page: Page) {
	return page
		.locator('section.panel')
		.filter({ has: page.getByRole('heading', { name: 'Eventos' }) })
		.locator('tbody tr');
}

async function expectActionMessage(response: APIResponse, message: string) {
	expect(response.status()).toBe(200);
	expect(await response.text()).toContain(message);
}

async function postWorkspaceUpdate(
	page: Page,
	input: { name: string; weekStartsOn: string; currency: string }
) {
	return page.request.post('/app/settings/workspace?/update', { form: input });
}

async function postWorkspaceCreate(
	page: Page,
	input: { name: string; weekStartsOn: string; currency: string }
) {
	return page.request.post('/app/settings/workspace?/create', { form: input });
}

async function inviteUser(page: Page, email: string, role: 'admin' | 'member' | 'viewer') {
	await page.goto('/app/settings/users');
	const form = page.locator('form[action="?/invite"]');
	await form.getByLabel('Email').fill(email);
	await form.getByLabel('Papel').selectOption(role);
	await form.getByRole('button', { name: 'Convidar' }).click();

	const inviteUrlRow = page.locator('.invite-url-row');
	await expect(inviteUrlRow).toBeVisible();
	const inviteUrl = (await inviteUrlRow.locator('.invite-url-code').textContent())?.trim();
	expect(inviteUrl).toBeTruthy();
	return inviteUrl!;
}

async function acceptInvite(
	browser: Browser,
	inviteUrl: string,
	input: { email: string; name: string }
): Promise<UserSession> {
	const invitePath = new URL(inviteUrl, 'http://localhost:4173').pathname;
	const context = await browser.newContext({
		locale: 'pt-BR',
		extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
	});
	const page = await context.newPage();
	await registerAccount(page, { email: input.email, name: input.name, next: invitePath });
	await expect(page).toHaveURL(/\/invite\//);
	await page.getByRole('button', { name: 'Aceitar convite' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
	return { context, email: input.email, page };
}

test('covers workspace preferences, appearance, language, creation and switching', async ({
	page
}) => {
	const { workspaceName } = await registerAndCreateWorkspace(page, 'Ajustes Matriz');

	await page.goto('/app/settings/workspace');
	await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Atual' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Aparência' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Idioma' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Conta e auditoria' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Usuários' })).toHaveAttribute(
		'href',
		'/app/settings/users'
	);
	await expect(page.getByRole('link', { name: 'Segurança' })).toHaveAttribute(
		'href',
		'/app/settings/security'
	);
	await expect(page.getByRole('link', { name: 'Auditoria' })).toHaveAttribute(
		'href',
		'/app/settings/audit'
	);

	const updateForm = currentWorkspaceForm(page);
	await updateForm.getByLabel('Nome').fill('Ajustes Matriz Atualizada');
	await updateForm.getByLabel('Início da semana').selectOption('0');
	await updateForm.getByLabel('Moeda').fill('eur');
	await updateForm.getByRole('button', { name: 'Salvar' }).click();
	await expect(page).toHaveURL(/\/app\/settings\/workspace/);
	await expect(currentWorkspaceForm(page).getByLabel('Nome')).toHaveValue(
		'Ajustes Matriz Atualizada'
	);
	await expect(currentWorkspaceForm(page).getByLabel('Início da semana')).toHaveValue('0');
	await expect(currentWorkspaceForm(page).getByLabel('Moeda')).toHaveValue('EUR');

	await themeForm(page).getByLabel('Claro').check();
	await themeForm(page).getByRole('button', { name: 'Salvar tema' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
	await expect(themeForm(page).getByLabel('Claro')).toBeChecked();

	await themeForm(page).getByLabel('Escuro').check();
	await themeForm(page).getByRole('button', { name: 'Salvar tema' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await expect(themeForm(page).getByLabel('Escuro')).toBeChecked();

	await themeForm(page).getByLabel('Sistema').check();
	await themeForm(page).getByRole('button', { name: 'Salvar tema' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
	await expect(themeForm(page).getByLabel('Sistema')).toBeChecked();

	await expect(localeForm(page).getByRole('button', { name: 'Salvar idioma' })).toBeVisible();
	await expect(localeForm(page).locator('select[name="locale"] option[value="pt-BR"]')).toHaveText(
		'🇧🇷 Português (Brasil)'
	);

	await localeForm(page).locator('select[name="locale"]').selectOption('en');
	await expect(page.locator('html')).toHaveAttribute('lang', 'en');
	await expect(page.locator('main .eyebrow', { hasText: 'Settings' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Language' })).toBeVisible();
	await expect(localeForm(page).getByRole('button', { name: 'Save language' })).toBeVisible();
	await expect(localeForm(page).locator('select[name="locale"] option[value="en"]')).toHaveText(
		'🇺🇸 English'
	);

	await localeForm(page).locator('select[name="locale"]').selectOption('pt-BR');
	await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
	await expect(page.locator('main .eyebrow', { hasText: 'Ajustes' })).toBeVisible();
	await expect(localeForm(page).locator('select[name="locale"] option[value="pt-BR"]')).toHaveText(
		'🇧🇷 Português (Brasil)'
	);

	await localeForm(page).locator('select[name="locale"]').selectOption('system');
	await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
	await expect(localeForm(page).locator('select[name="locale"]')).toHaveValue('system');

	const createForm = newWorkspaceForm(page);
	await expect(createForm.getByLabel('Moeda')).toHaveValue('BRL');
	await createForm.getByLabel('Nome').fill('Ajustes Filial');
	await createForm.getByLabel('Início da semana').selectOption('1');
	await createForm.getByLabel('Moeda').fill('usd');
	await createForm.getByRole('button', { name: 'Criar' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);

	await page.goto('/app/settings/workspace');
	await expect(currentWorkspaceForm(page).getByLabel('Nome')).toHaveValue('Ajustes Filial');
	await expect(currentWorkspaceForm(page).getByLabel('Moeda')).toHaveValue('USD');

	await switchWorkspaceForm(page)
		.locator('select[name="workspaceId"]')
		.selectOption({ label: 'Ajustes Matriz Atualizada' });
	await switchWorkspaceForm(page).getByRole('button', { name: 'Trocar' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
	await page.goto('/app/settings/workspace');
	await expect(currentWorkspaceForm(page).getByLabel('Nome')).toHaveValue(
		'Ajustes Matriz Atualizada'
	);
	await expect(switchWorkspaceForm(page).locator('select[name="workspaceId"]')).toContainText(
		workspaceName
	);
});

test('validates workspace settings and enforces owner-only workspace updates', async ({
	browser,
	page
}) => {
	const sessions: UserSession[] = [];
	await registerAndCreateWorkspace(page, 'Ajustes Permissões');

	try {
		await page.goto('/app/settings/workspace');
		await currentWorkspaceForm(page).evaluate((form) => form.setAttribute('novalidate', ''));
		await currentWorkspaceForm(page).getByLabel('Nome').fill('A');
		await currentWorkspaceForm(page).getByRole('button', { name: 'Salvar' }).click();
		await expect(page.getByText('Confira os dados do workspace.')).toBeVisible();

		await expectActionMessage(
			await postWorkspaceUpdate(page, { name: 'A', weekStartsOn: '1', currency: 'USD' }),
			'Confira os dados do workspace.'
		);
		await expectActionMessage(
			await postWorkspaceUpdate(page, {
				name: 'Workspace válido',
				weekStartsOn: '7',
				currency: 'USD'
			}),
			'Confira os dados do workspace.'
		);
		await expectActionMessage(
			await postWorkspaceUpdate(page, {
				name: 'Workspace válido',
				weekStartsOn: '1',
				currency: '12'
			}),
			'Confira os dados do workspace.'
		);
		await expectActionMessage(
			await postWorkspaceCreate(page, { name: 'A', weekStartsOn: '1', currency: 'USD' }),
			'Confira os dados do workspace.'
		);
		await expectActionMessage(
			await page.request.post('/app/settings/workspace?/updateTheme', {
				form: { theme: 'blue' }
			}),
			'Tema inválido.'
		);
		await expectActionMessage(
			await page.request.post('/app/settings/workspace?/updateLocale', {
				form: { locale: 'es' }
			}),
			'Idioma inválido.'
		);
		await expectActionMessage(
			await page.request.post('/app/settings/workspace?/switchWorkspace', {
				form: { workspaceId: 'invalid' }
			}),
			'Workspace inválido.'
		);

		const adminEmail = uniqueEmail('settings-admin');
		const inviteUrl = await inviteUser(page, adminEmail, 'admin');
		const adminSession = await acceptInvite(browser, inviteUrl, {
			email: adminEmail,
			name: 'Settings Admin'
		});
		sessions.push(adminSession);

		expect(
			(
				await postWorkspaceUpdate(adminSession.page, {
					name: 'Tentativa Admin',
					weekStartsOn: '1',
					currency: 'USD'
				})
			).status()
		).toBe(403);

		await expect(
			await adminSession.page.request.post('/app/settings/workspace?/updateTheme', {
				form: { theme: 'dark' }
			})
		).toBeOK();
		await adminSession.page.goto('/app/settings/workspace');
		await expect(adminSession.page.locator('html')).toHaveAttribute('data-theme', 'dark');
	} finally {
		await Promise.all(sessions.map((session) => session.context.close()));
	}
});

test('covers security MFA setup, validation, recovery code disable and enabled-state guard', async ({
	page
}) => {
	await registerAndCreateWorkspace(page, 'Ajustes Segurança');
	await page.goto('/app/settings/security');
	await expect(page.getByRole('heading', { name: 'Segurança' })).toBeVisible();
	await expect(page.getByText('Proteja sua conta com um app autenticador.')).toBeVisible();

	await expectActionMessage(
		await page.request.post('/app/settings/security?/enable', {
			form: { secret: 'short', code: '123456' }
		}),
		'Confira o código MFA.'
	);

	await page.getByRole('button', { name: 'Configurar MFA' }).click();
	await expect(page.getByRole('heading', { name: 'Ativar MFA' })).toBeVisible();
	await expect(page.locator('.setup-uri code')).toContainText('otpauth://totp/');
	let secret = (await page.locator('.setup-code strong').textContent())?.trim();
	expect(secret).toBeTruthy();
	await page.getByLabel('Código gerado no app').fill('000000');
	await page.getByRole('button', { name: 'Ativar' }).click();
	await expect(page.getByText('Código MFA inválido.')).toBeVisible();

	await page.getByRole('button', { name: 'Configurar MFA' }).click();
	secret = (await page.locator('.setup-code strong').textContent())?.trim();
	expect(secret).toBeTruthy();
	await page.getByLabel('Código gerado no app').fill(generateTotpCode(secret!));
	await page.getByRole('button', { name: 'Ativar' }).click();
	await expect(page.getByText('MFA ativado.')).toBeVisible();
	await expect(page.locator('.recovery-grid code')).toHaveCount(10);
	const recoveryCode = (await page.locator('.recovery-grid code').first().textContent())?.trim();
	expect(recoveryCode).toBeTruthy();

	await expectActionMessage(
		await page.request.post('/app/settings/security?/beginSetup', { form: {} }),
		'MFA já está ativo.'
	);

	await page.goto('/app/settings/security');
	await expect(page.getByText('10 recovery codes restantes')).toBeVisible();
	await securityDisableForm(page).getByLabel('Código atual').fill('123');
	await securityDisableForm(page).getByRole('button', { name: 'Desativar MFA' }).click();
	await expect(page.getByText('Informe o código MFA.')).toBeVisible();

	await securityDisableForm(page).getByLabel('Código atual').fill(recoveryCode!);
	await securityDisableForm(page).getByRole('button', { name: 'Desativar MFA' }).click();
	await expect(page).toHaveURL(/\/app\/settings\/security/);
	await expect(page.getByRole('button', { name: 'Configurar MFA' })).toBeVisible();
	await expect(page.getByText('Proteja sua conta com um app autenticador.')).toBeVisible();
});

test('covers audit filters, metadata, empty state, pagination and invalid filters', async ({
	page
}) => {
	await registerAndCreateWorkspace(page, 'Ajustes Auditoria');
	const invitedEmail = uniqueEmail('settings-audit-invite');
	await page.request.post('/app/settings/users?/invite', {
		form: { email: invitedEmail, role: 'viewer' }
	});

	for (let index = 0; index < 52; index += 1) {
		await expect(
			await postWorkspaceUpdate(page, {
				name: `Ajustes Auditoria ${index}`,
				weekStartsOn: String(index % 2),
				currency: index % 2 === 0 ? 'USD' : 'BRL'
			})
		).toBeOK();
	}

	await page.goto('/app/settings/audit');
	await expect(page.getByRole('heading', { name: 'Auditoria' })).toBeVisible();
	await expect(auditRows(page)).toHaveCount(50);
	await expect(page.getByRole('link', { name: 'Próxima página' })).toBeVisible();
	await page.getByRole('link', { name: 'Próxima página' }).click();
	await expect(page).toHaveURL(/cursor=/);
	await expect(auditRows(page).first()).toBeVisible();

	await page.goto('/app/settings/audit');
	await page.getByLabel('Ação').fill('workspace.updated');
	await page.getByLabel('Entidade').fill('workspace');
	await page.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page).toHaveURL(/action=workspace\.updated/);
	await expect(page).toHaveURL(/entityType=workspace/);
	await expect(auditRows(page).first()).toContainText('workspace.updated');
	await expect(auditRows(page).first()).toContainText('workspace');

	await page.goto('/app/settings/audit');
	await page.getByLabel('Ação').fill('workspace_member.invited');
	await page.getByLabel('Entidade').fill('workspace_invitation');
	await page.getByRole('button', { name: 'Filtrar' }).click();
	await expect(auditRows(page)).toHaveCount(1);
	await expect(auditRows(page).first()).toContainText('workspace_member.invited');
	await expect(auditRows(page).first()).toContainText('workspace_invitation');
	await expect(auditRows(page).first()).toContainText(invitedEmail);
	await expect(auditRows(page).first()).toContainText('"role":"viewer"');

	await page.goto('/app/settings/audit');
	await page.getByLabel('Ação').fill('missing.event');
	await page.getByRole('button', { name: 'Filtrar' }).click();
	await expect(page.getByText('Nenhum evento encontrado.')).toBeVisible();
	await page.getByRole('link', { name: 'Limpar' }).click();
	await expect(page).toHaveURL(/\/app\/settings\/audit$/);
	await expect(auditRows(page).first()).toBeVisible();

	expect((await page.request.get(`/app/settings/audit?action=${'x'.repeat(121)}`)).status()).toBe(
		400
	);
	expect(
		(await page.request.get(`/app/settings/audit?entityType=${'x'.repeat(81)}`)).status()
	).toBe(400);
});

test('logout button is hidden on desktop sidebar and visible in settings on mobile', async ({
	page
}) => {
	await registerAndCreateWorkspace(page, 'Ajustes Logout');

	// Desktop (1280px): sidebar footer logout is visible, settings-page logout panel is hidden
	await page.setViewportSize({ width: 1280, height: 800 });
	await page.goto('/app/settings/workspace');
	await expect(page.locator('form.sidebar-footer button[aria-label]')).toBeVisible();
	await expect(page.locator('.logout-panel')).toBeHidden();

	// Mobile (390px): sidebar logout is gone, settings-page logout panel is visible
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/app/settings/workspace');
	await expect(page.locator('.sidebar-footer')).toBeHidden();
	await expect(page.locator('.logout-panel')).toBeVisible();
	await expect(page.locator('.logout-panel form[action="/logout"] button')).toBeVisible();
	// User name and email are shown for context
	await expect(page.locator('.logout-identity strong')).toContainText('Settings Owner');

	// Tablet (768px): same — settings logout visible, sidebar logout absent
	await page.setViewportSize({ width: 768, height: 1024 });
	await page.goto('/app/settings/workspace');
	await expect(page.locator('.sidebar-footer')).toBeHidden();
	await expect(page.locator('.logout-panel')).toBeVisible();
});
