import { expect, type APIResponse, type Page, test } from '@playwright/test';
import {
	createWorkspace as setupWorkspace,
	registerAccount as registerTestAccount,
	uniqueEmail
} from '../../tests/playwright/fixtures';

test.use({
	locale: 'pt-BR',
	extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
});

async function registerAccount(page: Page, input: { email?: string; name?: string } = {}) {
	const email = input.email ?? uniqueEmail('system');
	await registerTestAccount(
		page,
		{ email, name: input.name ?? 'System User' },
		{ locale: 'pt-BR' }
	);
	return email;
}

async function createWorkspace(page: Page, name = 'Sistema E2E') {
	await setupWorkspace(page, { locale: 'pt-BR', name });
}

async function registerAndCreateWorkspace(page: Page, workspaceName = 'Sistema E2E') {
	const email = await registerAccount(page);
	await createWorkspace(page, workspaceName);
	return email;
}

async function createCategoryByRequest(page: Page, name = 'Planejamento Teste') {
	const response = await page.request.post('/app/categories?/create', {
		form: { name, color: '#2563eb', icon: '💼' }
	});
	await expect(response).toBeOK();
}

async function expectActionMessage(response: APIResponse, message: string) {
	expect(response.status()).toBe(200);
	expect(await response.text()).toContain(message);
}

function expenseRow(page: Page, description: string) {
	return page.locator('.expense-table-item').filter({ hasText: description });
}

test('authenticates and deduplicates grouped Mailjet delivery events', async ({
	page,
	playwright
}) => {
	const endpoint = '/api/webhooks/mailjet';
	const unauthorized = await page.request.post(endpoint, {
		data: { event: 'sent', time: Math.floor(Date.now() / 1000), email: 'admin@example.com' }
	});
	expect(unauthorized.status()).toBe(401);
	expect(unauthorized.headers()['www-authenticate']).toContain('Basic');

	const authorization = `Basic ${Buffer.from('mailjet-e2e:mailjet-e2e-password').toString('base64')}`;
	const payload = [
		{
			event: 'sent',
			time: Math.floor(Date.now() / 1000),
			email: 'admin@example.com',
			Message_GUID: randomWebhookId(),
			CustomID: `budget-alert:${randomWebhookId()}`
		},
		{
			event: 'open',
			time: Math.floor(Date.now() / 1000),
			email: 'admin@example.com',
			Message_GUID: randomWebhookId()
		}
	];
	const accepted = await page.request.post(endpoint, {
		headers: { Authorization: authorization },
		data: payload
	});
	await expect(accepted).toBeOK();
	expect(await accepted.json()).toEqual({ accepted: 2, duplicates: 0, matched: 0 });

	const replay = await page.request.post(endpoint, {
		headers: { Authorization: authorization },
		data: payload
	});
	await expect(replay).toBeOK();
	expect(await replay.json()).toEqual({ accepted: 0, duplicates: 2, matched: 0 });

	const stale = await page.request.post(endpoint, {
		headers: { Authorization: authorization },
		data: { event: 'sent', time: 1, email: 'admin@example.com' }
	});
	expect(stale.status()).toBe(400);

	const oversizedClient = await playwright.request.newContext({
		baseURL: 'http://localhost:4173'
	});
	try {
		const oversized = await oversizedClient.post(endpoint, {
			headers: { Authorization: authorization },
			data: {
				event: 'sent',
				time: Math.floor(Date.now() / 1000),
				email: 'admin@example.com',
				Payload: 'x'.repeat(257 * 1024)
			}
		});
		expect(oversized.status()).toBe(413);
	} finally {
		await oversizedClient.dispose();
	}
});

function randomWebhookId() {
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
		const value = Math.floor(Math.random() * 16);
		return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16);
	});
}

