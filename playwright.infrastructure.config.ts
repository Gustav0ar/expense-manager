import { defineConfig } from '@playwright/test';
import { configurePlaywrightDatabase } from './tests/playwright/config';

const database = configurePlaywrightDatabase('infrastructure');

export default defineConfig({
	...database.lifecycle,
	testDir: './tests/quality',
	testMatch: '**/*.infrastructure.{ts,js}',
	workers: 1,
	use: {
		locale: 'en-US',
		timezoneId: 'UTC'
	}
});
