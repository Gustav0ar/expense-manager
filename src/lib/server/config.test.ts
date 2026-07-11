import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const privateEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);

vi.mock('$app/environment', () => ({
	browser: false,
	building: false,
	dev: false,
	version: 'test'
}));

vi.mock('$env/dynamic/private', () => ({
	env: privateEnv
}));

import { getDatabaseUrl, getPrivateEnv, getPrivateSecret } from './config';

const tempDirs: string[] = [];
const processEnvKeys = [
	'DATABASE_URL',
	'POSTGRES_HOST',
	'POSTGRES_PORT',
	'POSTGRES_DB',
	'POSTGRES_USER',
	'POSTGRES_PASSWORD',
	'POSTGRES_PASSWORD_FILE'
] as const;
const originalProcessEnv = Object.fromEntries(processEnvKeys.map((key) => [key, process.env[key]]));

describe('private server configuration', () => {
	beforeEach(() => {
		for (const key of processEnvKeys) delete process.env[key];
	});

	afterEach(() => {
		for (const key of Object.keys(privateEnv)) delete privateEnv[key];
		for (const key of processEnvKeys) {
			const originalValue = originalProcessEnv[key];
			if (originalValue === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = originalValue;
			}
		}
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it('reads secrets from *_FILE values when direct environment values are absent', () => {
		const secretFile = writeTempSecret('postgres-password', 'secret-from-file\n');
		privateEnv.POSTGRES_PASSWORD_FILE = secretFile;

		expect(getPrivateSecret('POSTGRES_PASSWORD')).toBe('secret-from-file');
	});

	it('prefers *_FILE values over direct compatibility environment values', () => {
		const secretFile = writeTempSecret('postgres-password', 'secret-from-file\n');
		privateEnv.POSTGRES_PASSWORD = 'direct-secret';
		privateEnv.POSTGRES_PASSWORD_FILE = secretFile;

		expect(getPrivateSecret('POSTGRES_PASSWORD')).toBe('secret-from-file');
	});

	it('builds an encoded Postgres URL from split connection settings and a secret file', () => {
		const secretFile = writeTempSecret('postgres-password', 'p@ss word/with:symbols\n');
		privateEnv.POSTGRES_HOST = 'postgres';
		privateEnv.POSTGRES_PORT = '5432';
		privateEnv.POSTGRES_DB = 'expense_manager';
		privateEnv.POSTGRES_USER = 'expense_manager';
		privateEnv.POSTGRES_PASSWORD_FILE = secretFile;

		expect(getDatabaseUrl()).toBe(
			'postgresql://expense_manager:p%40ss%20word%2Fwith%3Asymbols@postgres:5432/expense_manager'
		);
	});

	it('uses direct and process environment values before split database settings', () => {
		privateEnv.DATABASE_URL = 'postgres://direct.example/app';
		expect(getDatabaseUrl()).toBe('postgres://direct.example/app');
		delete privateEnv.DATABASE_URL;
		process.env.DATABASE_URL = 'postgres://process.example/app';
		expect(getPrivateEnv('DATABASE_URL')).toBe('postgres://process.example/app');
		expect(getPrivateSecret('DATABASE_URL')).toBe('postgres://process.example/app');
	});

	it('requires complete split credentials and applies host and port defaults', () => {
		expect(getDatabaseUrl()).toBe('');
		privateEnv.POSTGRES_DB = 'expense_manager';
		expect(getDatabaseUrl()).toBe('');
		privateEnv.POSTGRES_USER = 'expense_manager';
		expect(getDatabaseUrl()).toBe('');
		privateEnv.POSTGRES_PASSWORD = 'password';
		expect(getDatabaseUrl()).toBe(
			'postgresql://expense_manager:password@postgres:5432/expense_manager'
		);
	});

	it('caches empty secret files and falls back to a direct secret', () => {
		const secretFile = writeTempSecret('empty-password', '');
		privateEnv.POSTGRES_PASSWORD_FILE = secretFile;
		privateEnv.POSTGRES_PASSWORD = 'direct-secret';
		expect(getPrivateSecret('POSTGRES_PASSWORD')).toBe('direct-secret');
		expect(getPrivateSecret('POSTGRES_PASSWORD')).toBe('direct-secret');
	});
});

function writeTempSecret(name: string, value: string) {
	const dir = mkdtempSync(join(tmpdir(), 'expense-manager-config-test-'));
	tempDirs.push(dir);
	const file = join(dir, name);
	writeFileSync(file, value);
	return file;
}
