import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/quality',
	testMatch: '**/*.visual.{ts,js}',
	workers: 1,
	expect: {
		toHaveScreenshot: {
			animations: 'disabled',
			caret: 'hide',
			maxDiffPixelRatio: 0.01
		}
	},
	use: {
		baseURL: 'http://localhost:4173',
		colorScheme: 'dark',
		locale: 'en-US',
		timezoneId: 'UTC',
		viewport: { width: 1280, height: 900 }
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
