import type { Cookies } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { getThemePreference, isThemePreference, setThemePreference } from './theme';

function createCookies(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries(initial));
	const calls: Array<{ action: 'set' | 'delete'; name: string; value?: string; options: unknown }> =
		[];

	const cookies = {
		get: (name: string) => jar.get(name),
		set: (name: string, value: string, options: unknown) => {
			jar.set(name, value);
			calls.push({ action: 'set', name, value, options });
		},
		delete: (name: string, options: unknown) => {
			jar.delete(name);
			calls.push({ action: 'delete', name, options });
		}
	} as Cookies;

	return { cookies, calls, jar };
}

describe('theme preferences', () => {
	it('recognizes supported theme values', () => {
		expect(isThemePreference('system')).toBe(true);
		expect(isThemePreference('light')).toBe(true);
		expect(isThemePreference('dark')).toBe(true);
		expect(isThemePreference('contrast')).toBe(false);
		expect(isThemePreference(null)).toBe(false);
	});

	it('defaults to system for missing or invalid cookies', () => {
		expect(getThemePreference(createCookies().cookies)).toBe('system');
		expect(getThemePreference(createCookies({ theme: 'bad' }).cookies)).toBe('system');
		expect(getThemePreference(createCookies({ theme: 'dark' }).cookies)).toBe('dark');
	});

	it('stores explicit themes and deletes the cookie for system', () => {
		const { cookies, calls, jar } = createCookies();

		setThemePreference(cookies, 'dark');
		expect(jar.get('theme')).toBe('dark');
		expect(calls[0]).toMatchObject({
			action: 'set',
			name: 'theme',
			value: 'dark'
		});

		setThemePreference(cookies, 'system');
		expect(jar.has('theme')).toBe(false);
		expect(calls[1]).toMatchObject({
			action: 'delete',
			name: 'theme'
		});
	});
});
