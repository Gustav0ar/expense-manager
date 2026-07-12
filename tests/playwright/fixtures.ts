import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';

export const testPassword = ['test', 'password', '123'].join('-');

export type E2ELocale = 'en-US' | 'pt-BR';

type RegistrationInput = {
	email: string;
	name: string;
	password?: string;
};

type RegistrationOptions = {
	beforeSubmit?: (page: Page) => Promise<void>;
	locale?: E2ELocale;
	path?: string;
	retries?: number;
};

type WorkspaceOptions = {
	currency?: string;
	locale?: E2ELocale;
	name: string;
};

type AccountWorkspaceOptions = {
	currency?: string;
	email?: string;
	emailPrefix: string;
	locale?: E2ELocale;
	password?: string;
	registrationPath?: string;
	userName: string;
	workspaceName: string;
};

const labels = {
	'en-US': {
		createAccount: 'Create account',
		createWorkspace: 'Create workspace',
		currency: 'Currency',
		name: 'Name'
	},
	'pt-BR': {
		createAccount: 'Criar conta',
		createWorkspace: 'Criar workspace',
		currency: 'Moeda',
		name: 'Nome'
	}
} satisfies Record<E2ELocale, Record<string, string>>;

export function uniqueEmail(prefix: string) {
	const normalizedPrefix = prefix
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, '-')
		.replace(/-+/g, '-');
	return `${normalizedPrefix}-${randomUUID()}@example.com`;
}

export async function fillRegistrationForm(form: Locator, input: RegistrationInput) {
	const password = input.password ?? testPassword;
	const fields = {
		email: form.locator('input[name="email"]'),
		name: form.locator('input[name="name"]'),
		password: form.locator('input[name="password"]'),
		passwordConfirmation: form.locator('input[name="passwordConfirmation"]')
	};

	for (let attempt = 0; attempt < 3; attempt += 1) {
		await fields.name.fill(input.name);
		await fields.email.fill(input.email);
		await fields.password.fill(password);
		await fields.passwordConfirmation.fill(password);

		try {
			await expect(fields.name).toHaveValue(input.name, { timeout: 1000 });
			await expect(fields.email).toHaveValue(input.email, { timeout: 1000 });
			await expect(fields.password).toHaveValue(password, { timeout: 1000 });
			await expect(fields.passwordConfirmation).toHaveValue(password, { timeout: 1000 });
			return;
		} catch (error) {
			if (attempt === 2) throw error;
		}
	}
}

export async function registerAccount(
	page: Page,
	input: RegistrationInput,
	options: RegistrationOptions = {}
) {
	const locale = options.locale ?? 'en-US';
	const path = options.path ?? '/register';
	const retries = options.retries ?? 3;
	const buttonName = labels[locale].createAccount;

	for (let attempt = 0; attempt < retries; attempt += 1) {
		await page.goto(path);
		const form = page.locator('form').filter({
			has: page.getByRole('button', { name: buttonName })
		});
		await expect(form.getByRole('button', { name: buttonName })).toBeVisible();
		await options.beforeSubmit?.(page);
		await fillRegistrationForm(form, input);
		await form.getByRole('button', { name: buttonName }).click();

		try {
			await expect(page).not.toHaveURL(/\/register(?:\?|$)/, { timeout: 5000 });
			return;
		} catch (error) {
			if (attempt === retries - 1) throw error;
		}
	}
}

export async function createWorkspace(page: Page, options: WorkspaceOptions) {
	const locale = options.locale ?? 'en-US';
	await expect(page).toHaveURL(/\/app\/onboarding/);
	await page.getByLabel(labels[locale].name).fill(options.name);
	if (options.currency) {
		await page.getByLabel(labels[locale].currency).fill(options.currency);
	}
	await page.getByRole('button', { name: labels[locale].createWorkspace }).click();
	await expect(page).toHaveURL(/\/app\/dashboard/);
}

export async function registerAndCreateWorkspace(page: Page, options: AccountWorkspaceOptions) {
	const email = options.email ?? uniqueEmail(options.emailPrefix);
	const locale = options.locale ?? 'en-US';
	await registerAccount(
		page,
		{ email, name: options.userName, password: options.password },
		{ locale, path: options.registrationPath }
	);
	await createWorkspace(page, {
		currency: options.currency,
		locale,
		name: options.workspaceName
	});
	return { email, workspaceName: options.workspaceName };
}
