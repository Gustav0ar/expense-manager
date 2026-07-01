import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/quality',
	testMatch: '**/*.infrastructure.{ts,js}',
	workers: 1,
	use: {
		locale: 'en-US',
		timezoneId: 'UTC'
	}
});
