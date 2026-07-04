import { env } from '$env/dynamic/private';
import { building } from '$app/environment';
import { readFileSync } from 'node:fs';

const secretFileCache = new Map<string, string | undefined>();

export function getPrivateEnv(key: string) {
	return env[key] ?? process.env[key];
}

export function getPrivateSecret(key: string) {
	const fileValue = readSecretFile(key);
	if (fileValue) return fileValue;

	const directValue = getPrivateEnv(key);
	if (directValue) return directValue;
	return undefined;
}

export function getDatabaseUrl() {
	const explicitUrl = getPrivateSecret('DATABASE_URL');
	if (explicitUrl) return explicitUrl;
	if (building) return 'postgres://postgres:postgres@localhost:5432/app';

	const host = getPrivateEnv('POSTGRES_HOST') || 'postgres';
	const port = getPrivateEnv('POSTGRES_PORT') || '5432';
	const database = getPrivateEnv('POSTGRES_DB');
	const user = getPrivateEnv('POSTGRES_USER');
	const password = getPrivateSecret('POSTGRES_PASSWORD');

	if (!database || !user || !password) return '';

	const url = new URL(`postgresql://${host}:${port}/${database}`);
	url.username = user;
	url.password = password;
	return url.toString();
}

function readSecretFile(key: string) {
	const fileEnvKey = `${key}_FILE`;
	const filePath = getPrivateEnv(fileEnvKey);
	if (!filePath) return undefined;

	if (secretFileCache.has(filePath)) {
		return secretFileCache.get(filePath);
	}

	const value = readFileSync(filePath, 'utf8').replace(/\r?\n$/, '');
	secretFileCache.set(filePath, value || undefined);
	return value || undefined;
}
