import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { building } from '$app/environment';
import { db } from '$lib/server/db';
import { getPrivateEnv, getPrivateSecret } from '$lib/server/config';
import { sendPasswordResetEmail, sendVerificationEmail } from '$lib/server/email';
import { buildTrustedOrigins } from '$lib/server/security/origin';
import { defaultLocale } from '$lib/i18n';

const buildTimeSecret = 'build-time-placeholder-build-time-placeholder';
const developmentSecret = 'development-secret-development-secret-32';

const requireEmailVerification =
	getPrivateEnv('REQUIRE_EMAIL_VERIFICATION') === 'true' ||
	(getPrivateEnv('REQUIRE_EMAIL_VERIFICATION') !== 'false' &&
		getPrivateEnv('NODE_ENV') === 'production');

const baseURL = getAuthBaseUrl();
const secret = getAuthSecret();

export const auth = betterAuth({
	appName: getPrivateEnv('PUBLIC_APP_NAME') || 'Expense Manager',
	baseURL,
	secret,
	trustedOrigins: buildTrustedOrigins({
		baseURL,
		trustedOrigins: getPrivateEnv('TRUSTED_ORIGINS')
	}),
	database: drizzleAdapter(db, { provider: 'pg' }),
	emailAndPassword: {
		enabled: true,
		requireEmailVerification,
		minPasswordLength: 10,
		sendResetPassword: async ({ user, url }) => {
			await sendPasswordResetEmail(user.email, url, getCurrentLocale());
		}
	},
	emailVerification: {
		sendOnSignUp: requireEmailVerification,
		sendOnSignIn: false,
		sendVerificationEmail: async ({ user, url }) => {
			await sendVerificationEmail(user.email, url, getCurrentLocale());
		}
	},
	session: {
		cookieCache: {
			enabled: true,
			maxAge: 60 * 5 // 5 minutes — validates session from signed cookie without a DB round-trip
		}
	},
	rateLimit: {
		enabled: true,
		window: 60,
		max: getBetterAuthRateLimitMax()
	},
	plugins: [
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});

function getAuthBaseUrl() {
	const origin = getPrivateEnv('ORIGIN') || 'http://localhost:5173';
	if (!building && getPrivateEnv('NODE_ENV') === 'production' && origin.includes('localhost')) {
		throw new Error('ORIGIN must be configured with the public HTTPS origin in production.');
	}
	return origin;
}

function getAuthSecret() {
	const value = getPrivateSecret('BETTER_AUTH_SECRET');
	if (
		!building &&
		getPrivateEnv('NODE_ENV') === 'production' &&
		(!value || value === buildTimeSecret || value === developmentSecret)
	) {
		throw new Error('BETTER_AUTH_SECRET must be a high-entropy production secret.');
	}
	if (!building && !value) {
		console.warn(
			'[auth] BETTER_AUTH_SECRET is not set. Using the development fallback secret. ' +
				'Set BETTER_AUTH_SECRET in your environment for consistent sessions.'
		);
		return developmentSecret;
	}
	return value ?? developmentSecret;
}

function getBetterAuthRateLimitMax() {
	const parsed = Number.parseInt(getPrivateEnv('BETTER_AUTH_RATE_LIMIT_MAX') || '100', 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : 100;
}

export function isEmailVerificationRequired() {
	return requireEmailVerification;
}

function getCurrentLocale() {
	try {
		return getRequestEvent().locals.locale;
	} catch {
		return defaultLocale;
	}
}
