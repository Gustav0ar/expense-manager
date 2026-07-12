import { defineConfig } from '@playwright/test';
import { configurePlaywrightDatabase } from './tests/playwright/config';

const database = configurePlaywrightDatabase('email_verify');

export default defineConfig({
	...database.lifecycle,
	workers: 1,
	use: {
		baseURL: 'http://localhost:4175'
	},
	webServer: {
		command: 'pnpm build && pnpm preview --host 0.0.0.0 --port 4175',
		env: {
			BETTER_AUTH_RATE_LIMIT_MAX: '1000',
			DATABASE_URL: database.databaseUrl!,
			EMAIL_DELIVERY: 'log',
			ORIGIN: 'http://localhost:4175',
			REQUIRE_EMAIL_VERIFICATION: 'true'
		},
		port: 4175
	},
	testMatch: '**/email-verification.playwright.{ts,js}'
});
