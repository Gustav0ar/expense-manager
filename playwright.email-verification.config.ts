import { defineConfig } from '@playwright/test';

export default defineConfig({
	workers: 1,
	use: {
		baseURL: 'http://localhost:4175'
	},
	webServer: {
		command: 'pnpm build && pnpm preview --host 0.0.0.0 --port 4175',
		env: {
			BETTER_AUTH_RATE_LIMIT_MAX: '1000',
			EMAIL_DELIVERY: 'log',
			ORIGIN: 'http://localhost:4175',
			REQUIRE_EMAIL_VERIFICATION: 'true'
		},
		port: 4175
	},
	testMatch: '**/email-verification.playwright.{ts,js}'
});
