import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundJobCoordinator } from './background-jobs';

describe('BackgroundJobCoordinator', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-09T12:00:00.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('runs immediately in production and follows independent job cadences', async () => {
		const verificationCleanup = vi.fn().mockResolvedValue({ deletedUsers: 0 });
		const recurringScheduler = vi.fn().mockResolvedValue({ processed: 0, created: 0, errors: 0 });
		const budgetAlertScheduler = vi
			.fn()
			.mockResolvedValue({ processed: 0, sent: 0, failed: 0, errors: 0 });
		const emailDeliveryCleanup = vi.fn().mockResolvedValue({ deletedEvents: 0 });
		const coordinator = new BackgroundJobCoordinator({
			verificationCleanup,
			recurringScheduler,
			budgetAlertScheduler,
			emailDeliveryCleanup,
			verificationIntervalMs: 100,
			recurringIntervalMs: 300,
			budgetAlertIntervalMs: 500,
			emailDeliveryCleanupIntervalMs: 700
		});

		coordinator.start(true);
		await coordinator.waitForIdle();
		expect(verificationCleanup).toHaveBeenCalledTimes(1);
		expect(recurringScheduler).toHaveBeenCalledTimes(1);
		expect(budgetAlertScheduler).toHaveBeenCalledTimes(1);
		expect(emailDeliveryCleanup).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(300);
		await coordinator.waitForIdle();
		expect(verificationCleanup).toHaveBeenCalledTimes(4);
		expect(recurringScheduler).toHaveBeenCalledTimes(2);
		expect(budgetAlertScheduler).toHaveBeenCalledTimes(1);
		expect(emailDeliveryCleanup).toHaveBeenCalledTimes(1);
		expect(coordinator.health().status).toBe('ok');
		await coordinator.stop();
	});

	it('does not start a timer outside production but still supports request triggers', async () => {
		const verificationCleanup = vi.fn().mockResolvedValue({ deletedUsers: 0 });
		const recurringScheduler = vi.fn().mockResolvedValue({ skipped: true });
		const coordinator = new BackgroundJobCoordinator({
			verificationCleanup,
			recurringScheduler,
			budgetAlertScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			emailDeliveryCleanup: vi.fn().mockResolvedValue({ skipped: true }),
			verificationIntervalMs: 100,
			recurringIntervalMs: 100
		});

		coordinator.start(false);
		await vi.advanceTimersByTimeAsync(500);
		expect(verificationCleanup).not.toHaveBeenCalled();
		coordinator.trigger();
		await coordinator.waitForIdle();
		expect(verificationCleanup).toHaveBeenCalledOnce();
		expect(coordinator.health().jobs.recurringScheduler).toMatchObject({
			status: 'ok',
			lockSkips: 1,
			lastSucceededAt: null
		});
	});

	it('reports failures as degraded and recovers after a successful run', async () => {
		const logger = { error: vi.fn() };
		const verificationCleanup = vi
			.fn()
			.mockRejectedValueOnce(new Error('cleanup unavailable'))
			.mockResolvedValue({ deletedUsers: 0 });
		const coordinator = new BackgroundJobCoordinator({
			verificationCleanup,
			recurringScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			budgetAlertScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			emailDeliveryCleanup: vi.fn().mockResolvedValue({ skipped: true }),
			verificationIntervalMs: 100,
			recurringIntervalMs: 100,
			logger
		});

		coordinator.start(true);
		await coordinator.waitForIdle();
		expect(coordinator.health()).toMatchObject({
			status: 'degraded',
			jobs: { verificationCleanup: { status: 'degraded', attempts: 1 } }
		});
		expect(logger.error).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(100);
		await coordinator.waitForIdle();
		expect(coordinator.health()).toMatchObject({
			status: 'ok',
			jobs: { verificationCleanup: { status: 'ok', attempts: 2 } }
		});
		await coordinator.stop();
	});

	it('stops its timer and waits for active jobs', async () => {
		const verificationCleanup = vi.fn().mockResolvedValue({ deletedUsers: 0 });
		const recurringScheduler = vi.fn().mockResolvedValue({ skipped: true });
		const budgetAlertScheduler = vi.fn().mockResolvedValue({ skipped: true });
		const emailDeliveryCleanup = vi.fn().mockResolvedValue({ skipped: true });
		const coordinator = new BackgroundJobCoordinator({
			verificationCleanup,
			recurringScheduler,
			budgetAlertScheduler,
			emailDeliveryCleanup,
			verificationIntervalMs: 100,
			recurringIntervalMs: 100
		});
		coordinator.start(true);
		await coordinator.stop();
		await vi.advanceTimersByTimeAsync(500);
		expect(verificationCleanup).toHaveBeenCalledOnce();
		expect(recurringScheduler).toHaveBeenCalledOnce();
		expect(budgetAlertScheduler).toHaveBeenCalledOnce();
		expect(emailDeliveryCleanup).toHaveBeenCalledOnce();
	});
});
