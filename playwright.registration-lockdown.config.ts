import { defineConfig } from '@playwright/test';
import { configurePlaywrightDatabase } from './tests/playwright/config';

const database = configurePlaywrightDatabase('registration');

export default defineConfig({
	...database.lifecycle,
	workers: 1,
	use: {
		baseURL: 'http://localhost:4174'
	},
	webServer: {
		command: 'pnpm build && pnpm preview --host 0.0.0.0 --port 4174',
		env: {
			ALLOW_REGISTRATION: 'false',
			BETTER_AUTH_RATE_LIMIT_MAX: '1000',
			DATABASE_URL: database.databaseUrl!,
			EMAIL_DELIVERY: 'log',
			ORIGIN: 'http://localhost:4174'
		},
		port: 4174
	},
	testMatch: '**/registration-lockdown.playwright.{ts,js}'
});
