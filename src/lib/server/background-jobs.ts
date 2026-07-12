import { pruneExpiredUnverifiedRegistrations } from '$lib/server/services/email-verification';
import { runRecurringExpenseScheduler } from '$lib/server/services/recurring';
import { runAutomaticBudgetAlertScheduler } from '$lib/server/services/budgets';
import { pruneEmailDeliveryEvents } from '$lib/server/services/email-delivery-events';
import { runInvitationDeliveryScheduler } from '$lib/server/services/invitation-delivery';
import { runAttachmentDeletionWorker } from '$lib/server/services/attachment-deletion';
import { runExpenseTrashPurgeWorker } from '$lib/server/services/expense-trash';
import { pruneExpiredImportPreviews } from '$lib/server/services/imports';

export const verificationCleanupIntervalMs = 60_000;
export const recurringSchedulerIntervalMs = 5 * 60 * 1000;
export const budgetAlertSchedulerIntervalMs = 60 * 60 * 1000;
export const emailDeliveryCleanupIntervalMs = 24 * 60 * 60 * 1000;
export const invitationDeliverySchedulerIntervalMs = 60_000;
export const attachmentDeletionSchedulerIntervalMs = 5 * 60 * 1000;
export const expenseTrashPurgeSchedulerIntervalMs = 5 * 60 * 1000;
export const importPreviewCleanupIntervalMs = 60 * 60 * 1000;

type BackgroundJobName =
	| 'verificationCleanup'
	| 'recurringScheduler'
	| 'budgetAlertScheduler'
	| 'invitationDeliveryScheduler'
	| 'attachmentDeletionScheduler'
	| 'expenseTrashPurgeScheduler'
	| 'importPreviewCleanup'
	| 'emailDeliveryCleanup';
type BackgroundJobResult = {
	skipped?: boolean;
	failed?: number;
	errors?: number;
	pending?: number;
	reconciliation?: {
		missingActive: number;
		missingRetained: number;
		unknownDisk: number;
		scanFailed: boolean;
	} | null;
} | void;
type BackgroundJobRunner = () => Promise<BackgroundJobResult>;

type BackgroundJobState = {
	attempts: number;
	lockSkips: number;
	running: boolean;
	lastAttemptAt: number | null;
	lastCompletedAt: number | null;
	lastSucceededAt: number | null;
	lastErrorAt: number | null;
	lastDurationMs: number | null;
	failures: number;
	lastFailedCount: number;
	lastPendingCount: number;
	lastMissingActiveCount: number;
	lastMissingRetainedCount: number;
	lastUnknownDiskCount: number;
	lastStorageScanFailed: boolean;
};

type TimerHandle = ReturnType<typeof setInterval>;

type BackgroundJobCoordinatorOptions = {
	verificationCleanup?: BackgroundJobRunner;
	recurringScheduler?: BackgroundJobRunner;
	budgetAlertScheduler?: BackgroundJobRunner;
	invitationDeliveryScheduler?: BackgroundJobRunner;
	attachmentDeletionScheduler?: BackgroundJobRunner;
	expenseTrashPurgeScheduler?: BackgroundJobRunner;
	importPreviewCleanup?: BackgroundJobRunner;
	emailDeliveryCleanup?: BackgroundJobRunner;
	verificationIntervalMs?: number;
	recurringIntervalMs?: number;
	budgetAlertIntervalMs?: number;
	invitationDeliveryIntervalMs?: number;
	attachmentDeletionIntervalMs?: number;
	expenseTrashPurgeIntervalMs?: number;
	importPreviewCleanupIntervalMs?: number;
	emailDeliveryCleanupIntervalMs?: number;
	now?: () => number;
	setIntervalFn?: (callback: () => void, intervalMs: number) => TimerHandle;
	clearIntervalFn?: (timer: TimerHandle) => void;
	logger?: Pick<Console, 'error'>;
};

function initialJobState(): BackgroundJobState {
	return {
		attempts: 0,
		lockSkips: 0,
		running: false,
		lastAttemptAt: null,
		lastCompletedAt: null,
		lastSucceededAt: null,
		lastErrorAt: null,
		lastDurationMs: null,
		failures: 0,
		lastFailedCount: 0,
		lastPendingCount: 0,
		lastMissingActiveCount: 0,
		lastMissingRetainedCount: 0,
		lastUnknownDiskCount: 0,
		lastStorageScanFailed: false
	};
}

