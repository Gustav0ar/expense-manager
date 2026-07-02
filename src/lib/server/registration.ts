import { env } from '$env/dynamic/private';

export function isRegistrationEnabled(value = env.ALLOW_REGISTRATION) {
	return value !== 'false';
}

export function getInviteTokenFromNext(next: string) {
	if (!next.startsWith('/') || next.startsWith('//')) return null;

	try {
		const url = new URL(next, 'http://internal.local');
		const segments = url.pathname.split('/').filter(Boolean);
		if (segments.length !== 2 || segments[0] !== 'invite') return null;
		return segments[1] || null;
	} catch {
		return null;
	}
}
