import { defineConfig } from '@playwright/test';
import { configurePlaywrightDatabase, previewCommand } from './tests/playwright/config';

const database = configurePlaywrightDatabase('functional');

export default defineConfig({
	...database.lifecycle,
	expect: {
		timeout: 10_000
	},
	workers: 3,
	use: {
		baseURL: 'http://localhost:4173',
		screenshot: 'only-on-failure',
		trace: 'retain-on-failure'
	},
	webServer: {
		command: previewCommand(),
		env: {
			BETTER_AUTH_RATE_LIMIT_MAX: '1000',
			DATABASE_URL: database.databaseUrl!,
			EMAIL_DELIVERY: 'log',
			MAILJET_WEBHOOK_PASSWORD: 'mailjet-e2e-password',
			MAILJET_WEBHOOK_USERNAME: 'mailjet-e2e',
			ORIGIN: 'http://localhost:4173'
		},
		port: 4173
	},
	testMatch: '**/*.e2e.{ts,js}'
});
