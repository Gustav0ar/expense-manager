import { error, redirect, type RequestHandler } from '@sveltejs/kit';
import { translate } from '$lib/i18n';
import { setLocalePreference } from '$lib/server/i18n';
import { localePreferenceSchema, parseForm } from '$lib/server/validation';
import { safeInternalPath } from '$lib/server/security/internal-redirect';

export const POST: RequestHandler = async (event) => {
	const formData = await event.request.formData();
	const parsed = parseForm(formData, localePreferenceSchema);

	if (!parsed.success) {
		throw error(400, translate(event.locals.locale, 'Language is invalid.'));
	}

	setLocalePreference(event.cookies, parsed.data.locale);
	throw redirect(303, safeReturnPath(formData.get('returnTo')?.toString()));
};

function safeReturnPath(value: string | null | undefined) {
	return safeInternalPath(value, '/login');
}
