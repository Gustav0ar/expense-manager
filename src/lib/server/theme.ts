import type { Cookies } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export const themePreferences = ['system', 'light', 'dark'] as const;

export type ThemePreference = (typeof themePreferences)[number];

const themeCookieName = 'theme';

export function isThemePreference(value: unknown): value is ThemePreference {
	return typeof value === 'string' && themePreferences.includes(value as ThemePreference);
}

export function getThemePreference(cookies: Cookies): ThemePreference {
	const value = cookies.get(themeCookieName);
	return isThemePreference(value) ? value : 'system';
}

export function setThemePreference(cookies: Cookies, theme: ThemePreference) {
	if (theme === 'system') {
		cookies.delete(themeCookieName, { path: '/' });
		return;
	}

	cookies.set(themeCookieName, theme, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: env.NODE_ENV === 'production',
		maxAge: 60 * 60 * 24 * 365
	});
}
