import { defineConfig } from '@playwright/test';
import { configurePlaywrightDatabase, previewCommand } from './tests/playwright/config';

const smokeBaseURL = process.env.SMOKE_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:4173';
const isExternalSmoke = Boolean(process.env.SMOKE_BASE_URL);
const database = configurePlaywrightDatabase('smoke', !isExternalSmoke);

export default defineConfig({
	...database.lifecycle,
	testDir: './tests/quality',
	testMatch: '**/*.smoke.{ts,js}',
	workers: 1,
	use: {
		baseURL: smokeBaseURL,
		colorScheme: 'dark',
		locale: 'en-US',
		timezoneId: 'UTC'
	},
	webServer: isExternalSmoke
		? undefined
		: {
				command: previewCommand(),
				env: {
					DATABASE_URL: database.databaseUrl!,
					EMAIL_DELIVERY: 'log',
					ORIGIN: smokeBaseURL
				},
				port: 4173
			}
});
