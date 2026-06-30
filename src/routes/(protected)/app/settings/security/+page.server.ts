import { fail, isHttpError, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { beginMfaSetup, disableMfa, enableMfa, getMfaStatus } from '$lib/server/services/mfa';
import { requireWorkspaceContext } from '$lib/server/services/workspaces';
import { mfaCodeSchema, parseForm } from '$lib/server/validation';

export const load: PageServerLoad = async (event) => {
	await requireWorkspaceContext(event);
	if (!event.locals.user) throw redirect(303, '/login');

	return {
		mfa: await getMfaStatus(event.locals.user.id)
	};
};

export const actions: Actions = {
	beginSetup: async (event) => {
		await requireWorkspaceContext(event);
		if (!event.locals.user) throw redirect(303, '/login');

		const status = await getMfaStatus(event.locals.user.id);
		if (status.enabled) return fail(400, { message: 'MFA ja esta ativo.' });

		return {
			setup: await beginMfaSetup({ email: event.locals.user.email })
		};
	},
	enable: async (event) => {
		await requireWorkspaceContext(event);
		if (!event.locals.user) throw redirect(303, '/login');

		const formData = await event.request.formData();
		const code = parseForm(formData, mfaCodeSchema);
		const secret = formData.get('secret')?.toString() ?? '';
		if (!code.success || secret.length < 16) return fail(400, { message: 'Confira o codigo MFA.' });

		let result: Awaited<ReturnType<typeof enableMfa>>;
		try {
			result = await enableMfa({
				userId: event.locals.user.id,
				email: event.locals.user.email,
				secret,
				code: code.data.code,
				sessionId: event.locals.session?.id
			});
		} catch (err) {
			if (isHttpError(err) && err.status < 500) {
				return fail(err.status, { message: err.body.message });
			}
			throw err;
		}

		return {
			message: 'MFA ativado.',
			recoveryCodes: result.recoveryCodes
		};
	},
	disable: async (event) => {
		await requireWorkspaceContext(event);
		if (!event.locals.user) throw redirect(303, '/login');

		const parsed = parseForm(await event.request.formData(), mfaCodeSchema);
		if (!parsed.success) return fail(400, { message: 'Informe o codigo MFA.' });

		try {
			await disableMfa({ userId: event.locals.user.id, code: parsed.data.code });
		} catch (err) {
			if (isHttpError(err) && err.status < 500) {
				return fail(err.status, { message: err.body.message });
			}
			throw err;
		}

		throw redirect(303, '/app/settings/security');
	}
};
