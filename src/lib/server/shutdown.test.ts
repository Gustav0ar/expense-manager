import { describe, expect, it, vi } from 'vitest';
import { performGracefulShutdown } from './shutdown';

describe('performGracefulShutdown', () => {
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
});
