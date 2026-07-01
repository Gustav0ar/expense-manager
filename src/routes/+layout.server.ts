import type { LayoutServerLoad } from './$types';
import { getLocalePreference } from '$lib/server/i18n';

export const load: LayoutServerLoad = (event) => ({
	locale: event.locals.locale,
	localePreference: getLocalePreference(event.cookies)
});