test('covers root redirects, health check, onboarding validation and explicit logout', async ({
	page
}) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/login$/);

	const health = await page.request.get('/api/health');
	await expect(health).toBeOK();
	await expect(await health.json()).toEqual(
		expect.objectContaining({
			ok: true,
			database: 'ok',
			timestamp: expect.any(String),
			durationMs: expect.any(Number)
		})
	);

	await registerAccount(page);
	await expect(page).toHaveURL(/\/app\/onboarding/);

	await page.goto('/app/dashboard');
	await expect(page).toHaveURL(/\/app\/onboarding/);

	const onboardingForm = page.locator('form');
	await onboardingForm.evaluate((form) => form.setAttribute('novalidate', ''));
	await onboardingForm.getByLabel('Nome').fill('A');
	await onboardingForm.getByLabel('Moeda').fill('1');
	await onboardingForm.getByRole('button', { name: 'Criar workspace' }).click();
	await expect(page.getByText('Confira os dados do workspace.')).toBeVisible();

	await createWorkspace(page, 'Sistema Rotas');

	await page.goto('/');
	await expect(page).toHaveURL(/\/app\/dashboard/);
	await page.goto('/app');
	await expect(page).toHaveURL(/\/app\/dashboard/);

	await page.locator('form[action="/logout"] button').click();
	await expect(page).toHaveURL(/\/login$/);
	await page.goto('/app/dashboard');
	await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fdashboard/);
});

test('covers planning bad paths and budget deletion', async ({ page }) => {
	await registerAndCreateWorkspace(page, 'Sistema Planejamento');
	await createCategoryByRequest(page);

	expect((await page.request.get('/app/planning?periodMonth=2026-13')).status()).toBe(400);
	expect((await page.request.get('/app/planning?section=unknown')).status()).toBe(400);

	await page.goto('/app/planning?periodMonth=2026-06');
	const categoryId = await page
		.locator('form[action="?/upsertBudget"] select[name="categoryId"] option')
		.first()
		.getAttribute('value');
	expect(categoryId).toBeTruthy();
	await expect(page.locator('form[action="?/createRecurring"]')).toHaveCount(0);
	await expect(page.locator('form[action="?/importExpenses"]')).toHaveCount(0);
	await page.getByRole('link', { name: 'Recorrências' }).click();
	await expect(page).toHaveURL(/section=recurring/);
	await expect(page.locator('form[action="?/createRecurring"]')).toBeVisible();
	await expect(page.locator('form[action="?/upsertBudget"]')).toHaveCount(0);
	await page.getByRole('link', { name: 'Importar despesas' }).click();
	await expect(page).toHaveURL(/section=imports/);
	await expect(page.locator('form[action="?/importExpenses"]')).toBeVisible();
	await expect(page.locator('form[action="?/createRecurring"]')).toHaveCount(0);
	await page.goto('/app/planning?section=budgets&periodMonth=2026-06');
	const notificationCenter = page.locator('.notification-center');
	await expect(
		notificationCenter.getByRole('heading', { name: 'Configurações de notificações' })
	).toBeVisible();
	await expect(
		notificationCenter.getByText('Ainda não há histórico de envios de alertas.')
	).toBeVisible();
	await notificationCenter.getByRole('checkbox', { name: /Alertas automáticos por email/ }).check();
	await notificationCenter.getByRole('radio', { name: /Gestores selecionados/ }).check();
	const saveNotifications = notificationCenter.getByRole('button', {
		name: 'Salvar configurações de notificações'
	});
	await expect(saveNotifications).toBeDisabled();
	await expect(
		notificationCenter.getByText('Não há gestores elegíveis disponíveis para alertas de orçamento.')
	).toBeVisible();
	await notificationCenter
		.getByRole('checkbox', { name: /Alertas automáticos por email/ })
		.uncheck();
	await expect(saveNotifications).toBeEnabled();
	await saveNotifications.click();
	await expect(page.getByText('Preferências de alertas de orçamento salvas.')).toBeVisible();

	await expectActionMessage(
		await page.request.post('/app/planning?/createCatalog', {
			form: { kind: 'paymentMethod', name: 'A', periodMonth: '2026-06' }
		}),
		'Confira o cadastro auxiliar.'
	);
	await expectActionMessage(
		await page.request.post('/app/planning?/sendBudgetAlerts', {
			form: { periodMonth: '2026-13' }
		}),
		'Mês inválido para alertas.'
	);
	await expectActionMessage(
		await page.request.post('/app/planning?/setBudgetAlertPreference', {
			form: { enabled: 'yes' }
		}),
		'Preferência de alertas de orçamento inválida.'
	);
	await expectActionMessage(
		await page.request.post('/app/planning?/deleteBudget', {
			form: { id: 'invalid', periodMonth: '2026-06' }
		}),
		'Orçamento inválido.'
	);
	await expectActionMessage(
		await page.request.post('/app/planning?/pauseRecurring', {
			form: { id: 'invalid', periodMonth: '2026-06' }
		}),
		'Recorrência inválida.'
	);
	await expectActionMessage(
		await page.request.post('/app/planning?/resumeRecurring', {
			form: { id: 'invalid', periodMonth: '2026-06' }
		}),
		'Recorrência inválida.'
	);

	await expect(
		await page.request.post('/app/planning?/upsertBudget', {
			form: {
				categoryId: categoryId!,
				periodMonth: '2026-06',
				amount: '320,00',
				warningThresholdPct: '75'
			}
		})
	).toBeOK();

	await page.goto('/app/planning?periodMonth=2026-06');
	let budgetItem = page.locator('.budget-item').filter({ hasText: 'Planejamento Teste' });
	await expect(budgetItem).toContainText('de R$ 320,00');

	await budgetItem.getByRole('button', { name: 'Remover orçamento' }).click();
	await expect(page).toHaveURL(/\/app\/planning\?section=budgets&periodMonth=2026-06-01/);
	budgetItem = page.locator('.budget-item').filter({ hasText: 'Planejamento Teste' });
	await expect(budgetItem).toContainText('Sem meta');
});

