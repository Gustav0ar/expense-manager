import { afterEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import {
	assertSafePlaywrightDatabase,
	createPlaywrightDatabase,
	createPlaywrightDatabaseDescriptor,
	dropPlaywrightDatabase,
	playwrightDatabaseExists,
	type PlaywrightDatabaseDescriptor
} from './database';
import { configurePlaywrightDatabase } from './config';

const created: PlaywrightDatabaseDescriptor[] = [];

describe.sequential('Playwright isolated databases', () => {
	afterEach(async () => {
		await Promise.all(created.splice(0).map((descriptor) => dropPlaywrightDatabase(descriptor)));
	});

	it('generates unique, bounded names without changing connection authority', () => {
		const baseUrl = requiredDatabaseUrl();
		const first = createPlaywrightDatabaseDescriptor('email-verification', baseUrl, {
			pid: 123,
			now: 1_700_000_000_000,
			randomHex: '1234abcd'
		});
		const second = createPlaywrightDatabaseDescriptor('email-verification', baseUrl, {
			pid: 123,
			now: 1_700_000_000_000,
			randomHex: '5678abcd'
		});
		expect(first.databaseName).not.toBe(second.databaseName);
		expect(first.databaseName.length).toBeLessThanOrEqual(63);
		expect(new URL(first.databaseUrl).host).toBe(new URL(baseUrl).host);
		expect(new URL(first.databaseUrl).username).toBe(new URL(baseUrl).username);
	});

	it('reuses one descriptor when Playwright evaluates its config more than once', () => {
		const original = {
			baseUrl: process.env.PLAYWRIGHT_BASE_DATABASE_URL,
			databaseName: process.env.PLAYWRIGHT_DATABASE_NAME,
			databaseUrl: process.env.DATABASE_URL
		};
		try {
			delete process.env.PLAYWRIGHT_BASE_DATABASE_URL;
			delete process.env.PLAYWRIGHT_DATABASE_NAME;
			process.env.DATABASE_URL = original.databaseUrl;

			const first = configurePlaywrightDatabase('reload');
			const databaseName = process.env.PLAYWRIGHT_DATABASE_NAME;
			const second = configurePlaywrightDatabase('reload');

			expect(databaseName).toBeTruthy();
			expect(second.databaseUrl).toBe(first.databaseUrl);
			expect(process.env.PLAYWRIGHT_DATABASE_NAME).toBe(databaseName);
		} finally {
			setOptionalEnvironment('PLAYWRIGHT_BASE_DATABASE_URL', original.baseUrl);
			setOptionalEnvironment('PLAYWRIGHT_DATABASE_NAME', original.databaseName);
			setOptionalEnvironment('DATABASE_URL', original.databaseUrl);
		}
	});

	it('rejects development, production and mismatched drop targets', () => {
		const baseUrl = requiredDatabaseUrl();
		for (const databaseName of ['expense_manager', 'postgres', 'production']) {
			const target = new URL(baseUrl);
			target.pathname = `/${databaseName}`;
			expect(() =>
				assertSafePlaywrightDatabase({ baseUrl, databaseName, databaseUrl: target.toString() })
			).toThrow('Refusing unsafe Playwright database operation.');
		}
		const safe = createPlaywrightDatabaseDescriptor('safety', baseUrl);
		const otherHost = new URL(safe.databaseUrl);
		otherHost.hostname = 'example.invalid';
		expect(() =>
			assertSafePlaywrightDatabase({ ...safe, databaseUrl: otherHost.toString() })
		).toThrow('Refusing unsafe Playwright database operation.');
	});

	it('creates and drops concurrent suite databases with the configured CI role', async () => {
		const baseUrl = requiredDatabaseUrl();
		const descriptors = [
			createPlaywrightDatabaseDescriptor('concurrent_a', baseUrl),
			createPlaywrightDatabaseDescriptor('concurrent_b', baseUrl)
		];
		created.push(...descriptors);
		await Promise.all(descriptors.map((descriptor) => createPlaywrightDatabase(descriptor)));
		await expect(
			Promise.all(descriptors.map((descriptor) => playwrightDatabaseExists(descriptor)))
		).resolves.toEqual([true, true]);
		await Promise.all(descriptors.map((descriptor) => dropPlaywrightDatabase(descriptor)));
		created.length = 0;
		await expect(
			Promise.all(
				descriptors.map((descriptor) => databaseExistsUnsafe(baseUrl, descriptor.databaseName))
			)
		).resolves.toEqual([false, false]);
	});
});

function setOptionalEnvironment(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function requiredDatabaseUrl() {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error('DATABASE_URL is required for Playwright database tests.');
	return databaseUrl;
}

async function databaseExistsUnsafe(baseUrl: string, databaseName: string) {
	const maintenance = new URL(baseUrl);
	maintenance.pathname = '/postgres';
	const client = postgres(maintenance.toString(), { max: 1, prepare: false });
	try {
		const [row] = await client<{ exists: boolean }[]>`
			select exists(select 1 from pg_database where datname = ${databaseName}) as exists
		`;
		return row?.exists ?? false;
	} finally {
		await client.end({ timeout: 3 });
	}
}
