import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { assertRateLimit } from '$lib/server/security/rate-limit';
import { isMfaEnabled, isMfaSessionVerified, verifyMfaChallenge } from '$lib/server/services/mfa';
import { mfaCodeSchema, parseForm } from '$lib/server/validation';
import { translate } from '$lib/i18n';

export const load: PageServerLoad = async (event) => {
	if (!event.locals.user || !event.locals.session?.id) {
		const next = safeNext(event.url.searchParams.get('next') || '/app');
		throw redirect(303, `/login?next=${encodeURIComponent(next)}`);
	}

	const next = safeNext(event.url.searchParams.get('next') || '/app');
	const enabled = await isMfaEnabled(event.locals.user.id);
	if (!enabled) throw redirect(303, next);

	const verified = await isMfaSessionVerified(event.locals.user.id, event.locals.session.id);
	if (verified) throw redirect(303, next);

	return { next };
};

export const actions: Actions = {
	default: async (event) => {
		if (!event.locals.user || !event.locals.session?.id) throw redirect(303, '/login');

		const formData = await event.request.formData();
		const parsed = parseForm(formData, mfaCodeSchema);
		const next = safeNext(formData.get('next')?.toString() || '/app');
		if (!parsed.success)
			return fail(400, { message: translate(event.locals.locale, 'Provide the MFA code.') });

		await assertRateLimit(event, {
			scope: 'auth:mfa',
			identifier: event.locals.user.id,
			windowSeconds: 60,
			max: 8
		});

		const verified = await verifyMfaChallenge({
			userId: event.locals.user.id,
			sessionId: event.locals.session.id,
			code: parsed.data.code
		});

		if (!verified)
			return fail(400, { message: translate(event.locals.locale, 'Invalid MFA code.'), next });
		throw redirect(303, next);
	}
};

function safeNext(next: string) {
	return next.startsWith('/') && !next.startsWith('//') ? next : '/app';
}
