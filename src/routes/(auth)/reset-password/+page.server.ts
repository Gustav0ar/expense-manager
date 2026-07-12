import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { parseForm, resetPasswordSchema } from '$lib/server/validation';
import { assertRateLimit } from '$lib/server/security/rate-limit';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = (event) => {
	const token = event.url.searchParams.get('token') || '';
	return { token };
};

export const actions: Actions = {
	default: async (event) => {
		const formData = await event.request.formData();
		const parsed = parseForm(formData, resetPasswordSchema);

		if (!parsed.success) {
			return fail(400, {
				message: translate(event.locals.locale, 'Invalid token or password.'),
				token: formData.get('token')?.toString() ?? ''
			});
		}

		await assertRateLimit(event, {
			scope: 'auth:reset-password',
			identifier: parsed.data.token,
			windowSeconds: 300,
			identifierMax: 5
		});

		try {
			await auth.api.resetPassword({
				body: {
					token: parsed.data.token,
					newPassword: parsed.data.password
				}
			});
		} catch (err) {
			if (err instanceof APIError) {
				return fail(400, {
					message: translate(event.locals.locale, 'Invalid token or expired.'),
					token: parsed.data.token
				});
			}
			throw err;
		}

		throw redirect(303, '/login?reset=1');
	}
};
