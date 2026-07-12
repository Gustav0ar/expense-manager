import type { PlaywrightTestConfig } from '@playwright/test';
import { createPlaywrightDatabaseDescriptor } from './database';

type DatabaseLifecycle = Pick<PlaywrightTestConfig, 'globalSetup' | 'globalTeardown' | 'metadata'>;

export function configurePlaywrightDatabase(suite: string, enabled = true) {
	if (!enabled) return { databaseUrl: undefined, lifecycle: {} satisfies DatabaseLifecycle };
	const baseUrl = process.env.PLAYWRIGHT_BASE_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!baseUrl) throw new Error('DATABASE_URL is required for local Playwright suites.');
	const descriptor = createPlaywrightDatabaseDescriptor(suite, baseUrl);
	process.env.PLAYWRIGHT_BASE_DATABASE_URL = descriptor.baseUrl;
	process.env.PLAYWRIGHT_DATABASE_NAME = descriptor.databaseName;
	process.env.DATABASE_URL = descriptor.databaseUrl;
	return {
		databaseUrl: descriptor.databaseUrl,
		lifecycle: {
			globalSetup: './tests/playwright/global-setup.ts',
			globalTeardown: './tests/playwright/global-teardown.ts',
			metadata: { isolatedDatabase: descriptor.databaseName, suite }
		} satisfies DatabaseLifecycle
	};
}
