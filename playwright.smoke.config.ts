import { defineConfig } from '@playwright/test';

const smokeBaseURL = process.env.SMOKE_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:4173';
const isExternalSmoke = Boolean(process.env.SMOKE_BASE_URL);

export default defineConfig({
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
				command: 'pnpm build && pnpm preview',
				env: {
					EMAIL_DELIVERY: 'log',
					ORIGIN: smokeBaseURL
				},
				port: 4173
			}
});
