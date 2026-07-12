import type { PlaywrightTestConfig } from '@playwright/test';
import { createPlaywrightDatabaseDescriptor, descriptorFromEnvironment } from './database';

type DatabaseLifecycle = Pick<PlaywrightTestConfig, 'globalSetup' | 'globalTeardown' | 'metadata'>;

export function configurePlaywrightDatabase(suite: string, enabled = true) {
	if (!enabled) return { databaseUrl: undefined, lifecycle: {} satisfies DatabaseLifecycle };
	const hasExistingDescriptor = Boolean(
		process.env.PLAYWRIGHT_BASE_DATABASE_URL || process.env.PLAYWRIGHT_DATABASE_NAME
	);
	if (hasExistingDescriptor) {
		const descriptor = descriptorFromEnvironment();
		return configuredDatabase(descriptor.databaseUrl, descriptor.databaseName, suite);
	}
	const baseUrl = process.env.PLAYWRIGHT_BASE_DATABASE_URL ?? process.env.DATABASE_URL;
	if (!baseUrl) throw new Error('DATABASE_URL is required for local Playwright suites.');
	const descriptor = createPlaywrightDatabaseDescriptor(suite, baseUrl);
	process.env.PLAYWRIGHT_BASE_DATABASE_URL = descriptor.baseUrl;
	process.env.PLAYWRIGHT_DATABASE_NAME = descriptor.databaseName;
	process.env.DATABASE_URL = descriptor.databaseUrl;
	return configuredDatabase(descriptor.databaseUrl, descriptor.databaseName, suite);
}

function configuredDatabase(databaseUrl: string, databaseName: string, suite: string) {
	return {
		databaseUrl,
		lifecycle: {
			globalSetup: './tests/playwright/global-setup.ts',
			globalTeardown: './tests/playwright/global-teardown.ts',
			metadata: { isolatedDatabase: databaseName, suite }
		} satisfies DatabaseLifecycle
	};
}

export function previewCommand(argumentsValue = '') {
	const build = process.env.PLAYWRIGHT_SKIP_WEB_SERVER_BUILD === 'true' ? '' : 'pnpm build && ';
	return `${build}pnpm preview${argumentsValue}`;
}
