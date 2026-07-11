import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shutdownDeps = vi.hoisted(() => ({
	stopJobs: vi.fn(async () => undefined),
	flushTracing: vi.fn(async () => undefined),
	endClient: vi.fn(async () => undefined),
	endAdvisory: vi.fn(async () => undefined)
}));

vi.mock('$lib/server/background-jobs', () => ({ stopBackgroundJobs: shutdownDeps.stopJobs }));
vi.mock('$lib/server/observability/tracing', () => ({
	shutdownTracing: shutdownDeps.flushTracing
}));
vi.mock('$lib/server/db', () => ({
	client: { end: shutdownDeps.endClient },
	advisoryLockClient: { end: shutdownDeps.endAdvisory }
}));

import { performGracefulShutdown } from './shutdown';

const originalNodeEnv = process.env.NODE_ENV;

describe('performGracefulShutdown', () => {
	beforeEach(() => {
		shutdownDeps.stopJobs.mockResolvedValue(undefined);
		shutdownDeps.flushTracing.mockResolvedValue(undefined);
		shutdownDeps.endClient.mockResolvedValue(undefined);
		shutdownDeps.endAdvisory.mockResolvedValue(undefined);
	});

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('stops background work before flushing telemetry and closing database clients', async () => {
		const order: string[] = [];
		const result = await performGracefulShutdown(
			{
				stopJobs: vi.fn(async () => {
					order.push('jobs');
				}),
				flushTracing: vi.fn(async () => {
					order.push('tracing');
				}),
				closeDatabase: vi.fn(async () => {
					order.push('database');
				})
			},
			1_000
		);

		expect(result).toBe('completed');
		expect(order[0]).toBe('jobs');
		expect(order.slice(1).sort()).toEqual(['database', 'tracing']);
	});

	it('returns a bounded timeout when a shutdown dependency does not settle', async () => {
		const result = await performGracefulShutdown(
			{
				stopJobs: () => new Promise(() => {}),
				flushTracing: vi.fn(),
				closeDatabase: vi.fn()
			},
			10
		);

		expect(result).toBe('timeout');
	});

	it('uses the production dependencies to flush both database pools', async () => {
		await expect(performGracefulShutdown()).resolves.toBe('completed');
		expect(shutdownDeps.stopJobs).toHaveBeenCalledOnce();
		expect(shutdownDeps.flushTracing).toHaveBeenCalledOnce();
		expect(shutdownDeps.endClient).toHaveBeenCalledWith({ timeout: 3 });
		expect(shutdownDeps.endAdvisory).toHaveBeenCalledWith({ timeout: 3 });
	});

	it('registers production signal handlers once and exits cleanly after shutdown', async () => {
		process.env.NODE_ENV = 'production';
		const handlers = new Map<string, () => void>();
		vi.spyOn(process, 'once').mockImplementation(((signal: string, handler: () => void) => {
			handlers.set(signal, handler);
			return process;
		}) as typeof process.once);
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		const { registerGracefulShutdown } = await import('./shutdown');
		registerGracefulShutdown();
		registerGracefulShutdown();
		expect([...handlers.keys()]).toEqual(['SIGTERM', 'SIGINT']);
		handlers.get('SIGTERM')!();
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
		handlers.get('SIGINT')!();
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it('logs a timeout and exits non-zero when signal shutdown exceeds its bound', async () => {
		vi.useFakeTimers();
		vi.resetModules();
		process.env.NODE_ENV = 'production';
		shutdownDeps.stopJobs.mockImplementation(() => new Promise(() => {}));
		const handlers = new Map<string, () => void>();
		vi.spyOn(process, 'once').mockImplementation(((signal: string, handler: () => void) => {
			handlers.set(signal, handler);
			return process;
		}) as typeof process.once);
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { registerGracefulShutdown } = await import('./shutdown');
		registerGracefulShutdown();
		handlers.get('SIGTERM')!();
		await vi.advanceTimersByTimeAsync(8_000);
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
		expect(log).toHaveBeenCalledWith(expect.stringContaining('graceful_shutdown: timed out'));
	});

	it('logs dependency failures and exits non-zero', async () => {
		vi.resetModules();
		process.env.NODE_ENV = 'production';
		shutdownDeps.stopJobs.mockRejectedValue(new Error('jobs failed'));
		const handlers = new Map<string, () => void>();
		vi.spyOn(process, 'once').mockImplementation(((signal: string, handler: () => void) => {
			handlers.set(signal, handler);
			return process;
		}) as typeof process.once);
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
		const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const { registerGracefulShutdown } = await import('./shutdown');
		registerGracefulShutdown();
		handlers.get('SIGINT')!();
		await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
		expect(log).toHaveBeenCalledWith(expect.stringContaining('jobs failed'));
	});
});
