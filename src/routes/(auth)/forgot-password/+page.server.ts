import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { parseForm, forgotPasswordSchema } from '$lib/server/validation';
import { assertRateLimit } from '$lib/server/security/rate-limit';
import { env } from '$env/dynamic/private';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = () => ({});

export const actions: Actions = {
	default: async (event) => {
		const formData = await event.request.formData();
		const parsed = parseForm(formData, forgotPasswordSchema);

		if (!parsed.success) {
			return fail(400, { message: translate(event.locals.locale, 'Provide a valid email.') });
		}

		await assertRateLimit(event, {
			scope: 'auth:forgot-password',
			identifier: parsed.data.email,
			windowSeconds: 300,
			identifierMax: 3
		});

		await auth.api.requestPasswordReset({
			body: {
				email: parsed.data.email,
				redirectTo: `${env.ORIGIN || 'http://localhost:5173'}/reset-password`
			}
		});

		return { sent: true };
	}
};
