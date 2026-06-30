import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { env } from '$env/dynamic/private';
import { building } from '$app/environment';

const databaseUrl =
	env.DATABASE_URL || (building ? 'postgres://postgres:postgres@localhost:5432/app' : '');

if (!databaseUrl) {
	throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure it.');
}

const maxConnections = Number.parseInt(env.DB_POOL_MAX || '5', 10);

const client = postgres(databaseUrl, {
	max: Number.isFinite(maxConnections) ? maxConnections : 5,
	idle_timeout: 20,
	connect_timeout: 10,
	prepare: env.DB_PREPARE_STATEMENTS === 'false' ? false : true
});

export const db = drizzle(client, { schema });
