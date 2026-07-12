import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const databasePrefix = 'expense_manager_pw_';
const safeDatabasePattern = /^expense_manager_pw_[a-z0-9_]{1,12}_[0-9]+_[a-z0-9]+_[a-f0-9]{8}$/;

export type PlaywrightDatabaseDescriptor = {
	baseUrl: string;
	databaseName: string;
	databaseUrl: string;
};

type NameEntropy = {
	pid?: number;
	now?: number;
	randomHex?: string;
};

export function createPlaywrightDatabaseDescriptor(
	suite: string,
	baseUrl: string,
	entropy: NameEntropy = {}
): PlaywrightDatabaseDescriptor {
	const parsedBase = parsePostgresUrl(baseUrl, 'Playwright base database');
	const suiteSlug = suite
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 12);
	if (!suiteSlug) throw new Error('Playwright database suite name is invalid.');
	const pid = entropy.pid ?? process.pid;
	const now = (entropy.now ?? Date.now()).toString(36);
	const randomHex = entropy.randomHex ?? randomBytes(4).toString('hex');
	if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[a-f0-9]{8}$/.test(randomHex))
		throw new Error('Playwright database entropy is invalid.');
	const databaseName = `${databasePrefix}${suiteSlug}_${pid}_${now}_${randomHex}`;
	if (databaseName.length > 63 || !safeDatabasePattern.test(databaseName))
		throw new Error('Generated Playwright database name is unsafe.');

	const databaseUrl = new URL(parsedBase);
	databaseUrl.pathname = `/${databaseName}`;
	databaseUrl.search = '';
	databaseUrl.hash = '';
	const descriptor = { baseUrl: parsedBase, databaseName, databaseUrl: databaseUrl.toString() };
	assertSafePlaywrightDatabase(descriptor);
	return descriptor;
}

export function descriptorFromEnvironment(): PlaywrightDatabaseDescriptor {
	const baseUrl = process.env.PLAYWRIGHT_BASE_DATABASE_URL;
	const databaseName = process.env.PLAYWRIGHT_DATABASE_NAME;
	const databaseUrl = process.env.DATABASE_URL;
	if (!baseUrl || !databaseName || !databaseUrl)
		throw new Error('Playwright isolated database environment is incomplete.');
	const descriptor = { baseUrl, databaseName, databaseUrl };
	assertSafePlaywrightDatabase(descriptor);
	return descriptor;
}

export function assertSafePlaywrightDatabase(descriptor: PlaywrightDatabaseDescriptor) {
	const baseUrl = new URL(parsePostgresUrl(descriptor.baseUrl, 'Playwright base database'));
	const databaseUrl = new URL(
		parsePostgresUrl(descriptor.databaseUrl, 'Playwright isolated database')
	);
	const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
	const baseName = decodeURIComponent(baseUrl.pathname.slice(1));
	if (
		descriptor.databaseName !== databaseName ||
		!safeDatabasePattern.test(databaseName) ||
		!databaseName.startsWith(databasePrefix) ||
		databaseName === baseName ||
		baseUrl.protocol !== databaseUrl.protocol ||
		baseUrl.hostname !== databaseUrl.hostname ||
		baseUrl.port !== databaseUrl.port ||
		baseUrl.username !== databaseUrl.username
	)
		throw new Error('Refusing unsafe Playwright database operation.');
}

export async function createPlaywrightDatabase(descriptor: PlaywrightDatabaseDescriptor) {
	assertSafePlaywrightDatabase(descriptor);
	const admin = postgres(maintenanceUrl(descriptor.baseUrl), {
		max: 1,
		prepare: false,
		onnotice: () => undefined
	});
	try {
		await admin.unsafe(`create database "${descriptor.databaseName}"`);
	} catch (databaseError) {
		throw new Error(
			'Unable to create the isolated Playwright database. The configured PostgreSQL role must have CREATEDB permission.',
			{ cause: databaseError }
		);
	} finally {
		await admin.end({ timeout: 3 });
	}
}

export async function migratePlaywrightDatabase(descriptor: PlaywrightDatabaseDescriptor) {
	assertSafePlaywrightDatabase(descriptor);
	const client = postgres(descriptor.databaseUrl, {
		max: 1,
		prepare: false,
		onnotice: () => undefined
	});
	try {
		await migrate(drizzle(client), { migrationsFolder: resolve(process.cwd(), 'drizzle') });
	} finally {
		await client.end({ timeout: 3 });
	}
}

export async function dropPlaywrightDatabase(descriptor: PlaywrightDatabaseDescriptor) {
	assertSafePlaywrightDatabase(descriptor);
	const admin = postgres(maintenanceUrl(descriptor.baseUrl), {
		max: 1,
		prepare: false,
		onnotice: () => undefined
	});
	try {
		await admin`
			select pg_terminate_backend(pid)
			from pg_stat_activity
			where datname = ${descriptor.databaseName}
				and pid <> pg_backend_pid()
		`;
		await admin.unsafe(`drop database if exists "${descriptor.databaseName}"`);
	} finally {
		await admin.end({ timeout: 3 });
	}
}

export async function playwrightDatabaseExists(descriptor: PlaywrightDatabaseDescriptor) {
	assertSafePlaywrightDatabase(descriptor);
	const admin = postgres(maintenanceUrl(descriptor.baseUrl), { max: 1, prepare: false });
	try {
		const [row] = await admin<{ exists: boolean }[]>`
			select exists(select 1 from pg_database where datname = ${descriptor.databaseName}) as exists
		`;
		return row?.exists ?? false;
	} finally {
		await admin.end({ timeout: 3 });
	}
}

function maintenanceUrl(value: string) {
	const url = new URL(parsePostgresUrl(value, 'Playwright base database'));
	url.pathname = '/postgres';
	url.search = '';
	url.hash = '';
	return url.toString();
}

function parsePostgresUrl(value: string, label: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} URL is invalid.`);
	}
	if (
		!['postgres:', 'postgresql:'].includes(url.protocol) ||
		!url.hostname ||
		!url.pathname.slice(1)
	)
		throw new Error(`${label} URL is invalid.`);
	return url.toString();
}