export class BackgroundJobCoordinator {
	private readonly jobs: Record<BackgroundJobName, BackgroundJobRunner>;
	private readonly intervals: Record<BackgroundJobName, number>;
	private readonly now: () => number;
	private readonly setIntervalFn: (callback: () => void, intervalMs: number) => TimerHandle;
	private readonly clearIntervalFn: (timer: TimerHandle) => void;
	private readonly logger: Pick<Console, 'error'>;
	private readonly states: Record<BackgroundJobName, BackgroundJobState> = {
		verificationCleanup: initialJobState(),
		recurringScheduler: initialJobState(),
		budgetAlertScheduler: initialJobState(),
		invitationDeliveryScheduler: initialJobState(),
		attachmentDeletionScheduler: initialJobState(),
		expenseTrashPurgeScheduler: initialJobState(),
		importPreviewCleanup: initialJobState(),
		emailDeliveryCleanup: initialJobState()
	};
	private readonly nextRunAt: Record<BackgroundJobName, number> = {
		verificationCleanup: 0,
		recurringScheduler: 0,
		budgetAlertScheduler: 0,
		invitationDeliveryScheduler: 0,
		attachmentDeletionScheduler: 0,
		expenseTrashPurgeScheduler: 0,
		importPreviewCleanup: 0,
		emailDeliveryCleanup: 0
	};
	private readonly promises: Partial<Record<BackgroundJobName, Promise<void>>> = {};
	private timer: TimerHandle | null = null;

	constructor(options: BackgroundJobCoordinatorOptions = {}) {
		this.jobs = {
			verificationCleanup: options.verificationCleanup ?? pruneExpiredUnverifiedRegistrations,
			recurringScheduler: options.recurringScheduler ?? runRecurringExpenseScheduler,
			budgetAlertScheduler: options.budgetAlertScheduler ?? runAutomaticBudgetAlertScheduler,
			invitationDeliveryScheduler:
				options.invitationDeliveryScheduler ?? runInvitationDeliveryScheduler,
			attachmentDeletionScheduler:
				options.attachmentDeletionScheduler ?? runAttachmentDeletionWorker,
			expenseTrashPurgeScheduler: options.expenseTrashPurgeScheduler ?? runExpenseTrashPurgeWorker,
			importPreviewCleanup: options.importPreviewCleanup ?? pruneExpiredImportPreviews,
			emailDeliveryCleanup: options.emailDeliveryCleanup ?? pruneEmailDeliveryEvents
		};
		this.intervals = {
			verificationCleanup: options.verificationIntervalMs ?? verificationCleanupIntervalMs,
			recurringScheduler: options.recurringIntervalMs ?? recurringSchedulerIntervalMs,
			budgetAlertScheduler: options.budgetAlertIntervalMs ?? budgetAlertSchedulerIntervalMs,
			invitationDeliveryScheduler:
				options.invitationDeliveryIntervalMs ?? invitationDeliverySchedulerIntervalMs,
			attachmentDeletionScheduler:
				options.attachmentDeletionIntervalMs ?? attachmentDeletionSchedulerIntervalMs,
			expenseTrashPurgeScheduler:
				options.expenseTrashPurgeIntervalMs ?? expenseTrashPurgeSchedulerIntervalMs,
			importPreviewCleanup:
				options.importPreviewCleanupIntervalMs ?? importPreviewCleanupIntervalMs,
			emailDeliveryCleanup: options.emailDeliveryCleanupIntervalMs ?? emailDeliveryCleanupIntervalMs
		};
		this.now = options.now ?? Date.now;
		this.setIntervalFn = options.setIntervalFn ?? setInterval;
		this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
		this.logger = options.logger ?? console;
	}

	start(production = process.env.NODE_ENV === 'production') {
		if (!production || this.timer) return;
		this.trigger();
		this.timer = this.setIntervalFn(
			() => this.trigger(),
			Math.min(...Object.values(this.intervals))
		);
		this.timer.unref?.();
	}

	trigger() {
		this.triggerJob('verificationCleanup');
		this.triggerJob('recurringScheduler');
		this.triggerJob('budgetAlertScheduler');
		this.triggerJob('invitationDeliveryScheduler');
		this.triggerJob('attachmentDeletionScheduler');
		this.triggerJob('expenseTrashPurgeScheduler');
		this.triggerJob('importPreviewCleanup');
		this.triggerJob('emailDeliveryCleanup');
	}

	async stop() {
		if (this.timer) {
			this.clearIntervalFn(this.timer);
			this.timer = null;
		}
		await this.waitForIdle();
	}

	async waitForIdle() {
		await Promise.all(Object.values(this.promises));
	}

