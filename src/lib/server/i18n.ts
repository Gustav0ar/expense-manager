import type { Cookies, RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	defaultLocale,
	isLocalePreference,
	resolveLocale,
	translate,
	type LocalePreference,
	type SupportedLocale
} from '$lib/i18n';

const localeCookieName = 'locale';

export function getLocalePreference(cookies: Cookies): LocalePreference {
	const value = cookies.get(localeCookieName);
	return isLocalePreference(value) ? value : 'system';
}

export function setLocalePreference(cookies: Cookies, locale: LocalePreference) {
	if (locale === 'system') {
		cookies.delete(localeCookieName, { path: '/' });
		return;
	}

	cookies.set(localeCookieName, locale, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: env.NODE_ENV === 'production',
		maxAge: 60 * 60 * 24 * 365
	});
}

export function resolveRequestLocale(event: RequestEvent): {
	locale: SupportedLocale;
	preference: LocalePreference;
} {
	const preference = getLocalePreference(event.cookies);
	return {
		preference,
		locale: resolveLocale(preference, event.request.headers.get('accept-language')) ?? defaultLocale
	};
}

export function internalErrorMessage(locale: SupportedLocale | null | undefined) {
	return translate(locale ?? defaultLocale, 'Internal error.');
}
