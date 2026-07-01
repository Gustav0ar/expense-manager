import { defineConfig } from '@playwright/test';

export default defineConfig({
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
		command: 'pnpm build && pnpm preview',
		env: {
			EMAIL_DELIVERY: 'log',
			ORIGIN: 'http://localhost:4173'
		},
		port: 4173
	}
});
