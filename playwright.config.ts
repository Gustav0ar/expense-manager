import { defineConfig } from '@playwright/test';

export default defineConfig({
	expect: {
		timeout: 10_000
	},
	workers: 3,
	use: {
		baseURL: 'http://localhost:4173'
	},
	webServer: {
		command: 'pnpm build && pnpm preview',
		env: {
			BETTER_AUTH_RATE_LIMIT_MAX: '1000',
			EMAIL_DELIVERY: 'log',
			MAILJET_WEBHOOK_PASSWORD: 'mailjet-e2e-password',
			MAILJET_WEBHOOK_USERNAME: 'mailjet-e2e',
			ORIGIN: 'http://localhost:4173'
		},
		port: 4173
	},
	testMatch: '**/*.e2e.{ts,js}'
});
