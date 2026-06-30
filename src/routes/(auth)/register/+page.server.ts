import { fail, redirect } from '@sveltejs/kit';
import { APIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { parseForm, signUpSchema } from '$lib/server/validation';
import { assertRateLimit } from '$lib/server/security/rate-limit';

export const load: PageServerLoad = (event) => {
	if (event.locals.user) throw redirect(303, '/app');
	return { next: safeNext(event.url.searchParams.get('next') || '/app') };
};

export const actions: Actions = {
	default: async (event) => {
		const formData = await event.request.formData();
		const parsed = parseForm(formData, signUpSchema);
		const next = safeNext(formData.get('next')?.toString() || '/app');

		if (!parsed.success) {
			return fail(400, {
				message: 'Confira nome, email e senha.',
				values: Object.fromEntries(formData)
			});
		}

		await assertRateLimit(event, {
			scope: 'auth:register',
			identifier: parsed.data.email,
			windowSeconds: 60,
			max: 3
		});

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
				return fail(400, {
					message: err.message || 'Nao foi possivel criar a conta.',
					values: { name: parsed.data.name, email: parsed.data.email }
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
