import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { error, redirect, type HandleServerError } from '@sveltejs/kit';
import { getThemePreference } from '$lib/server/theme';
import { resolveRequestLocale } from '$lib/server/i18n';
import { translate } from '$lib/i18n';
import { randomUUID } from 'node:crypto';
import { isMfaEnabled, isMfaSessionVerified } from '$lib/server/services/mfa';
import { pruneExpiredUnverifiedRegistrations } from '$lib/server/services/email-verification';
import { isTrustedOrigin } from '$lib/server/security/origin';
import { isRegistrationEnabled } from '$lib/server/registration';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const verificationCleanupIntervalMs = 60_000;
let nextVerificationCleanupAt = 0;
let verificationCleanupPromise: Promise<unknown> | null = null;

function setSecurityHeaders(response: Response) {
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

	if (!dev) {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
		response.headers.set(
			'Content-Security-Policy',
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
		);
	}
}

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const startedAt = performance.now();
	const requestId = event.request.headers.get('x-request-id') || randomUUID();
	event.locals.requestId = requestId;
	const themePreference = getThemePreference(event.cookies);
	const { locale, preference: localePreference } = resolveRequestLocale(event);
	event.locals.locale = locale;
	event.locals.localePreference = localePreference;
	cleanupExpiredUnverifiedRegistrations();
	const themedResolve: typeof resolve = (resolveEvent, options) =>
		resolve(resolveEvent, {
			...options,
			transformPageChunk: ({ html }) =>
				html.replace('<html lang="en"', `<html lang="${locale}" data-theme="${themePreference}"`)
		});

	if (unsafeMethods.has(event.request.method)) {
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

export const handle: Handle = handleBetterAuth;

function cleanupExpiredUnverifiedRegistrations() {
	if (building) return;

	const now = Date.now();
	if (verificationCleanupPromise || now < nextVerificationCleanupAt) return;

	nextVerificationCleanupAt = now + verificationCleanupIntervalMs;
	verificationCleanupPromise = pruneExpiredUnverifiedRegistrations()
		.catch((err) => {
			console.error('Expired email verification cleanup failed.', err);
		})
		.finally(() => {
			verificationCleanupPromise = null;
		});
}

function shouldEnforceMfa(pathname: string) {
	if (pathname === '/mfa' || pathname.startsWith('/mfa/')) return false;
	if (pathname === '/logout' || pathname.startsWith('/logout/')) return false;
	if (pathname === '/api/health') return false;
	if (pathname.startsWith('/api/auth')) return false;
	return true;
}

export const handleError: HandleServerError = ({ error, event, status, message }) => {
	const requestId = event.locals.requestId || randomUUID();
	console.error(
		JSON.stringify({
			level: 'error',
			requestId,
			status,
			path: event.url.pathname,
			message,
			error: error instanceof Error ? error.message : String(error)
		})
	);

	return {
		message: status >= 500 ? 'Internal error.' : message,
		requestId
	};
};
