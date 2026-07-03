import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { auth, isEmailVerificationRequired } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { user } from '$lib/server/db/auth.schema';
import { parseForm, signUpSchema } from '$lib/server/validation';
import { assertRateLimit } from '$lib/server/security/rate-limit';
import { getInviteTokenFromNext, isRegistrationEnabled } from '$lib/server/registration';
import { getPendingInvitation } from '$lib/server/services/invitations';
import { translate } from '$lib/i18n';
import { eq } from 'drizzle-orm';

export const load: PageServerLoad = async (event) => {
	if (event.locals.user) throw redirect(303, '/app');
	const next = safeNext(event.url.searchParams.get('next') || '/app');
	return {
		next,
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
				message: translate(event.locals.locale, 'Check name, email and password.'),
				values: Object.fromEntries(formData)
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
			max: 3
		});

		if (isEmailVerificationRequired() && (await accountExists(parsed.data.email))) {
			await auth.api.sendVerificationEmail({
				body: {
					email: parsed.data.email,
					callbackURL: next
				}
			});
			throw redirect(303, '/login?resentVerification=1');
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
					await auth.api.sendVerificationEmail({
						body: {
							email: parsed.data.email,
							callbackURL: next
						}
					});
					throw redirect(303, '/login?resentVerification=1');
				}

				return fail(400, {
					message: err.message || translate(event.locals.locale, 'Could not create the account.'),
					values: { name: parsed.data.name, email: parsed.data.email }
				});
			}
			throw err;
		}

		if (isEmailVerificationRequired()) {
			throw redirect(303, '/login?verifyEmail=1');
		}

		throw redirect(303, next);
	}
};

function safeNext(next: string) {
	return next.startsWith('/') && !next.startsWith('//') ? next : '/app';
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

async function accountExists(email: string) {
	const [existingUser] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email))
		.limit(1);
	return Boolean(existingUser);
}
