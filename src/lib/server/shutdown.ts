import { advisoryLockClient, client } from '$lib/server/db';
import { stopBackgroundJobs } from '$lib/server/background-jobs';
import { shutdownTracing } from '$lib/server/observability/tracing';

type ShutdownDependencies = {
	stopJobs: () => Promise<unknown>;
	flushTracing: () => Promise<unknown>;
	closeDatabase: () => Promise<unknown>;
};

const defaultShutdownTimeoutMs = 8_000;
let registered = false;
let shuttingDown = false;

export async function performGracefulShutdown(
	dependencies: ShutdownDependencies = defaultShutdownDependencies(),
	timeoutMs = defaultShutdownTimeoutMs
) {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<'timeout'>((resolve) => {
		timeout = setTimeout(() => resolve('timeout'), timeoutMs);
		timeout.unref?.();
	});
	const completed = (async () => {
		await dependencies.stopJobs();
		await Promise.allSettled([dependencies.flushTracing(), dependencies.closeDatabase()]);
		return 'completed' as const;
	})();

	try {
		return await Promise.race([completed, timedOut]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export function registerGracefulShutdown() {
	if (registered || process.env.NODE_ENV !== 'production') return;
	registered = true;

	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.once(signal, () => {
			if (shuttingDown) return;
			shuttingDown = true;
			void performGracefulShutdown()
				.then((outcome) => {
					if (outcome === 'timeout') {
						console.error(
							JSON.stringify({
								level: 'error',
								message: 'graceful_shutdown: timed out',
								signal
							})
						);
					}
					process.exit(outcome === 'completed' ? 0 : 1);
				})
				.catch((error) => {
					console.error(
						JSON.stringify({
							level: 'error',
							message: 'graceful_shutdown: failed',
							signal,
							error: error instanceof Error ? error.message : String(error)
						})
					);
					process.exit(1);
				});
		});
	}
}

function defaultShutdownDependencies(): ShutdownDependencies {
	return {
		stopJobs: stopBackgroundJobs,
		flushTracing: shutdownTracing,
		closeDatabase: async () => {
			await Promise.allSettled([
				client.end({ timeout: 3 }),
				advisoryLockClient.end({ timeout: 3 })
			]);
		}
	};
}
