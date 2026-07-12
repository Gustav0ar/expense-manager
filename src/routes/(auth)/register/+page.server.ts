import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { auth, isEmailVerificationRequired } from '$lib/server/auth';
import { parseForm, signUpSchema } from '$lib/server/validation';
import { assertRateLimit } from '$lib/server/security/rate-limit';
import { getInviteTokenFromNext, isRegistrationEnabled } from '$lib/server/registration';
import { getPendingInvitation } from '$lib/server/services/invitations';
import {
	findVerificationUser,
	pruneExpiredUnverifiedRegistrations,
	recordInitialVerificationEmail,
	requestVerificationEmail,
	type VerificationEmailRequestResult
} from '$lib/server/services/email-verification';
import { translate } from '$lib/i18n';
import { safeInternalPath } from '$lib/server/security/internal-redirect';

export const load: PageServerLoad = async (event) => {
	if (event.locals.user) throw redirect(303, '/app');
	const next = safeNext(event.url.searchParams.get('next') || '/app');
	return {
		next,
		returnTo: `${event.url.pathname}${event.url.search}`,
		registrationEnabled: await canRegisterFromNext(next)
	};
};

export const actions: Actions = {
	default: async (event) => {
		const formData = await event.request.formData();
		const next = safeNext(formData.get('next')?.toString() || '/app');
		const invitation = await getAllowedInvite(next);

		if (!isRegistrationEnabled() && !invitation) {
			return fail(403, {
				message: translate(event.locals.locale, 'Registration is currently closed.'),
				values: { next }
			});
		}

		const parsed = parseForm(formData, signUpSchema);

		if (!parsed.success) {
			return fail(400, {
				message: translate(event.locals.locale, signUpValidationMessage(parsed.error.issues)),
				values: safeValues(formData, next)
			});
		}

		if (invitation && invitation.email.toLowerCase() !== parsed.data.email.toLowerCase()) {
			return fail(403, {
				message: translate(event.locals.locale, 'This invite belongs to another email.'),
				values: { name: parsed.data.name, email: parsed.data.email, next }
			});
		}

		await assertRateLimit(event, {
			scope: 'auth:register',
			identifier: parsed.data.email,
			windowSeconds: 60,
			identifierMax: 3
		});

		if (isEmailVerificationRequired()) {
			await pruneExpiredUnverifiedRegistrations();
			const existingUser = await findVerificationUser(parsed.data.email);

			if (existingUser && !existingUser.emailVerified) {
				const result = await resendVerificationEmail(parsed.data.email, next);
				const response = verificationResponse(event.locals.locale, result, {
					name: parsed.data.name,
					email: parsed.data.email,
					next
				});
				if (response) return response;
			}
		}

		try {
			await auth.api.signUpEmail({
				body: {
					name: parsed.data.name,
					email: parsed.data.email,
					password: parsed.data.password,
					callbackURL: next
				}
			});
		} catch (err) {
			if (err instanceof APIError) {
				if (isEmailVerificationRequired() && isExistingAccountError(err)) {
					const result = await resendVerificationEmail(parsed.data.email, next);
					const response = verificationResponse(event.locals.locale, result, {
						name: parsed.data.name,
						email: parsed.data.email,
						next
					});
					if (response) return response;
				}

				return fail(400, {
					message: translate(event.locals.locale, 'Could not create the account.'),
					values: { name: parsed.data.name, email: parsed.data.email }
				});
			}
			throw err;
		}

		if (isEmailVerificationRequired()) {
			await recordInitialVerificationEmail(parsed.data.email);
			throw redirect(303, '/login?verifyEmail=1');
		}

		throw redirect(303, next);
	}
};

function safeNext(next: string) {
	return safeInternalPath(next, '/app');
}

async function canRegisterFromNext(next: string) {
	return isRegistrationEnabled() || Boolean(await getAllowedInvite(next));
}

async function getAllowedInvite(next: string) {
	if (isRegistrationEnabled()) return null;

	const token = getInviteTokenFromNext(next);
	return token ? await getPendingInvitation(token) : null;
}

function isExistingAccountError(err: APIError) {
	return (
		err.body?.code === 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' ||
		err.body?.message === 'User already exists. Use another email.' ||
		err.message === 'User already exists. Use another email.'
	);
}

async function resendVerificationEmail(email: string, callbackURL: string) {
	return requestVerificationEmail({
		email,
		send: async () => {
			await auth.api.sendVerificationEmail({
				body: { email, callbackURL }
			});
		}
	});
}

function verificationResponse(
	locale: string,
	result: VerificationEmailRequestResult,
	values: { name: string; email: string; next: string }
) {
	if (result.status === 'sent') throw redirect(303, '/login?resentVerification=1');
	if (result.status === 'expired' || result.status === 'not_found') return null;

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

	return fail(400, {
		message: translate(locale, 'Could not create the account.'),
		values
	});
}

function safeValues(formData: FormData, next: string) {
	return {
		name: formData.get('name')?.toString() ?? '',
		email: formData.get('email')?.toString() ?? '',
		next
	};
}

function signUpValidationMessage(issues: Array<{ message: string }>) {
	if (issues.some((issue) => issue.message === 'Passwords do not match.')) {
		return 'Passwords do not match.';
	}

	return 'Check name, email and password.';
}
