import {
	expect,
	type Browser,
	type BrowserContext,
	type Locator,
	type Page,
	test
} from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({
	locale: 'pt-BR',
	extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
});

const password = ['test', 'password', '123'].join('-');

type InvitedUserSession = {
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
	const form = page
		.locator('form')
		.filter({ has: page.getByRole('button', { name: 'Criar conta' }) });
	await expect(form.getByRole('button', { name: 'Criar conta' })).toBeVisible();
	await fillRegisterForm(form, input);
	await form.getByRole('button', { name: 'Criar conta' }).click();
}

async function fillRegisterForm(form: Locator, input: { email: string; name: string }) {
	const name = form.locator('input[name="name"]');
	const email = form.locator('input[name="email"]');
	const passwordInput = form.locator('input[name="password"]');

	for (let attempt = 0; attempt < 3; attempt += 1) {
		await name.fill(input.name);
		await email.fill(input.email);
		await passwordInput.fill(password);

		try {
			await expect(name).toHaveValue(input.name, { timeout: 1000 });
			await expect(email).toHaveValue(input.email, { timeout: 1000 });
			await expect(passwordInput).toHaveValue(password, { timeout: 1000 });
			return;
		} catch (err) {
			if (attempt === 2) throw err;
		}
	}
}

async function registerAndCreateWorkspace(page: Page, workspaceName = 'Usuários E2E') {
	const email = uniqueEmail('users-owner');
	await registerAccount(page, { email, name: 'Owner User' });
	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Nome').fill(workspaceName);
	await page.getByRole('button', { name: 'Criar workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
	return { email, workspaceName };
}

function usersInviteForm(page: Page) {
	return page.locator('form[action="?/invite"]');
}

function membersPanel(page: Page) {
	return page
		.locator('section.panel')
		.filter({ has: page.getByRole('heading', { name: 'Membros' }) });
}

function invitationsPanel(page: Page) {
	return page
		.locator('section.panel')
		.filter({ has: page.getByRole('heading', { name: 'Convites' }) });
}

function tableRows(panel: Locator) {
	return panel.locator('tbody tr');
}

function memberRows(page: Page, email: string) {
	return tableRows(membersPanel(page)).filter({ hasText: email.toLowerCase() });
}

function invitationRows(page: Page, email: string) {
	return tableRows(invitationsPanel(page)).filter({ hasText: email.toLowerCase() });
}

async function memberRow(page: Page, email: string) {
	const rows = memberRows(page, email);
	await expect(rows).toHaveCount(1);
	return rows.first();
}

async function invitationRow(page: Page, email: string) {
	const rows = invitationRows(page, email);
	await expect(rows).toHaveCount(1);
	return rows.first();
}

async function inviteUser(page: Page, email: string, role: 'admin' | 'member' | 'viewer') {
	await page.goto('/app/settings/users');
	const form = usersInviteForm(page);
	await form.getByLabel('Email').fill(email);
	await form.getByLabel('Papel').selectOption(role);
	await form.getByRole('button', { name: 'Convidar' }).click();

	const inviteNotice = page.locator('.notice.success').filter({ hasText: 'Convite criado:' });
	await expect(inviteNotice).toBeVisible();
	const inviteUrl = (await inviteNotice.textContent())?.replace('Convite criado:', '').trim();
	expect(inviteUrl).toBeTruthy();

	const row = await invitationRow(page, email);
	await expect(row.locator('td').nth(1)).toHaveText(role);
	await expect(row.locator('td').nth(2)).toHaveText('pending');
	return inviteUrl!;
}

async function acceptInvite(
	browser: Browser,
	inviteUrl: string,
	input: { email: string; name: string }
): Promise<InvitedUserSession> {
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

async function closeSessions(sessions: InvitedUserSession[]) {
	await Promise.all(sessions.map((session) => session.context.close()));
}

async function changeMemberRole(page: Page, email: string, role: 'admin' | 'member' | 'viewer') {
	await page.goto('/app/settings/users');
	const row = await memberRow(page, email);
	await row.locator('select[name="role"]').selectOption(role);
	await row.getByRole('button', { name: 'Salvar' }).click();
	await expect(page).toHaveURL(/\/app\/settings\/users/);
	await expect((await memberRow(page, email)).locator('select[name="role"]')).toHaveValue(role);
}

async function removeMember(page: Page, email: string) {
	await page.goto('/app/settings/users');
	const row = await memberRow(page, email);
	await row.getByRole('button', { name: 'Remover' }).click();
	await expect(page).toHaveURL(/\/app\/settings\/users/);
	await expect(memberRows(page, email)).toHaveCount(0);
}

async function memberId(page: Page, email: string) {
	const row = await memberRow(page, email);
	return await row.locator('input[name="id"]').first().inputValue();
}

async function inviteByRequest(page: Page, email: string, role: string) {
	return page.request.post('/app/settings/users?/invite', {
		form: { email, role }
	});
}

async function changeRoleByRequest(page: Page, id: string, role: string) {
	return page.request.post('/app/settings/users?/changeRole', {
		form: { id, role }
	});
}

async function removeByRequest(page: Page, id: string) {
	return page.request.post('/app/settings/users?/remove', {
		form: { id }
	});
}

async function expectActionMessage(
	response: Awaited<ReturnType<typeof inviteByRequest>>,
	message: string
) {
	expect(response.status()).toBe(200);
	expect(await response.text()).toContain(message);
}

test('covers invitations, every assignable role, acceptance, role changes and removal', async ({
	browser,
	page
}) => {
	const sessions: InvitedUserSession[] = [];
	const { email: ownerEmail } = await registerAndCreateWorkspace(page);

	try {
		await page.goto('/app/settings/users');
		await expect(page.getByRole('heading', { name: 'Usuários' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Convidar' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Membros' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Convites' })).toBeVisible();

		const ownerRow = await memberRow(page, ownerEmail);
		await expect(ownerRow.locator('td').nth(2)).toHaveText('owner');
		await expect(ownerRow.locator('select[name="role"]')).toHaveCount(0);
		await expect(ownerRow.getByRole('button', { name: 'Remover' })).toHaveCount(0);

		const roleCycleEmail = uniqueEmail('users-role-cycle');
		const initialInviteUrl = await inviteUser(page, roleCycleEmail, 'viewer');
		const renewedInviteUrl = await inviteUser(page, roleCycleEmail, 'member');
		expect(new URL(renewedInviteUrl).pathname).not.toBe(new URL(initialInviteUrl).pathname);
		await expect(invitationRows(page, roleCycleEmail)).toHaveCount(1);
		await expect((await invitationRow(page, roleCycleEmail)).locator('td').nth(1)).toHaveText(
			'member'
		);

		const roleCycleSession = await acceptInvite(browser, renewedInviteUrl, {
			email: roleCycleEmail,
			name: 'Role Cycle User'
		});
		sessions.push(roleCycleSession);
		await page.goto('/app/settings/users');
		await expect((await invitationRow(page, roleCycleEmail)).locator('td').nth(2)).toHaveText(
			'accepted'
		);
		await expect(
			(await memberRow(page, roleCycleEmail)).locator('select[name="role"]')
		).toHaveValue('member');

		await changeMemberRole(page, roleCycleEmail, 'admin');
		await changeMemberRole(page, roleCycleEmail, 'viewer');
		await changeMemberRole(page, roleCycleEmail, 'member');

		const adminEmail = uniqueEmail('users-admin');
		const adminInviteUrl = await inviteUser(page, adminEmail, 'admin');
		const adminSession = await acceptInvite(browser, adminInviteUrl, {
			email: adminEmail,
			name: 'Admin User'
		});
		sessions.push(adminSession);
		await page.goto('/app/settings/users');
		await expect((await memberRow(page, adminEmail)).locator('select[name="role"]')).toHaveValue(
			'admin'
		);

		const removableEmail = uniqueEmail('users-removable');
		const removableInviteUrl = await inviteUser(page, removableEmail, 'viewer');
		const removableSession = await acceptInvite(browser, removableInviteUrl, {
			email: removableEmail,
			name: 'Removable User'
		});
		sessions.push(removableSession);
		await removeMember(page, removableEmail);

		await removableSession.page.goto('/app/settings/users');
		await expect(removableSession.page).toHaveURL(/\/app\/onboarding/);
	} finally {
		await closeSessions(sessions);
	}
});

test('enforces member management permissions for admin, member and viewer roles', async ({
	browser,
	page
}) => {
	const sessions: InvitedUserSession[] = [];
	await registerAndCreateWorkspace(page);

	try {
		const adminEmail = uniqueEmail('users-permission-admin');
		const memberEmail = uniqueEmail('users-permission-member');
		const viewerEmail = uniqueEmail('users-permission-viewer');
		const adminInviteUrl = await inviteUser(page, adminEmail, 'admin');
		const memberInviteUrl = await inviteUser(page, memberEmail, 'member');
		const viewerInviteUrl = await inviteUser(page, viewerEmail, 'viewer');

		const adminSession = await acceptInvite(browser, adminInviteUrl, {
			email: adminEmail,
			name: 'Permission Admin'
		});
		const memberSession = await acceptInvite(browser, memberInviteUrl, {
			email: memberEmail,
			name: 'Permission Member'
		});
		const viewerSession = await acceptInvite(browser, viewerInviteUrl, {
			email: viewerEmail,
			name: 'Permission Viewer'
		});
		sessions.push(adminSession, memberSession, viewerSession);

		await page.goto('/app/settings/users');
		const targetMemberId = await memberId(page, memberEmail);
		const targetViewerId = await memberId(page, viewerEmail);

		await expect(
			await inviteByRequest(adminSession.page, uniqueEmail('users-admin-created'), 'viewer')
		).toBeOK();
		await expect(await changeRoleByRequest(adminSession.page, targetMemberId, 'viewer')).toBeOK();
		await page.goto('/app/settings/users');
		await expect((await memberRow(page, memberEmail)).locator('select[name="role"]')).toHaveValue(
			'viewer'
		);

		const memberInviteResponse = await inviteByRequest(
			memberSession.page,
			uniqueEmail('users-member-denied'),
			'viewer'
		);
		expect(memberInviteResponse.status()).toBe(403);
		expect((await changeRoleByRequest(memberSession.page, targetViewerId, 'member')).status()).toBe(
			403
		);
		expect((await removeByRequest(memberSession.page, targetViewerId)).status()).toBe(403);

		expect(
			(
				await inviteByRequest(viewerSession.page, uniqueEmail('users-viewer-denied'), 'member')
			).status()
		).toBe(403);
		expect((await changeRoleByRequest(viewerSession.page, targetViewerId, 'admin')).status()).toBe(
			403
		);
		expect((await removeByRequest(viewerSession.page, targetViewerId)).status()).toBe(403);

		await expect(await removeByRequest(adminSession.page, targetViewerId)).toBeOK();
		await page.goto('/app/settings/users');
		await expect(memberRows(page, viewerEmail)).toHaveCount(0);
		await viewerSession.page.goto('/app/settings/users');
		await expect(viewerSession.page).toHaveURL(/\/app\/onboarding/);
	} finally {
		await closeSessions(sessions);
	}
});

test('validates user actions and invitation acceptance errors', async ({ browser, page }) => {
	const sessions: InvitedUserSession[] = [];
	await registerAndCreateWorkspace(page);

	try {
		await page.goto('/app/settings/users');
		const inviteForm = usersInviteForm(page);
		await inviteForm.evaluate((form) => form.setAttribute('novalidate', ''));
		await inviteForm.getByLabel('Email').fill('email-invalido');
		await inviteForm.getByRole('button', { name: 'Convidar' }).click();
		await expect(page.getByText('Confira email e papel.')).toBeVisible();

		await expectActionMessage(
			await inviteByRequest(page, uniqueEmail('users-invalid-role'), 'owner'),
			'Confira email e papel.'
		);
		await expectActionMessage(
			await changeRoleByRequest(page, 'invalid-id', 'viewer'),
			'Confira membro e papel.'
		);
		expect((await changeRoleByRequest(page, '999999999', 'viewer')).status()).toBe(404);
		await expectActionMessage(
			await changeRoleByRequest(page, '1', 'owner'),
			'Confira membro e papel.'
		);
		await expectActionMessage(await removeByRequest(page, 'invalid-id'), 'Membro inválido.');
		expect((await removeByRequest(page, '999999999')).status()).toBe(404);

		const wrongTargetEmail = uniqueEmail('users-wrong-target');
		const wrongInviteUrl = await inviteUser(page, wrongTargetEmail, 'viewer');
		const wrongInvitePath = new URL(wrongInviteUrl, 'http://localhost:4173').pathname;
		const unauthenticatedContext = await browser.newContext({
			locale: 'pt-BR',
			extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
		});
		sessions.push({
			context: unauthenticatedContext,
			email: '',
			page: await unauthenticatedContext.newPage()
		});
		await sessions.at(-1)!.page.goto(wrongInvitePath);
		await expect(sessions.at(-1)!.page.getByRole('link', { name: 'Entrar' })).toBeVisible();
		await expect(sessions.at(-1)!.page.getByRole('link', { name: 'Criar conta' })).toBeVisible();

		const wrongEmailSession = await acceptInviteWithWrongEmail(browser, wrongInviteUrl);
		sessions.push(wrongEmailSession);
		expect(
			(
				await wrongEmailSession.page.request.post(`${wrongInvitePath}?/accept`, { form: {} })
			).status()
		).toBe(403);

		const acceptedSession = await acceptInvite(browser, wrongInviteUrl, {
			email: wrongTargetEmail,
			name: 'Correct Invite User'
		});
		sessions.push(acceptedSession);
		await expectActionMessage(
			await acceptedSession.page.request.post(`${wrongInvitePath}?/accept`, { form: {} }),
			'Convite inválido ou expirado.'
		);
		await acceptedSession.page.goto(wrongInvitePath);
		await expect(acceptedSession.page.getByText('Convite inválido ou expirado.')).toBeVisible();

		await page.goto('/invite/token-invalido');
		await expect(page.getByText('Convite inválido ou expirado.')).toBeVisible();
	} finally {
		await closeSessions(sessions);
	}
});

test('keeps invitations scoped to the active workspace', async ({ page }) => {
	await registerAndCreateWorkspace(page, 'Workspace Principal');
	const scopedEmail = uniqueEmail('users-scoped');
	await inviteUser(page, scopedEmail, 'viewer');

	await page.goto('/app/settings/workspace');
	const createWorkspaceForm = page.locator('form[action="?/create"]');
	await createWorkspaceForm.getByLabel('Nome').fill('Workspace Secundário');
	await createWorkspaceForm.getByRole('button', { name: 'Criar' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);

	await page.goto('/app/settings/users');
	await expect(invitationRows(page, scopedEmail)).toHaveCount(0);
	await expect(tableRows(membersPanel(page))).toHaveCount(1);

	await page.goto('/app/settings/workspace');
	const switchForm = page.locator('form[action="?/switchWorkspace"]');
	await switchForm
		.locator('select[name="workspaceId"]')
		.selectOption({ label: 'Workspace Principal' });
	await switchForm.getByRole('button', { name: 'Trocar' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);

	await page.goto('/app/settings/users');
	await expect(invitationRows(page, scopedEmail)).toHaveCount(1);
});

async function acceptInviteWithWrongEmail(
	browser: Browser,
	inviteUrl: string
): Promise<InvitedUserSession> {
	const invitePath = new URL(inviteUrl, 'http://localhost:4173').pathname;
	const email = uniqueEmail('users-wrong-email');
	const context = await browser.newContext({
		locale: 'pt-BR',
		extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' }
	});
	const page = await context.newPage();
	await registerAccount(page, { email, name: 'Wrong Invite User', next: invitePath });
	await expect(page).toHaveURL(/\/invite\//);
	await expect(page.getByRole('button', { name: 'Aceitar convite' })).toBeVisible();
	return { context, email, page };
}
