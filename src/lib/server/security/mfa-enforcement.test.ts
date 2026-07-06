import { describe, expect, it } from 'vitest';

/**
 * Mirrors the shouldEnforceMfa logic from hooks.server.ts.
 * Tests here serve as the authoritative specification of which routes bypass MFA
 * enforcement. If this test breaks after a hooks.server.ts change, update BOTH.
 *
 * Exempted paths: pre-auth flows (sign-in, sign-up, OAuth), read-only session
 * operations (get-session, list-sessions, update-session), email flows
 * (verify-email, send-verification-email), password-reset, health check, and
 * sign-out. Sensitive write operations (change-password, change-email,
 * delete-user, revoke-sessions) are intentionally enforced.
 */
function shouldEnforceMfa(pathname: string): boolean {
	if (pathname === '/mfa' || pathname.startsWith('/mfa/')) return false;
	if (pathname === '/logout' || pathname.startsWith('/logout/')) return false;
	if (pathname === '/api/health') return false;
	if (
		pathname.startsWith('/api/auth/sign-in') ||
		pathname.startsWith('/api/auth/sign-up') ||
		pathname === '/api/auth/sign-out' ||
		pathname === '/api/auth/get-session' ||
		pathname === '/api/auth/verify-email' ||
		pathname === '/api/auth/send-verification-email' ||
		pathname === '/api/auth/update-session' ||
		pathname === '/api/auth/list-sessions' ||
		pathname.startsWith('/api/auth/reset-password') ||
		pathname.startsWith('/api/auth/forget-password') ||
		pathname.startsWith('/api/auth/callback') ||
		pathname.startsWith('/api/auth/oauth') ||
		pathname === '/api/auth/ok'
	)
		return false;
	return true;
}

describe('MFA enforcement rules', () => {
	describe('routes that must NOT enforce MFA', () => {
		it('exempts the MFA challenge page itself', () => {
			expect(shouldEnforceMfa('/mfa')).toBe(false);
			expect(shouldEnforceMfa('/mfa/')).toBe(false);
		});

		it('exempts the logout endpoint', () => {
			expect(shouldEnforceMfa('/logout')).toBe(false);
			expect(shouldEnforceMfa('/logout/')).toBe(false);
		});

		it('exempts the health check', () => {
			expect(shouldEnforceMfa('/api/health')).toBe(false);
		});

		it('exempts sign-in flows', () => {
			expect(shouldEnforceMfa('/api/auth/sign-in')).toBe(false);
			expect(shouldEnforceMfa('/api/auth/sign-in/email')).toBe(false);
			expect(shouldEnforceMfa('/api/auth/sign-in/social')).toBe(false);
		});

		it('exempts sign-up flows', () => {
			expect(shouldEnforceMfa('/api/auth/sign-up')).toBe(false);
			expect(shouldEnforceMfa('/api/auth/sign-up/email')).toBe(false);
		});

		it('exempts sign-out (user must be able to log out even without MFA)', () => {
			// Critical: if sign-out is MFA-enforced, a user who never completes MFA
			// is permanently locked in the MFA loop with no escape.
			expect(shouldEnforceMfa('/api/auth/sign-out')).toBe(false);
		});

		it('exempts get-session (needed for session lookup on every request)', () => {
			expect(shouldEnforceMfa('/api/auth/get-session')).toBe(false);
		});

		it('exempts email verification', () => {
			expect(shouldEnforceMfa('/api/auth/verify-email')).toBe(false);
		});

		it('exempts send-verification-email (needed during email-change flow before MFA is completed)', () => {
			expect(shouldEnforceMfa('/api/auth/send-verification-email')).toBe(false);
		});

		it('exempts update-session and list-sessions (session management prior to MFA completion)', () => {
			expect(shouldEnforceMfa('/api/auth/update-session')).toBe(false);
			expect(shouldEnforceMfa('/api/auth/list-sessions')).toBe(false);
		});

		it('exempts password reset flows', () => {
			expect(shouldEnforceMfa('/api/auth/forget-password')).toBe(false);
			expect(shouldEnforceMfa('/api/auth/reset-password')).toBe(false);
			expect(shouldEnforceMfa('/api/auth/reset-password/confirm')).toBe(false);
		});

		it('exempts OAuth callback routes', () => {
			expect(shouldEnforceMfa('/api/auth/callback/github')).toBe(false);
			expect(shouldEnforceMfa('/api/auth/oauth/github')).toBe(false);
		});

		it('exempts /api/auth/ok (health probe)', () => {
			expect(shouldEnforceMfa('/api/auth/ok')).toBe(false);
		});
	});

	describe('routes that MUST enforce MFA', () => {
		it('enforces MFA on sensitive account write endpoints', () => {
			// These are the endpoints we want MFA to protect.
			expect(shouldEnforceMfa('/api/auth/change-password')).toBe(true);
			expect(shouldEnforceMfa('/api/auth/change-email')).toBe(true);
			expect(shouldEnforceMfa('/api/auth/delete-user')).toBe(true);
			expect(shouldEnforceMfa('/api/auth/revoke-session')).toBe(true);
			expect(shouldEnforceMfa('/api/auth/revoke-other-sessions')).toBe(true);
			expect(shouldEnforceMfa('/api/auth/revoke-sessions')).toBe(true);
			expect(shouldEnforceMfa('/api/auth/update-user')).toBe(true);
		});

		it('enforces MFA on all protected app routes', () => {
			expect(shouldEnforceMfa('/app')).toBe(true);
			expect(shouldEnforceMfa('/app/expenses')).toBe(true);
			expect(shouldEnforceMfa('/app/dashboard')).toBe(true);
			expect(shouldEnforceMfa('/app/settings/security')).toBe(true);
		});

		it('enforces MFA on arbitrary unknown routes', () => {
			expect(shouldEnforceMfa('/unknown')).toBe(true);
			expect(shouldEnforceMfa('/')).toBe(true);
		});
	});
});
