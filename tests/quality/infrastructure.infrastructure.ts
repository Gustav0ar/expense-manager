import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

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
		child.kill('SIGTERM');
		await Promise.race([
			new Promise((resolve) => child.once('exit', resolve)),
			delay(5_000).then(() => child.kill('SIGKILL'))
		]);
	}
});