	health(now = this.now()) {
		const jobs = {
			verificationCleanup: this.publicJobState('verificationCleanup', now),
			recurringScheduler: this.publicJobState('recurringScheduler', now),
			budgetAlertScheduler: this.publicJobState('budgetAlertScheduler', now),
			invitationDeliveryScheduler: this.publicJobState('invitationDeliveryScheduler', now),
			attachmentDeletionScheduler: this.publicJobState('attachmentDeletionScheduler', now),
			expenseTrashPurgeScheduler: this.publicJobState('expenseTrashPurgeScheduler', now),
			importPreviewCleanup: this.publicJobState('importPreviewCleanup', now),
			emailDeliveryCleanup: this.publicJobState('emailDeliveryCleanup', now)
		};
		const values = Object.values(jobs);
		return {
			status: values.some((job) => job.status === 'degraded')
				? ('degraded' as const)
				: values.some((job) => job.status === 'starting')
					? ('starting' as const)
					: ('ok' as const),
			jobs
		};
	}

	private triggerJob(name: BackgroundJobName) {
		const now = this.now();
		if (this.promises[name] || now < this.nextRunAt[name]) return;

		this.nextRunAt[name] = now + this.intervals[name];
		const state = this.states[name];
		state.attempts++;
		state.running = true;
		state.lastAttemptAt = now;

		this.promises[name] = Promise.resolve()
			.then(() => this.jobs[name]())
			.then((result) => {
				const completedAt = this.now();
				state.lastCompletedAt = completedAt;
				// Some schedulers keep processing other workspaces after an internal
				// workspace failure and report those failures as `errors`. Treat those
				// partial failures exactly like durable failed work for health purposes.
				state.lastFailedCount = (result?.failed ?? 0) + (result?.errors ?? 0);
				state.lastPendingCount = result?.pending ?? 0;
				state.lastMissingActiveCount = result?.reconciliation?.missingActive ?? 0;
				state.lastMissingRetainedCount = result?.reconciliation?.missingRetained ?? 0;
				state.lastUnknownDiskCount = result?.reconciliation?.unknownDisk ?? 0;
				state.lastStorageScanFailed = result?.reconciliation?.scanFailed ?? false;
				state.failures += state.lastFailedCount;
				if (result?.skipped) state.lockSkips++;
				else state.lastSucceededAt = completedAt;
			})
			.catch((error) => {
				state.lastErrorAt = this.now();
				this.logger.error(
					JSON.stringify({
						level: 'error',
						message: `background_job: ${name} failed`,
						error: error instanceof Error ? error.message : String(error)
					})
				);
			})
			.finally(() => {
				state.running = false;
				state.lastDurationMs = Math.max(0, this.now() - now);
				delete this.promises[name];
			});
	}

	private publicJobState(name: BackgroundJobName, now: number) {
		const state = this.states[name];
		const staleAfterMs = this.intervals[name] * 3;
		const stale = state.lastCompletedAt != null && now - state.lastCompletedAt > staleAfterMs;
		const latestAttemptFailed =
			state.lastErrorAt != null &&
			(state.lastCompletedAt == null || state.lastErrorAt > state.lastCompletedAt);
		const status =
			latestAttemptFailed || stale || state.lastFailedCount > 0 || state.lastStorageScanFailed
				? ('degraded' as const)
				: state.lastCompletedAt == null
					? ('starting' as const)
					: ('ok' as const);

		return {
			status,
			running: state.running,
			attempts: state.attempts,
			lockSkips: state.lockSkips,
			lastAttemptAt: toIso(state.lastAttemptAt),
			lastCompletedAt: toIso(state.lastCompletedAt),
			lastSucceededAt: toIso(state.lastSucceededAt),
			lastErrorAt: toIso(state.lastErrorAt),
			lastDurationMs: state.lastDurationMs,
			failures: state.failures,
			lastFailedCount: state.lastFailedCount,
			lastPendingCount: state.lastPendingCount,
			lastMissingActiveCount: state.lastMissingActiveCount,
			lastMissingRetainedCount: state.lastMissingRetainedCount,
			lastUnknownDiskCount: state.lastUnknownDiskCount,
			lastStorageScanFailed: state.lastStorageScanFailed
		};
	}
}

function toIso(value: number | null) {
	return value == null ? null : new Date(value).toISOString();
}

const backgroundJobCoordinator = new BackgroundJobCoordinator();

export function startBackgroundJobs() {
	backgroundJobCoordinator.start();
}

export function triggerBackgroundJobs() {
	backgroundJobCoordinator.trigger();
}

export function stopBackgroundJobs() {
	return backgroundJobCoordinator.stop();
}

export function getBackgroundJobsHealth() {
	return backgroundJobCoordinator.health();
}
