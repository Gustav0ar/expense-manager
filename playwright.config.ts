import { defineConfig } from '@playwright/test';

export default defineConfig({
	workers: 3,
	use: {
		baseURL: 'http://localhost:4173'
	},
	webServer: {
		command: 'pnpm build && pnpm preview',
		env: {
			BETTER_AUTH_RATE_LIMIT_MAX: '1000',
			EMAIL_DELIVERY: 'log',
			ORIGIN: 'http://localhost:4173'
		},
		port: 4173
	},
	testMatch: '**/*.e2e.{ts,js}'
});
