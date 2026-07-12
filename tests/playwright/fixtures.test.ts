import { describe, expect, it } from 'vitest';
import { testPassword, uniqueEmail } from './fixtures';

describe('Playwright identity fixtures', () => {
	it('generates distinct, valid local test addresses', () => {
		const first = uniqueEmail('Route User');
		const second = uniqueEmail('Route User');

		expect(first).toMatch(/^route-user-[0-9a-f-]{36}@example\.com$/);
		expect(second).toMatch(/^route-user-[0-9a-f-]{36}@example\.com$/);
		expect(second).not.toBe(first);
	});

	it('keeps the shared password explicit and stable for test-only logins', () => {
		expect(testPassword).toBe('test-password-123');
	});
});
