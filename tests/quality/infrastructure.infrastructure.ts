import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import postgres from 'postgres';

async function getFreePort() {
	return new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close(() => reject(new Error('Could not allocate a TCP port.')));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

async function waitForHealthFailure(baseURL: string, child: ChildProcess, logs: string[]) {
	const deadline = Date.now() + 20_000;
	let lastError = '';

	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`Preview exited early with code ${child.exitCode}.\n${logs.join('')}`);
		}

		try {
			const response = await fetch(`${baseURL}/api/health`);
			if (response.status === 503) return response;
			lastError = `Unexpected status ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}

		await delay(250);
	}

	throw new Error(`Timed out waiting for failed health check: ${lastError}\n${logs.join('')}`);
}

async function stopChild(child: ChildProcess) {
	if (child.exitCode !== null) return child.exitCode;
	child.kill('SIGTERM');
	return Promise.race([
		new Promise<number | null>((resolve) => child.once('exit', resolve)),
		delay(10_000).then(() => {
			child.kill('SIGKILL');
			return child.exitCode;
		})
	]);
}

test('reports a real database outage through the health endpoint', async () => {
	const port = await getFreePort();
	const baseURL = `http://127.0.0.1:${port}`;
	const logs: string[] = [];
	const child = spawn('pnpm', ['preview', '--host', '127.0.0.1', '--port', String(port)], {
		cwd: process.cwd(),
		env: {
			...process.env,
			BETTER_AUTH_SECRET: 'infrastructure-test-secret-infrastructure-test',
			DATABASE_URL: 'postgres://expense_manager:wrong@127.0.0.1:1/expense_manager',
			EMAIL_DELIVERY: 'log',
			ORIGIN: baseURL
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});

	child.stdout.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
	child.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString()));

	try {
		const response = await waitForHealthFailure(baseURL, child, logs);
		expect(response.ok).toBe(false);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual(
			expect.objectContaining({
				database: 'error',
				durationMs: expect.any(Number),
				ok: false,
				timestamp: expect.any(String)
			})
		);
	} finally {
		await stopChild(child);
	}
});

test('runs recurring work at production startup with no traffic and a one-connection pool', async () => {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) throw new Error('DATABASE_URL is required for infrastructure tests.');
	const sql = postgres(databaseUrl, { max: 1 });
	const fixtureId = randomUUID();
	const userId = `background-process-${fixtureId}`;
	const email = `${userId}@example.com`;
	const today = new Date().toISOString().slice(0, 10);
	let workspaceId: number | null = null;
	let recurringId: number | null = null;
	let child: ChildProcess | null = null;
	const logs: string[] = [];

	try {
		await sql.begin(async (tx) => {
			await tx`
				insert into "user" (id, name, email, email_verified)
				values (${userId}, 'Background Process', ${email}, true)
			`;
			const [workspaceRow] = await tx<{ id: number }[]>`
				insert into workspace (name, created_by_user_id, currency)
				values (${`Background ${fixtureId}`}, ${userId}, 'USD')
				returning id
			`;
			workspaceId = Number(workspaceRow.id);
			await tx`
				insert into workspace_member (workspace_id, user_id, role, status)
				values (${workspaceId}, ${userId}, 'owner', 'active')
			`;
			const [categoryRow] = await tx<{ id: number }[]>`
				insert into category (workspace_id, name, color, icon)
				values (${workspaceId}, ${`Background ${fixtureId}`}, '#2563eb', '⏱️')
				returning id
			`;
			const [recurringRow] = await tx<{ id: number }[]>`
				insert into recurring_expense (
					workspace_id, category_id, created_by_user_id, description,
					amount_cents, currency, frequency, interval_count, start_date, next_run_date
				)
				values (
					${workspaceId}, ${Number(categoryRow.id)}, ${userId}, ${`Startup ${fixtureId}`},
					1000, 'USD', 'monthly', 1, ${today}, ${today}
				)
				returning id
			`;
			recurringId = Number(recurringRow.id);
		});

		const port = await getFreePort();
		const baseURL = `http://127.0.0.1:${port}`;
		child = spawn('node', ['build'], {
			cwd: process.cwd(),
			env: {
				...process.env,
				NODE_ENV: 'production',
				HOST: '127.0.0.1',
				PORT: String(port),
				ORIGIN: baseURL,
				DATABASE_URL: databaseUrl,
				DB_POOL_MAX: '1',
				BETTER_AUTH_SECRET: 'infrastructure-test-secret-infrastructure-test',
				EMAIL_DELIVERY: 'log',
				TRUST_PROXY_HEADERS: 'false',
				TRUSTED_PROXY_CIDR: ''
			},
			stdio: ['ignore', 'pipe', 'pipe']
		});
		child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
		child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));

		const deadline = Date.now() + 20_000;
		let materialized = false;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) {
				throw new Error(
					`Production process exited early with code ${child.exitCode}.\n${logs.join('')}`
				);
			}
			const rows = await sql<{ id: number }[]>`
				select id from expense
				where source_recurring_expense_id = ${recurringId}
				limit 1
			`;
			if (rows.length > 0) {
				materialized = true;
				break;
			}
			await delay(100);
		}
		expect(materialized, logs.join('')).toBe(true);

		const health = await fetch(`${baseURL}/api/health`);
		expect(health.ok).toBe(true);
		expect(await health.json()).toEqual(
			expect.objectContaining({
				ok: true,
				backgroundJobs: expect.objectContaining({
					status: 'ok',
					jobs: expect.objectContaining({
						recurringScheduler: expect.objectContaining({ attempts: 1 })
					})
				})
			})
		);

		const exitCode = await stopChild(child);
		expect(exitCode, logs.join('')).toBe(0);
		child = null;
	} finally {
		if (child) await stopChild(child);
		if (workspaceId != null) await sql`delete from workspace where id = ${workspaceId}`;
		await sql`delete from "user" where id = ${userId}`;
		await sql.end({ timeout: 3 });
	}
});
