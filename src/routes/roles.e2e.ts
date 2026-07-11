import {
	expect,
	type APIResponse,
	type Browser,
	type BrowserContext,
	type Page,
	test
} from '@playwright/test';

test.describe.configure({ mode: 'serial', timeout: 120_000 });
test.use({
	locale: 'en-US',
	extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
});

const password = ['test', 'password', '123'].join('-');

type Role = 'owner' | 'admin' | 'member' | 'viewer';
type AssignableRole = Exclude<Role, 'owner'>;
type Session = {
	context?: BrowserContext;
	email: string;
	page: Page;
	role: Role;
};

function uniqueEmail(prefix: string) {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function registerAccount(page: Page, input: { email: string; name: string; next?: string }) {
	const search = input.next ? `?next=${encodeURIComponent(input.next)}` : '';

	for (let attempt = 0; attempt < 3; attempt += 1) {
		await page.goto(`/register${search}`);
		await page.waitForLoadState('networkidle');
		const form = page
			.locator('form')
			.filter({ has: page.getByRole('button', { name: 'Create account' }) });
		await expect(form.getByRole('button', { name: 'Create account' })).toBeVisible();
		await fillRegisterForm(form, input);
		await form.getByRole('button', { name: 'Create account' }).click();

		try {
			await expect(page).not.toHaveURL(/\/register/, { timeout: 5000 });
			return;
		} catch (err) {
			if (attempt === 2) throw err;
		}
	}
}

async function fillRegisterForm(
	form: ReturnType<Page['locator']>,
	input: { email: string; name: string }
) {
	const name = form.locator('input[name="name"]');
	const email = form.locator('input[name="email"]');
	const passwordInput = form.locator('input[name="password"]');
	const passwordConfirmationInput = form.locator('input[name="passwordConfirmation"]');

	await name.fill(input.name);
	await email.fill(input.email);
	await passwordInput.fill(password);
	await passwordConfirmationInput.fill(password);
	await expect(name).toHaveValue(input.name);
	await expect(email).toHaveValue(input.email);
	await expect(passwordInput).toHaveValue(password);
	await expect(passwordConfirmationInput).toHaveValue(password);
}

async function registerAndCreateWorkspace(page: Page, workspaceName = 'Roles E2E') {
	const email = uniqueEmail('roles-owner');
	await registerAccount(page, { email, name: 'Owner User' });
	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel('Name').fill(workspaceName);
	await page.getByLabel('Currency').fill('USD');
	await page.getByRole('button', { name: 'Create workspace' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
	return { email, role: 'owner' as const, page };
}

async function inviteUser(page: Page, email: string, role: AssignableRole) {
	await page.goto('/app/settings/users');
	const form = page.locator('form[action="?/invite"]');
	await form.getByLabel('Email').fill(email);
	await form.getByLabel('Role').selectOption(role);
	await form.getByRole('button', { name: 'Invite' }).click();

	const inviteUrlRow = page.locator('.invite-url-row');
	await expect(inviteUrlRow).toBeVisible();
	const inviteUrl = (await inviteUrlRow.locator('.invite-url-code').textContent())?.trim();
	expect(inviteUrl).toBeTruthy();
	return inviteUrl!;
}

async function acceptInvite(
	browser: Browser,
	inviteUrl: string,
	input: { email: string; name: string; role: AssignableRole }
): Promise<Session> {
	const invitePath = new URL(inviteUrl, 'http://localhost:4173').pathname;
	const context = await browser.newContext({
		locale: 'en-US',
		extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
	});
	const page = await context.newPage();
	await registerAccount(page, { email: input.email, name: input.name, next: invitePath });
	await expect(page).toHaveURL(/\/invite\//);
	await page.getByRole('button', { name: 'Accept invite' }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
	return { context, email: input.email, page, role: input.role };
}

async function createRoleSessions(browser: Browser, ownerPage: Page) {
	const adminEmail = uniqueEmail('roles-admin');
	const memberEmail = uniqueEmail('roles-member');
	const viewerEmail = uniqueEmail('roles-viewer');

	const adminInvite = await inviteUser(ownerPage, adminEmail, 'admin');
	const memberInvite = await inviteUser(ownerPage, memberEmail, 'member');
	const viewerInvite = await inviteUser(ownerPage, viewerEmail, 'viewer');

	const admin = await acceptInvite(browser, adminInvite, {
		email: adminEmail,
		name: 'Admin User',
		role: 'admin'
	});
	const member = await acceptInvite(browser, memberInvite, {
		email: memberEmail,
		name: 'Member User',
		role: 'member'
	});
	const viewer = await acceptInvite(browser, viewerInvite, {
		email: viewerEmail,
		name: 'Viewer User',
		role: 'viewer'
	});

	return { admin, member, viewer };
}

async function closeSessions(sessions: Session[]) {
	await Promise.all(
		sessions.flatMap((session) => (session.context ? [session.context.close()] : []))
	);
}

async function expectAllowed(response: APIResponse, label: string) {
	expect(response.status(), label).toBeLessThan(400);
}

async function expectDenied(response: APIResponse, label: string) {
	expect(response.status(), label).toBe(403);
}

function createCategoryRequest(page: Page, name: string) {
	return page.request.post('/app/categories?/create', {
		form: { name, color: '#2563eb', icon: '💼' }
	});
}

function createRuleRequest(page: Page, categoryId: string, name: string) {
	return page.request.post('/app/categories?/createRule', {
		form: {
			name,
			categoryId,
			matchTarget: 'description',
			pattern: name,
			priority: '100'
		}
	});
}

function upsertBudgetRequest(page: Page, categoryId: string, amount = '1000.00') {
	return page.request.post('/app/planning?/upsertBudget', {
		form: {
			categoryId,
			periodMonth: '2026-06',
			amount,
			warningThresholdPct: '80'
		}
	});
}

function sendBudgetAlertsRequest(page: Page) {
	return page.request.post('/app/planning?/sendBudgetAlerts', {
		form: { periodMonth: '2026-06' }
	});
}

function setBudgetAlertPreferenceRequest(page: Page, enabled = true) {
	return page.request.post('/app/planning?/setBudgetAlertPreference', {
		form: { enabled: String(enabled) }
	});
}

function updateWorkspaceRequest(page: Page, name: string) {
	return page.request.post('/app/settings/workspace?/update', {
		form: { name, weekStartsOn: '1', currency: 'USD' }
	});
}

function inviteByRequest(page: Page, email: string, role: AssignableRole) {
	return page.request.post('/app/settings/users?/invite', {
		form: { email, role }
	});
}

function changeRoleByRequest(page: Page, id: string, role: AssignableRole) {
	return page.request.post('/app/settings/users?/changeRole', {
		form: { id, role }
	});
}

function removeByRequest(page: Page, id: string) {
	return page.request.post('/app/settings/users?/remove', {
		form: { id }
	});
}

function createCatalogRequest(page: Page, name: string) {
	return page.request.post('/app/expenses?/createCatalog', {
		form: { kind: 'vendor', name, returnTo: '/app/expenses' }
	});
}

function createExpenseRequest(
	page: Page,
	categoryId: string,
	input: { description: string; amount?: string; installments?: string }
) {
	return page.request.post('/app/expenses?/create', {
		form: {
			categoryId,
			description: input.description,
			amount: input.amount ?? '10.00',
			expenseDate: '2026-06-10',
			competencyMonth: '2026-06',
			installments: input.installments ?? '1',
			notes: 'Created by role permission E2E',
			returnTo: '/app/expenses'
		}
	});
}

function updateExpenseRequest(
	page: Page,
	expenseId: string,
	categoryId: string,
	description: string
) {
	return page.request.post('/app/expenses?/update', {
		form: {
			id: expenseId,
			categoryId,
			description,
			amount: '11.00',
			expenseDate: '2026-06-11',
			competencyMonth: '2026-06',
			installments: '1',
			notes: 'Updated by role permission E2E',
			returnTo: '/app/expenses'
		}
	});
}

function deleteExpenseRequest(page: Page, expenseId: string) {
	return page.request.post('/app/expenses?/delete', {
		form: { id: expenseId, returnTo: '/app/expenses' }
	});
}

function reviewExpenseRequest(
	page: Page,
	expenseId: string,
	reviewStatus: 'approved' | 'rejected' = 'approved'
) {
	return page.request.post('/app/expenses?/review', {
		form: {
			id: expenseId,
			reviewStatus,
			reason: reviewStatus === 'rejected' ? 'Rejected by role permission E2E' : '',
			returnTo: '/app/expenses'
		}
	});
}

function paymentStatusRequest(
	page: Page,
	expenseId: string,
	paymentStatus: 'unpaid' | 'paid' | 'reconciled' = 'paid'
) {
	return page.request.post('/app/expenses?/payment', {
		form: {
			id: expenseId,
			paymentStatus,
			paidAt: paymentStatus === 'unpaid' ? '' : '2026-06-12',
			returnTo: '/app/expenses'
		}
	});
}

function createRecurringRequest(page: Page, categoryId: string, description: string) {
	return page.request.post('/app/planning?/createRecurring', {
		form: {
			categoryId,
			description,
			amount: '25.00',
			frequency: 'monthly',
			intervalCount: '1',
			startDate: '2026-06-01',
			endDate: '',
			notes: 'Recurring role permission E2E',
			periodMonth: '2026-06'
		}
	});
}

function syncRecurringRequest(page: Page) {
	return page.request.post('/app/planning?/syncRecurring', {
		form: { periodMonth: '2026-06' }
	});
}

function importExpensesRequest(page: Page, categoryId: string, description: string) {
	const csv = `date,description,amount\n2026-06-22,${description},44.00\n`;
	return page.request.post('/app/planning?/importExpenses', {
		multipart: {
			sourceType: 'csv',
			defaultCategoryId: categoryId,
			file: {
				name: 'role-permissions.csv',
				mimeType: 'text/csv',
				buffer: Buffer.from(csv)
			}
		}
	});
}

function stageOfxRequest(page: Page, fitId: string) {
	return page.request.post('/app/planning?/importExpenses', {
		multipart: {
			sourceType: 'ofx',
			file: {
				name: 'role-reconciliation.ofx',
				mimeType: 'application/x-ofx',
				buffer: Buffer.from(
					`<OFX><BANKACCTFROM><BANKID>001<ACCTID>roles</BANKACCTFROM><BANKTRANLIST><STMTTRN><DTPOSTED>20260622<TRNAMT>-15.00<FITID>${fitId}<NAME>Role reconciliation</STMTTRN></BANKTRANLIST></OFX>`
				)
			}
		}
	});
}

function membersPanel(page: Page) {
	return page
		.locator('section.panel')
		.filter({ has: page.getByRole('heading', { name: 'Members' }) });
}

async function memberRow(page: Page, email: string) {
	await page.goto('/app/settings/users');
	const row = membersPanel(page).locator('tbody tr').filter({ hasText: email.toLowerCase() });
	await expect(row).toHaveCount(1);
	return row;
}

async function memberId(page: Page, email: string) {
	const row = await memberRow(page, email);
	return row.locator('input[name="id"]').first().inputValue();
}

async function categoryId(page: Page, categoryName: string) {
	await page.goto('/app/expenses');
	const option = page
		.locator('form.expense-create-form select[name="categoryId"] option')
		.filter({ hasText: categoryName })
		.first();
	await expect(option).toHaveCount(1);
	const value = await option.getAttribute('value');
	expect(value).toBeTruthy();
	return value!;
}

async function expenseId(page: Page, description: string) {
	await page.goto(`/app/expenses?q=${encodeURIComponent(description)}`);
	const row = page.locator('.expense-table-item').filter({ hasText: description }).first();
	await expect(row).toBeVisible();
	await row.locator('summary').click();
	const idInput = row.locator('form[action="?/update"] input[name="id"]').first();
	await expect(idInput).toHaveValue(/\d+/);
	return idInput.inputValue();
}

async function recurringId(page: Page, description: string) {
	await page.goto('/app/planning?periodMonth=2026-06');
	const item = page.locator('.recurring-item').filter({ hasText: description }).first();
	await expect(item).toBeVisible();
	const idInput = item.locator('input[name="id"]').first();
	await expect(idInput).toHaveValue(/\d+/);
	return idInput.inputValue();
}

function setRecurringStatusRequest(
	page: Page,
	action: 'pauseRecurring' | 'resumeRecurring',
	id: string
) {
	return page.request.post(`/app/planning?/${action}`, {
		form: { id, periodMonth: '2026-06' }
	});
}

async function budgetId(page: Page, categoryName: string) {
	await page.goto('/app/planning?periodMonth=2026-06');
	const item = page.locator('.budget-item').filter({ hasText: categoryName }).first();
	await expect(item).toBeVisible();
	const idInput = item.locator('form[action="?/deleteBudget"] input[name="id"]').first();
	await expect(idInput).toHaveValue(/\d+/);
	return idInput.inputValue();
}

function deleteBudgetRequest(page: Page, id: string) {
	return page.request.post('/app/planning?/deleteBudget', {
		form: { id, periodMonth: '2026-06' }
	});
}

test('allows every workspace role to read the shared application screens', async ({
	browser,
	page
}) => {
	const owner = await registerAndCreateWorkspace(page, 'Roles Read Workspace');
	const invited = await createRoleSessions(browser, owner.page);
	const sessions: Session[] = [owner, invited.admin, invited.member, invited.viewer];

	try {
		const screens = [
			{ path: '/app/dashboard', heading: 'Dashboard' },
			{ path: '/app/expenses', heading: 'Expenses' },
			{ path: '/app/categories', heading: 'Categories' },
			{ path: '/app/planning', heading: 'Budget' },
			{ path: '/app/reports', heading: 'Reports' },
			{ path: '/app/settings/users', heading: 'Users' },
			{ path: '/app/settings/workspace', heading: 'Workspace' },
			{ path: '/app/settings/security', heading: 'Security' },
			{ path: '/app/settings/audit', heading: 'Audit' }
		];

		for (const session of sessions) {
			for (const screen of screens) {
				const response = await session.page.goto(screen.path);
				expect(response?.status(), `${session.role} can read ${screen.path}`).toBeLessThan(400);
				await expect(
					session.page.getByRole('heading', { name: screen.heading }).first(),
					`${session.role} sees ${screen.heading}`
				).toBeVisible();
			}
		}
	} finally {
		await closeSessions(sessions);
	}
});

test('enforces administration boundaries for workspace, members, categories and budgets', async ({
	browser,
	page
}) => {
	const owner = await registerAndCreateWorkspace(page, 'Roles Admin Workspace');
	const invited = await createRoleSessions(browser, owner.page);
	const sessions: Session[] = [owner, invited.admin, invited.member, invited.viewer];

	try {
		await expectAllowed(
			await createCategoryRequest(owner.page, 'Admin Base'),
			'owner creates category'
		);
		const baseCategoryId = await categoryId(owner.page, 'Admin Base');

		await expectAllowed(
			await updateWorkspaceRequest(owner.page, 'Roles Admin Workspace Updated'),
			'owner updates workspace'
		);
		await expectDenied(
			await updateWorkspaceRequest(invited.admin.page, 'Admin Cannot Update Workspace'),
			'admin cannot update workspace'
		);
		await expectDenied(
			await updateWorkspaceRequest(invited.member.page, 'Member Cannot Update Workspace'),
			'member cannot update workspace'
		);
		await expectDenied(
			await updateWorkspaceRequest(invited.viewer.page, 'Viewer Cannot Update Workspace'),
			'viewer cannot update workspace'
		);

		await expectAllowed(
			await createCategoryRequest(invited.admin.page, 'Admin Category'),
			'admin creates category'
		);
		await expectDenied(
			await createCategoryRequest(invited.member.page, 'Member Category'),
			'member cannot create category'
		);
		await expectDenied(
			await createCategoryRequest(invited.viewer.page, 'Viewer Category'),
			'viewer cannot create category'
		);

		await expectAllowed(
			await createRuleRequest(owner.page, baseCategoryId, 'Owner Rule'),
			'owner creates automatic rule'
		);
		await expectAllowed(
			await createRuleRequest(invited.admin.page, baseCategoryId, 'Admin Rule'),
			'admin creates automatic rule'
		);
		await expectDenied(
			await createRuleRequest(invited.member.page, baseCategoryId, 'Member Rule'),
			'member cannot create automatic rule'
		);
		await expectDenied(
			await createRuleRequest(invited.viewer.page, baseCategoryId, 'Viewer Rule'),
			'viewer cannot create automatic rule'
		);

		await expectAllowed(
			await upsertBudgetRequest(owner.page, baseCategoryId),
			'owner upserts budget'
		);
		await expectAllowed(
			await upsertBudgetRequest(invited.admin.page, baseCategoryId, '1200.00'),
			'admin upserts budget'
		);
		await expectDenied(
			await upsertBudgetRequest(invited.member.page, baseCategoryId),
			'member cannot upsert budget'
		);
		await expectDenied(
			await upsertBudgetRequest(invited.viewer.page, baseCategoryId),
			'viewer cannot upsert budget'
		);
		await expectAllowed(await sendBudgetAlertsRequest(owner.page), 'owner can send budget alerts');
		await expectAllowed(
			await sendBudgetAlertsRequest(invited.admin.page),
			'admin can send budget alerts'
		);
		await expectDenied(
			await sendBudgetAlertsRequest(invited.member.page),
			'member cannot send budget alerts'
		);
		await expectDenied(
			await sendBudgetAlertsRequest(invited.viewer.page),
			'viewer cannot send budget alerts'
		);
		await expectAllowed(
			await setBudgetAlertPreferenceRequest(owner.page),
			'owner can enable automatic budget alerts'
		);
		await expectAllowed(
			await setBudgetAlertPreferenceRequest(invited.admin.page),
			'admin can enable automatic budget alerts'
		);
		await expectDenied(
			await setBudgetAlertPreferenceRequest(invited.member.page),
			'member cannot change automatic budget alerts'
		);
		await expectDenied(
			await setBudgetAlertPreferenceRequest(invited.viewer.page),
			'viewer cannot change automatic budget alerts'
		);

		await owner.page.goto('/app/planning?periodMonth=2026-06');
		const notificationCenter = owner.page.locator('.notification-center');
		await expect(
			notificationCenter.getByRole('heading', { name: 'Alert thresholds' })
		).toBeVisible();
		await expect(
			notificationCenter.getByRole('heading', { name: 'Notification settings' })
		).toBeVisible();
		const selectedManagers = notificationCenter.getByRole('radio', {
			name: /Selected managers/
		});
		await selectedManagers.focus();
		await selectedManagers.press('Space');
		await expect(selectedManagers).toBeChecked();
		await expect(
			notificationCenter.getByText('No eligible managers are available for budget alerts.')
		).toBeVisible();
		expect(await owner.page.content()).not.toContain(invited.admin.email);

		for (const restricted of [invited.member, invited.viewer]) {
			await restricted.page.goto('/app/planning?periodMonth=2026-06');
			const restrictedCenter = restricted.page.locator('.notification-center');
			await expect(
				restrictedCenter.getByRole('heading', { name: 'Alert thresholds' })
			).toBeVisible();
			await expect(
				restrictedCenter.getByRole('heading', { name: 'Notification settings' })
			).toHaveCount(0);
			expect(await restricted.page.content()).not.toContain(invited.admin.email);
		}

		const savedBudgetId = await budgetId(owner.page, 'Admin Base');
		await expectDenied(
			await deleteBudgetRequest(invited.member.page, savedBudgetId),
			'member cannot delete budget'
		);
		await expectDenied(
			await deleteBudgetRequest(invited.viewer.page, savedBudgetId),
			'viewer cannot delete budget'
		);
		await expectAllowed(
			await deleteBudgetRequest(invited.admin.page, savedBudgetId),
			'admin deletes budget'
		);

		const memberMemberId = await memberId(owner.page, invited.member.email);
		const viewerMemberId = await memberId(owner.page, invited.viewer.email);
		const ownerRow = await memberRow(owner.page, owner.email);
		await expect(
			ownerRow.locator('select[name="role"]'),
			'owner role is immutable in UI'
		).toHaveCount(0);
		await expect(
			ownerRow.getByRole('button', { name: 'Remove' }),
			'owner cannot be removed in UI'
		).toHaveCount(0);

		await expectAllowed(
			await inviteByRequest(owner.page, uniqueEmail('roles-owner-invite'), 'viewer'),
			'owner invites users'
		);
		await expectAllowed(
			await inviteByRequest(invited.admin.page, uniqueEmail('roles-admin-invite'), 'member'),
			'admin invites users'
		);
		await expectDenied(
			await inviteByRequest(invited.member.page, uniqueEmail('roles-member-invite'), 'viewer'),
			'member cannot invite users'
		);
		await expectDenied(
			await inviteByRequest(invited.viewer.page, uniqueEmail('roles-viewer-invite'), 'member'),
			'viewer cannot invite users'
		);

		await expectAllowed(
			await changeRoleByRequest(owner.page, memberMemberId, 'member'),
			'owner changes assignable member role'
		);
		await expectAllowed(
			await changeRoleByRequest(invited.admin.page, viewerMemberId, 'viewer'),
			'admin changes assignable member role'
		);
		await expectDenied(
			await changeRoleByRequest(invited.member.page, viewerMemberId, 'member'),
			'member cannot change roles'
		);
		await expectDenied(
			await changeRoleByRequest(invited.viewer.page, memberMemberId, 'viewer'),
			'viewer cannot change roles'
		);

		const removableEmail = uniqueEmail('roles-removable');
		const removableInvite = await inviteUser(owner.page, removableEmail, 'viewer');
		const removable = await acceptInvite(browser, removableInvite, {
			email: removableEmail,
			name: 'Removable User',
			role: 'viewer'
		});
		sessions.push(removable);
		const removableId = await memberId(owner.page, removableEmail);
		await expectDenied(
			await removeByRequest(invited.member.page, removableId),
			'member cannot remove workspace members'
		);
		await expectDenied(
			await removeByRequest(invited.viewer.page, removableId),
			'viewer cannot remove workspace members'
		);
		await expectAllowed(
			await removeByRequest(invited.admin.page, removableId),
			'admin removes workspace member'
		);
		await removable.page.goto('/app/dashboard');
		await expect(removable.page).toHaveURL(/\/app\/onboarding/);
	} finally {
		await closeSessions(sessions);
	}
});

test('enforces expense, review, payment, catalog, recurrence and import permissions', async ({
	browser,
	page
}) => {
	const owner = await registerAndCreateWorkspace(page, 'Roles Expense Workspace');
	const invited = await createRoleSessions(browser, owner.page);
	const sessions: Session[] = [owner, invited.admin, invited.member, invited.viewer];

	try {
		await expectAllowed(
			await createCategoryRequest(owner.page, 'Expense Base'),
			'owner creates category for expense tests'
		);
		const baseCategoryId = await categoryId(owner.page, 'Expense Base');

		await expectAllowed(
			await createCatalogRequest(owner.page, 'Owner Vendor'),
			'owner creates support catalog item'
		);
		await expectAllowed(
			await createCatalogRequest(invited.admin.page, 'Admin Vendor'),
			'admin creates support catalog item'
		);
		await expectAllowed(
			await createCatalogRequest(invited.member.page, 'Member Vendor'),
			'member creates support catalog item'
		);
		await expectDenied(
			await createCatalogRequest(invited.viewer.page, 'Viewer Vendor'),
			'viewer cannot create support catalog item'
		);

		await expectAllowed(
			await createExpenseRequest(owner.page, baseCategoryId, { description: 'Owner Expense' }),
			'owner creates approved expense'
		);
		await expectAllowed(
			await createExpenseRequest(invited.admin.page, baseCategoryId, {
				description: 'Admin Expense'
			}),
			'admin creates approved expense'
		);
		await expectAllowed(
			await createExpenseRequest(invited.member.page, baseCategoryId, {
				description: 'Member Pending Expense'
			}),
			'member creates pending expense'
		);
		await expectDenied(
			await createExpenseRequest(invited.viewer.page, baseCategoryId, {
				description: 'Viewer Expense'
			}),
			'viewer cannot create expense'
		);

		await invited.member.page.goto('/app/expenses?q=Member%20Pending%20Expense');
		await expect(
			invited.member.page
				.locator('.expense-table-item')
				.filter({ hasText: 'Member Pending Expense' })
		).toContainText('Pending');
		await invited.admin.page.goto('/app/expenses?q=Admin%20Expense');
		await expect(
			invited.admin.page.locator('.expense-table-item').filter({ hasText: 'Admin Expense' })
		).toContainText('Approved');

		const memberExpenseId = await expenseId(owner.page, 'Member Pending Expense');
		await expectAllowed(
			await updateExpenseRequest(
				invited.member.page,
				memberExpenseId,
				baseCategoryId,
				'Member Updated Expense'
			),
			'member updates own pending expense'
		);
		const updatedMemberExpenseId = await expenseId(owner.page, 'Member Updated Expense');
		await expectDenied(
			await updateExpenseRequest(
				invited.viewer.page,
				updatedMemberExpenseId,
				baseCategoryId,
				'Viewer Update'
			),
			'viewer cannot update expense'
		);
		await expectDenied(
			await reviewExpenseRequest(invited.member.page, updatedMemberExpenseId),
			'member cannot approve expense'
		);
		await expectDenied(
			await reviewExpenseRequest(invited.viewer.page, updatedMemberExpenseId),
			'viewer cannot approve expense'
		);
		await expectAllowed(
			await reviewExpenseRequest(invited.admin.page, updatedMemberExpenseId),
			'admin approves pending expense'
		);
		await expectAllowed(
			await updateExpenseRequest(
				invited.member.page,
				updatedMemberExpenseId,
				baseCategoryId,
				'Late Member Update'
			),
			'member updates approved open expense and sends it back to review'
		);
		await owner.page.goto('/app/expenses?q=Late%20Member%20Update');
		await expect(
			owner.page.locator('.expense-table-item').filter({ hasText: 'Late Member Update' })
		).toContainText('Pending');

		const adminExpenseId = await expenseId(owner.page, 'Admin Expense');
		await expectDenied(
			await paymentStatusRequest(invited.member.page, adminExpenseId, 'paid'),
			'member cannot mark payment'
		);
		await expectDenied(
			await paymentStatusRequest(invited.viewer.page, adminExpenseId, 'paid'),
			'viewer cannot mark payment'
		);
		await expectAllowed(
			await paymentStatusRequest(invited.admin.page, adminExpenseId, 'paid'),
			'admin marks approved expense as paid'
		);
		await expectAllowed(
			await paymentStatusRequest(owner.page, adminExpenseId, 'reconciled'),
			'owner reconciles paid expense'
		);
		await expectDenied(
			await deleteExpenseRequest(invited.member.page, adminExpenseId),
			'member cannot delete paid approved expense'
		);
		await expectAllowed(
			await deleteExpenseRequest(owner.page, adminExpenseId),
			'owner deletes approved reconciled expense'
		);

		await expectAllowed(
			await createExpenseRequest(invited.member.page, baseCategoryId, {
				description: 'Member Deletable Expense'
			}),
			'member creates another pending expense'
		);
		const memberDeletableExpenseId = await expenseId(owner.page, 'Member Deletable Expense');
		await expectDenied(
			await deleteExpenseRequest(invited.viewer.page, memberDeletableExpenseId),
			'viewer cannot delete pending expense'
		);
		await expectAllowed(
			await deleteExpenseRequest(invited.member.page, memberDeletableExpenseId),
			'member deletes pending expense'
		);

		await expectAllowed(
			await createRecurringRequest(owner.page, baseCategoryId, 'Owner Recurrence'),
			'owner creates recurrence'
		);
		const ownerRecurringId = await recurringId(owner.page, 'Owner Recurrence');
		await expectAllowed(
			await createRecurringRequest(invited.member.page, baseCategoryId, 'Member Recurrence'),
			'member creates recurrence'
		);
		await expectDenied(
			await createRecurringRequest(invited.viewer.page, baseCategoryId, 'Viewer Recurrence'),
			'viewer cannot create recurrence'
		);
		await expectAllowed(
			await setRecurringStatusRequest(invited.member.page, 'pauseRecurring', ownerRecurringId),
			'member pauses recurrence'
		);
		await expectDenied(
			await setRecurringStatusRequest(invited.viewer.page, 'resumeRecurring', ownerRecurringId),
			'viewer cannot resume recurrence'
		);
		await expectAllowed(
			await setRecurringStatusRequest(invited.admin.page, 'resumeRecurring', ownerRecurringId),
			'admin resumes recurrence'
		);
		await expectAllowed(
			await syncRecurringRequest(invited.member.page),
			'member materializes recurrences'
		);
		await expectDenied(
			await syncRecurringRequest(invited.viewer.page),
			'viewer cannot materialize recurrences'
		);

		await expectAllowed(
			await importExpensesRequest(invited.member.page, baseCategoryId, 'Member Imported Expense'),
			'member imports expenses'
		);
		await expectDenied(
			await importExpensesRequest(invited.viewer.page, baseCategoryId, 'Viewer Imported Expense'),
			'viewer cannot import expenses'
		);
		await expectAllowed(
			await stageOfxRequest(invited.admin.page, 'admin-reconciliation'),
			'admin stages OFX reconciliation'
		);
		await expectDenied(
			await stageOfxRequest(invited.member.page, 'member-reconciliation'),
			'member cannot stage OFX reconciliation'
		);
		await expectDenied(
			await stageOfxRequest(invited.viewer.page, 'viewer-reconciliation'),
			'viewer cannot stage OFX reconciliation'
		);
		await invited.member.page.goto('/app/planning');
		const importForm = invited.member.page.locator('form[action="?/importExpenses"]');
		await importForm.locator('select[name="defaultCategoryId"]').selectOption(baseCategoryId);
		await importForm.locator('input[type="file"]').setInputFiles({
			name: 'role-permissions.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from('date,description,amount\n2026-06-22,Member Imported Expense,44.00\n')
		});
		await importForm.getByRole('button', { name: 'Import' }).click();
		await invited.member.page.getByRole('button', { name: 'Confirm selected expenses' }).click();
		await owner.page.goto('/app/expenses?q=Member%20Imported%20Expense');
		await expect(
			owner.page.locator('.expense-table-item').filter({ hasText: 'Member Imported Expense' })
		).toContainText('Pending');
	} finally {
		await closeSessions(sessions);
	}
});
