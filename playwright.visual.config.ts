import { defineConfig } from '@playwright/test';
import { configurePlaywrightDatabase, previewCommand } from './tests/playwright/config';

const database = configurePlaywrightDatabase('visual');

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4173);
const baseURL = `http://localhost:${port}`;

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
		baseURL,
		colorScheme: 'dark',
		locale: 'en-US',
		timezoneId: 'UTC',
		viewport: { width: 1280, height: 900 }
	},
	webServer: {
		command: previewCommand(` --port ${port}`),
		env: {
			DATABASE_URL: database.databaseUrl!,
			EMAIL_DELIVERY: 'log',
			ORIGIN: baseURL
		},
		port
	}
});
