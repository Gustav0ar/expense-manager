import { defineConfig } from '@playwright/test';
import { configurePlaywrightDatabase, previewCommand } from './tests/playwright/config';

const database = configurePlaywrightDatabase('performance');

export default defineConfig({
	...database.lifecycle,
	testDir: './tests/quality',
	testMatch: '**/*.performance.{ts,js}',
	workers: 1,
	use: {
		baseURL: 'http://localhost:4173',
		colorScheme: 'dark',
		locale: 'en-US',
		timezoneId: 'UTC'
	},
	webServer: {
		command: previewCommand(),
		env: {
			DATABASE_URL: database.databaseUrl!,
			EMAIL_DELIVERY: 'log',
			ORIGIN: 'http://localhost:4173'
		},
		port: 4173
	}
});
