import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { parseForm, signInSchema } from '$lib/server/validation';
import { assertRateLimit } from '$lib/server/security/rate-limit';
import { isRegistrationEnabled } from '$lib/server/registration';
import {
	requestVerificationEmail,
	type VerificationEmailRequestResult
} from '$lib/server/services/email-verification';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = (event) => {
	if (event.locals.user) throw redirect(303, '/app');
	return {
		returnTo: `${event.url.pathname}${event.url.search}`,
		next: safeNext(event.url.searchParams.get('next') || '/app'),
		registered: event.url.searchParams.get('registered') === '1',
		reset: event.url.searchParams.get('reset') === '1',
		verifyEmail: event.url.searchParams.get('verifyEmail') === '1',
		resentVerification: event.url.searchParams.get('resentVerification') === '1',
		registrationEnabled: isRegistrationEnabled()
	};
};

export const actions: Actions = {
	default: async (event) => {
		const formData = await event.request.formData();
		const parsed = parseForm(formData, signInSchema);
		const next = safeNext(formData.get('next')?.toString() || '/app');

		if (!parsed.success) {
			return fail(400, {
				message: translate(event.locals.locale, 'Check email and password.'),
				values: Object.fromEntries(formData)
			});
		}

		await assertRateLimit(event, {
			scope: 'auth:login',
			identifier: parsed.data.email,
			windowSeconds: 60,
			max: 5
		});

		try {
			await auth.api.signInEmail({
				body: {
					email: parsed.data.email,
					password: parsed.data.password,
					callbackURL: next
				}
			});
		} catch (err) {
			if (err instanceof APIError) {
				if (isEmailNotVerifiedError(err)) {
					const verificationResult = await requestVerificationEmail({
						email: parsed.data.email,
						send: async () => {
							await auth.api.sendVerificationEmail({
								body: {
									email: parsed.data.email,
									callbackURL: next
								}
							});
						}
					});

					return emailVerificationFailure(event.locals.locale, verificationResult, {
						email: parsed.data.email,
						next
					});
				}

				return fail(400, {
					message: translate(event.locals.locale, 'Credentials are invalid.'),
					values: { email: parsed.data.email, next }
				});
			}
			throw err;
		}

		throw redirect(303, next);
	}
};

function safeNext(next: string) {
	return next.startsWith('/') && !next.startsWith('//') ? next : '/app';
}

function isEmailNotVerifiedError(err: APIError) {
	return err.body?.code === 'EMAIL_NOT_VERIFIED' || err.body?.message === 'Email not verified';
}

function emailVerificationFailure(
	locale: string,
	result: VerificationEmailRequestResult,
	values: { email: string; next: string }
) {
	if (result.status === 'sent') {
		return fail(403, {
			message: translate(
				locale,
				'We sent a new verification link. Check your inbox before signing in.'
			),
			values
		});
	}

	if (result.status === 'not_found' || result.status === 'verified') {
		return fail(403, {
			message: translate(
				locale,
				'If this email is registered and unverified, we sent a new link. Check your inbox.'
			),
			values
		});
	}

	if (result.status === 'cooldown') {
		return fail(429, {
			message: translate(locale, 'Wait 2 minutes before requesting another verification email.'),
			values
		});
	}

	if (result.status === 'limit') {
		return fail(429, {
			message: translate(
				locale,
				'Verification email limit reached. If the email is not verified within 1 hour, this registration will expire.'
			),
			values
		});
	}

	return fail(410, {
		message: translate(locale, 'Your unverified registration expired. Create your account again.'),
		values
	});
}
