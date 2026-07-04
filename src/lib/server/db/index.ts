import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { getDatabaseUrl, getPrivateEnv } from '$lib/server/config';

const databaseUrl = getDatabaseUrl();

if (!databaseUrl) {
	throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure it.');
}

const maxConnections = Number.parseInt(getPrivateEnv('DB_POOL_MAX') || '5', 10);

const client = postgres(databaseUrl, {
	max: Number.isFinite(maxConnections) ? maxConnections : 5,
	idle_timeout: 20,
	connect_timeout: 10,
	prepare: getPrivateEnv('DB_PREPARE_STATEMENTS') === 'false' ? false : true
});

export const db = drizzle(client, { schema });
