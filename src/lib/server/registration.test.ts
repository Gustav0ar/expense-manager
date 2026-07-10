import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getInviteTokenFromNext, isRegistrationEnabled } from './registration';

describe('registration access control', () => {
	it('allows registration by default', () => {
		expect(isRegistrationEnabled(undefined)).toBe(true);
	});

	it('disables registration only when explicitly set to false', () => {
		expect(isRegistrationEnabled('false')).toBe(false);
		expect(isRegistrationEnabled('true')).toBe(true);
		expect(isRegistrationEnabled('0')).toBe(true);
	});

	it('forwards the registration policy through every production Compose app', () => {
		for (const composeFile of ['docker-compose.yml', 'docker-compose.traefik.yml']) {
			const compose = readFileSync(resolve(process.cwd(), composeFile), 'utf8');
			expect(compose, composeFile).toContain('ALLOW_REGISTRATION: ${ALLOW_REGISTRATION:-true}');
		}
	});

	it('extracts invite tokens from safe next paths', () => {
		expect(getInviteTokenFromNext('/invite/test-token')).toBe('test-token');
		expect(getInviteTokenFromNext('/invite/test-token?from=email')).toBe('test-token');
		expect(getInviteTokenFromNext('/app')).toBeNull();
		expect(getInviteTokenFromNext('/invite')).toBeNull();
		expect(getInviteTokenFromNext('/invite/test-token/extra')).toBeNull();
		expect(getInviteTokenFromNext('https://evil.example/invite/test-token')).toBeNull();
		expect(getInviteTokenFromNext('//evil.example/invite/test-token')).toBeNull();
	});
});