test('keeps attachment downloads private to the active workspace', async ({ browser, page }) => {
	await registerAndCreateWorkspace(page, 'Sistema Anexos');
	await createCategoryByRequest(page, 'Documentos');

	await page.goto('/app/expenses');
	const expenseForm = page.locator('form.expense-create-form');
	await expenseForm.getByLabel('Descrição').fill('Despesa com anexo privado');
	await expenseForm.getByLabel('Valor da parcela').fill('42,00');
	await expenseForm.getByLabel('Data', { exact: true }).fill('2026-06-14');
	await expenseForm.getByLabel('Categoria').selectOption({ label: '💼 Documentos' });
	await expenseForm.getByRole('button', { name: 'Adicionar' }).click();

	let row = expenseRow(page, 'Despesa com anexo privado');
	await expect(row).toBeVisible();
	await row.locator('summary').click();
	await row.locator('input[type="file"]').setInputFiles({
		name: 'privado.txt',
		mimeType: 'text/plain',
		buffer: Buffer.from('conteúdo privado')
	});
	await row.getByRole('button', { name: 'Anexar' }).click();

	row = expenseRow(page, 'Despesa com anexo privado');
	await row.locator('summary').click();
	const attachmentHref = await row.locator('.attachment-chip').first().getAttribute('href');
	expect(attachmentHref).toBeTruthy();

	const ownerDownload = await page.request.get(attachmentHref!);
	await expect(ownerDownload).toBeOK();
	expect(await ownerDownload.text()).toBe('conteúdo privado');

	const anonymousContext = await browser.newContext({
		locale: 'pt-BR',
		extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
	});
	const otherContext = await browser.newContext({
		locale: 'pt-BR',
		extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
	});

	try {
		const anonymousResponse = await anonymousContext.request.get(attachmentHref!, {
			maxRedirects: 0
		});
		expect(anonymousResponse.status()).toBe(303);
		expect(anonymousResponse.headers().location).toContain('/login?next=');

		const otherPage = await otherContext.newPage();
		await registerAndCreateWorkspace(otherPage, 'Outro Workspace');
		expect((await otherPage.request.get(attachmentHref!)).status()).toBe(404);
	} finally {
		await anonymousContext.close();
		await otherContext.close();
	}
});
