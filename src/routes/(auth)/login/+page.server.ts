import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { parseForm, signInSchema } from '$lib/server/validation';
import { assertRateLimit } from '$lib/server/security/rate-limit';

export const load: PageServerLoad = (event) => {
	if (event.locals.user) throw redirect(303, '/app');
	return {
		next: safeNext(event.url.searchParams.get('next') || '/app'),
		registered: event.url.searchParams.get('registered') === '1',
		reset: event.url.searchParams.get('reset') === '1'
	};
};

export const actions: Actions = {
	default: async (event) => {
		const formData = await event.request.formData();
		const parsed = parseForm(formData, signInSchema);
		const next = safeNext(formData.get('next')?.toString() || '/app');

		if (!parsed.success) {
			return fail(400, { message: 'Confira email e senha.', values: Object.fromEntries(formData) });
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
				return fail(400, {
					message: 'Credenciais invalidas.',
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
