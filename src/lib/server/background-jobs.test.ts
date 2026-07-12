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
		const invitationDeliveryScheduler = vi
			.fn()
			.mockResolvedValue({ processed: 0, sent: 0, failed: 0 });
		const attachmentDeletionScheduler = vi
			.fn()
			.mockResolvedValue({ processed: 0, completed: 0, pending: 0, failed: 0 });
		const attachmentReconciliation = vi.fn().mockResolvedValue({ failed: 0, reconciliation: null });
		const coordinator = new BackgroundJobCoordinator({
			verificationCleanup,
			recurringScheduler,
			budgetAlertScheduler,
			invitationDeliveryScheduler,
			attachmentReconciliation,
			attachmentDeletionScheduler,
			expenseTrashPurgeScheduler: vi.fn().mockResolvedValue({}),
			importPreviewCleanup: vi.fn().mockResolvedValue({ deletedPreviews: 0 }),
			emailDeliveryCleanup,
			verificationIntervalMs: 100,
			recurringIntervalMs: 300,
			budgetAlertIntervalMs: 500,
			invitationDeliveryIntervalMs: 100,
			emailDeliveryCleanupIntervalMs: 700
		});

		coordinator.start(true);
		await coordinator.waitForIdle();
		expect(verificationCleanup).toHaveBeenCalledTimes(1);
		expect(recurringScheduler).toHaveBeenCalledTimes(1);
		expect(budgetAlertScheduler).toHaveBeenCalledTimes(1);
		expect(emailDeliveryCleanup).toHaveBeenCalledTimes(1);
		expect(invitationDeliveryScheduler).toHaveBeenCalledTimes(1);
		expect(attachmentReconciliation).toHaveBeenCalledTimes(1);
		expect(attachmentDeletionScheduler).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(300);
		await coordinator.waitForIdle();
		expect(verificationCleanup).toHaveBeenCalledTimes(4);
		expect(recurringScheduler).toHaveBeenCalledTimes(2);
		expect(budgetAlertScheduler).toHaveBeenCalledTimes(1);
		expect(emailDeliveryCleanup).toHaveBeenCalledTimes(1);
		expect(invitationDeliveryScheduler).toHaveBeenCalledTimes(4);
		expect(attachmentDeletionScheduler).toHaveBeenCalledTimes(1);
		expect(coordinator.health().status).toBe('ok');
		expect(coordinator.health(new Date('2026-07-09T12:00:03.000Z').getTime()).status).toBe(
			'degraded'
		);
		await coordinator.stop();
	});

	it('does not start a timer outside production but still supports request triggers', async () => {
		const verificationCleanup = vi.fn().mockResolvedValue({ deletedUsers: 0 });
		const recurringScheduler = vi.fn().mockResolvedValue({ skipped: true });
		const coordinator = new BackgroundJobCoordinator({
			verificationCleanup,
			recurringScheduler,
			budgetAlertScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			invitationDeliveryScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			attachmentReconciliation: vi.fn().mockResolvedValue({ skipped: true }),
			attachmentDeletionScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			expenseTrashPurgeScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			importPreviewCleanup: vi.fn().mockResolvedValue({ skipped: true }),
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
			invitationDeliveryScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			attachmentReconciliation: vi.fn().mockResolvedValue({ skipped: true }),
			attachmentDeletionScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			expenseTrashPurgeScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			importPreviewCleanup: vi.fn().mockResolvedValue({ skipped: true }),
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
		const invitationDeliveryScheduler = vi.fn().mockResolvedValue({ skipped: true });
		const attachmentDeletionScheduler = vi.fn().mockResolvedValue({ skipped: true });
		const attachmentReconciliation = vi.fn().mockResolvedValue({ skipped: true });
		const coordinator = new BackgroundJobCoordinator({
			verificationCleanup,
			recurringScheduler,
			budgetAlertScheduler,
			invitationDeliveryScheduler,
			attachmentReconciliation,
			attachmentDeletionScheduler,
			expenseTrashPurgeScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			importPreviewCleanup: vi.fn().mockResolvedValue({ skipped: true }),
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
		expect(invitationDeliveryScheduler).toHaveBeenCalledOnce();
		expect(attachmentReconciliation).toHaveBeenCalledOnce();
		expect(attachmentDeletionScheduler).toHaveBeenCalledOnce();
	});

	it('surfaces durable delivery failures and clears the degraded result on retry', async () => {
		const invitationDeliveryScheduler = vi
			.fn()
			.mockResolvedValueOnce({ processed: 1, sent: 0, failed: 1 })
			.mockResolvedValueOnce({ processed: 1, sent: 1, failed: 0 });
		const coordinator = new BackgroundJobCoordinator({
			verificationCleanup: vi.fn().mockResolvedValue({ deletedUsers: 0 }),
			recurringScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			budgetAlertScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			invitationDeliveryScheduler,
			attachmentReconciliation: vi.fn().mockResolvedValue({ skipped: true }),
			attachmentDeletionScheduler: vi
				.fn()
				.mockResolvedValue({ processed: 0, completed: 0, pending: 2, failed: 0 }),
			expenseTrashPurgeScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			importPreviewCleanup: vi.fn().mockResolvedValue({ skipped: true }),
			emailDeliveryCleanup: vi.fn().mockResolvedValue({ skipped: true }),
			invitationDeliveryIntervalMs: 100
		});

		coordinator.start(true);
		await coordinator.waitForIdle();
		expect(coordinator.health().jobs.invitationDeliveryScheduler).toMatchObject({
			status: 'degraded',
			attempts: 1,
			failures: 1,
			lastFailedCount: 1
		});

		await vi.advanceTimersByTimeAsync(100);
		await coordinator.waitForIdle();
		expect(coordinator.health().jobs.invitationDeliveryScheduler).toMatchObject({
			status: 'ok',
			attempts: 2,
			failures: 1,
			lastFailedCount: 0
		});
		await coordinator.stop();
	});

	it('surfaces scheduler workspace errors instead of reporting a successful cycle', async () => {
		const recurringScheduler = vi
			.fn()
			.mockResolvedValueOnce({ processed: 2, created: 1, errors: 1 })
			.mockResolvedValueOnce({ processed: 1, created: 1, errors: 0 });
		const coordinator = new BackgroundJobCoordinator({
			verificationCleanup: vi.fn().mockResolvedValue({ deletedUsers: 0 }),
			recurringScheduler,
			budgetAlertScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			invitationDeliveryScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			attachmentReconciliation: vi.fn().mockResolvedValue({ skipped: true }),
			attachmentDeletionScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			expenseTrashPurgeScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			importPreviewCleanup: vi.fn().mockResolvedValue({ skipped: true }),
			emailDeliveryCleanup: vi.fn().mockResolvedValue({ skipped: true }),
			recurringIntervalMs: 100
		});

		coordinator.start(true);
		await coordinator.waitForIdle();
		expect(coordinator.health().jobs.recurringScheduler).toMatchObject({
			status: 'degraded',
			failures: 1,
			lastFailedCount: 1
		});

		await vi.advanceTimersByTimeAsync(100);
		await coordinator.waitForIdle();
		expect(coordinator.health().jobs.recurringScheduler).toMatchObject({
			status: 'ok',
			failures: 1,
			lastFailedCount: 0
		});
		await coordinator.stop();
	});

	it('exposes separate attachment queue and reconciliation health without storage paths', async () => {
		const coordinator = new BackgroundJobCoordinator({
			verificationCleanup: vi.fn().mockResolvedValue({ deletedUsers: 0 }),
			recurringScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			budgetAlertScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			invitationDeliveryScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			attachmentReconciliation: vi.fn().mockResolvedValue({
				failed: 1,
				reconciliation: {
					missingActive: 1,
					missingRetained: 0,
					unknownDisk: 2,
					scanFailed: false
				}
			}),
			emailDeliveryCleanup: vi.fn().mockResolvedValue({ skipped: true }),
			attachmentDeletionScheduler: vi.fn().mockResolvedValue({
				processed: 0,
				completed: 0,
				pending: 3,
				failed: 1
			}),
			expenseTrashPurgeScheduler: vi.fn().mockResolvedValue({ skipped: true }),
			importPreviewCleanup: vi.fn().mockResolvedValue({ skipped: true })
		});

		coordinator.trigger();
		await coordinator.waitForIdle();
		const deletionHealth = coordinator.health().jobs.attachmentDeletionScheduler;
		expect(deletionHealth).toMatchObject({
			status: 'degraded',
			lastPendingCount: 3,
			lastFailedCount: 1
		});
		const reconciliationHealth = coordinator.health().jobs.attachmentReconciliation;
		expect(reconciliationHealth).toMatchObject({
			status: 'degraded',
			lastFailedCount: 1,
			lastMissingActiveCount: 1,
			lastMissingRetainedCount: 0,
			lastUnknownDiskCount: 2,
			lastStorageScanFailed: false
		});
		expect(JSON.stringify(reconciliationHealth)).not.toContain('storageKey');
		expect(JSON.stringify(reconciliationHealth)).not.toContain('/');
	});
});
