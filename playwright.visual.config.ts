import { defineConfig } from '@playwright/test';
import { configurePlaywrightDatabase, previewCommand } from './tests/playwright/config';

const database = configurePlaywrightDatabase('visual');

export default defineConfig({
	...database.lifecycle,
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
		command: previewCommand(),
		env: {
			DATABASE_URL: database.databaseUrl!,
			EMAIL_DELIVERY: 'log',
			ORIGIN: 'http://localhost:4173'
		},
		port: 4173
	}
});
