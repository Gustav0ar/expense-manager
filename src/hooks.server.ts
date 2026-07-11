import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { error, redirect, type HandleServerError } from '@sveltejs/kit';
import { getThemePreference } from '$lib/server/theme';
import { internalErrorMessage, resolveRequestLocale } from '$lib/server/i18n';
import { translate } from '$lib/i18n';
import { isMfaEnabled, isMfaSessionVerified } from '$lib/server/services/mfa';
import { isTrustedOrigin } from '$lib/server/security/origin';
import { assertProxyTrustConfig } from '$lib/server/security/client-ip';
import { isRegistrationEnabled } from '$lib/server/registration';
import { traceRequest } from '$lib/server/observability/tracing';
import { createRequestIdentity } from '$lib/server/observability/request-id';
import { startBackgroundJobs, triggerBackgroundJobs } from '$lib/server/background-jobs';
import { registerGracefulShutdown } from '$lib/server/shutdown';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const mailjetWebhookPath = '/api/webhooks/mailjet';

// Run once at module load (server startup) to catch proxy misconfiguration early.
if (!building) {
	assertProxyTrustConfig();
	startBackgroundJobs();
	registerGracefulShutdown();
}

function setSecurityHeaders(response: Response) {
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

	if (!dev) {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
		// Content-Security-Policy is set by SvelteKit (csp: { mode: 'nonce' } in
		// vite.config.ts). It auto-injects a per-request nonce into every inline
		// hydration script and into the CSP header, so script-src 'self' no longer
		// blocks them. We must not override that header here.
	}
}

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const startedAt = performance.now();
	const requestId = event.locals.requestId!;
	const themePreference = getThemePreference(event.cookies);
	const { locale, preference: localePreference } = resolveRequestLocale(event);
	event.locals.locale = locale;
	event.locals.localePreference = localePreference;
	triggerBackgroundJobs();
	const themedResolve: typeof resolve = (resolveEvent, options) =>
		resolve(resolveEvent, {
			...options,
			transformPageChunk: ({ html }) =>
				html.replace('<html lang="en"', `<html lang="${locale}" data-theme="${themePreference}"`)
		});

	if (unsafeMethods.has(event.request.method) && !isMailjetWebhook(event.url.pathname)) {
		const origin = event.request.headers.get('origin');
		if (
			!isTrustedOrigin({
				origin,
				baseURL: env.ORIGIN || event.url.origin,
				trustedOrigins: env.TRUSTED_ORIGINS,
				requestOrigin: event.url.origin,
				dev
			})
		) {
			throw error(403, translate(locale, 'Origin is invalid.'));
		}
	}

	if (
		event.request.method === 'POST' &&
		event.url.pathname.replace(/\/$/, '') === '/api/auth/sign-up/email' &&
		!isRegistrationEnabled()
	) {
		throw error(403, translate(locale, 'Registration is currently closed.'));
	}

	if (event.url.pathname === '/api/health') {
		const response = await themedResolve(event);
		setSecurityHeaders(response);
		response.headers.set('X-Request-Id', requestId);
		response.headers.set('Server-Timing', `app;dur=${(performance.now() - startedAt).toFixed(1)}`);
		return response;
	}

	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	if (
		event.locals.user &&
		event.locals.session?.id &&
		shouldEnforceMfa(event.url.pathname) &&
		(await isMfaEnabled(event.locals.user.id)) &&
		!(await isMfaSessionVerified(event.locals.user.id, event.locals.session.id))
	) {
		throw redirect(303, `/mfa?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}

	const response = await svelteKitHandler({ event, resolve: themedResolve, auth, building });

	setSecurityHeaders(response);
	response.headers.set('X-Request-Id', requestId);
	response.headers.set('Server-Timing', `app;dur=${(performance.now() - startedAt).toFixed(1)}`);
	return response;
};

export const handle: Handle = async ({ event, resolve }) => {
	Object.assign(event.locals, createRequestIdentity(event.request.headers.get('x-request-id')));
	return traceRequest(event, () => handleBetterAuth({ event, resolve }));
};

function shouldEnforceMfa(pathname: string) {
	if (isMailjetWebhook(pathname)) return false;
	if (pathname === '/mfa' || pathname.startsWith('/mfa/')) return false;
	if (pathname === '/logout' || pathname.startsWith('/logout/')) return false;
	if (pathname === '/api/health') return false;
	// Allow unauthenticated / pre-auth better-auth flows (sign-in, sign-up,
	// email verification, password reset, OAuth callbacks, sign-out and read-only
	// session endpoints). Sensitive write endpoints (change-password, change-email,
	// delete-user, revoke-sessions) are intentionally NOT in this list so MFA is
	// enforced on them.
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

function isMailjetWebhook(pathname: string) {
	return pathname.replace(/\/$/, '') === mailjetWebhookPath;
}

export const handleError: HandleServerError = ({ error, event, status, message }) => {
	if (!event.locals.requestId) {
		Object.assign(event.locals, createRequestIdentity(event.request.headers.get('x-request-id')));
	}
	const requestId = event.locals.requestId!;
	console.error(
		JSON.stringify({
			level: 'error',
			requestId,
			...(event.locals.externalRequestId
				? { externalRequestId: event.locals.externalRequestId }
				: {}),
			status,
			path: event.url.pathname,
			message,
			error: error instanceof Error ? error.message : String(error)
		})
	);

	return {
		message: status >= 500 ? internalErrorMessage(event.locals.locale) : message,
		requestId
	};
};
