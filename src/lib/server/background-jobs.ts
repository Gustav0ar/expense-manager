import { pruneExpiredUnverifiedRegistrations } from '$lib/server/services/email-verification';
import { runRecurringExpenseScheduler } from '$lib/server/services/recurring';
import { runAutomaticBudgetAlertScheduler } from '$lib/server/services/budgets';
import { pruneEmailDeliveryEvents } from '$lib/server/services/email-delivery-events';

export const verificationCleanupIntervalMs = 60_000;
export const recurringSchedulerIntervalMs = 5 * 60 * 1000;
export const budgetAlertSchedulerIntervalMs = 60 * 60 * 1000;
export const emailDeliveryCleanupIntervalMs = 24 * 60 * 60 * 1000;

type BackgroundJobName =
	'verificationCleanup' | 'recurringScheduler' | 'budgetAlertScheduler' | 'emailDeliveryCleanup';
type BackgroundJobResult = { skipped?: boolean } | void;
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
};

type TimerHandle = ReturnType<typeof setInterval>;

type BackgroundJobCoordinatorOptions = {
	verificationCleanup?: BackgroundJobRunner;
	recurringScheduler?: BackgroundJobRunner;
	budgetAlertScheduler?: BackgroundJobRunner;
	emailDeliveryCleanup?: BackgroundJobRunner;
	verificationIntervalMs?: number;
	recurringIntervalMs?: number;
	budgetAlertIntervalMs?: number;
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
		lastDurationMs: null
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
		emailDeliveryCleanup: initialJobState()
	};
	private readonly nextRunAt: Record<BackgroundJobName, number> = {
		verificationCleanup: 0,
		recurringScheduler: 0,
		budgetAlertScheduler: 0,
		emailDeliveryCleanup: 0
	};
	private readonly promises: Partial<Record<BackgroundJobName, Promise<void>>> = {};
	private timer: TimerHandle | null = null;

	constructor(options: BackgroundJobCoordinatorOptions = {}) {
		this.jobs = {
			verificationCleanup: options.verificationCleanup ?? pruneExpiredUnverifiedRegistrations,
			recurringScheduler: options.recurringScheduler ?? runRecurringExpenseScheduler,
			budgetAlertScheduler: options.budgetAlertScheduler ?? runAutomaticBudgetAlertScheduler,
			emailDeliveryCleanup: options.emailDeliveryCleanup ?? pruneEmailDeliveryEvents
		};
		this.intervals = {
			verificationCleanup: options.verificationIntervalMs ?? verificationCleanupIntervalMs,
			recurringScheduler: options.recurringIntervalMs ?? recurringSchedulerIntervalMs,
			budgetAlertScheduler: options.budgetAlertIntervalMs ?? budgetAlertSchedulerIntervalMs,
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
			latestAttemptFailed || stale
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
			lastDurationMs: state.lastDurationMs
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
