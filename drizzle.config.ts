import { defineConfig } from 'drizzle-kit';
import { readFileSync } from 'node:fs';

const databaseUrl = getDatabaseUrl();

if (!databaseUrl) throw new Error('DATABASE_URL is not set');

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	dialect: 'postgresql',
	dbCredentials: { url: databaseUrl },
	verbose: true,
	strict: true
});

function getDatabaseUrl() {
	const explicitUrl = getSecret('DATABASE_URL');
	if (explicitUrl) return explicitUrl;

	const host = process.env.POSTGRES_HOST || 'postgres';
	const port = process.env.POSTGRES_PORT || '5432';
	const database = process.env.POSTGRES_DB;
	const user = process.env.POSTGRES_USER;
	const password = getSecret('POSTGRES_PASSWORD');

	if (!database || !user || !password) return '';

	const url = new URL(`postgresql://${host}:${port}/${database}`);
	url.username = user;
	url.password = password;
	return url.toString();
}

function getSecret(key: string) {
	const directValue = process.env[key];
	if (directValue) return directValue;

	const filePath = process.env[`${key}_FILE`];
	if (!filePath) return undefined;

	return readFileSync(filePath, 'utf8').replace(/\r?\n$/, '') || undefined;
}
