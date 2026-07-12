import { env } from '$env/dynamic/private';
import { getSafeInternalPath } from './security/internal-redirect';

export function isRegistrationEnabled(value = env.ALLOW_REGISTRATION) {
	return value !== 'false';
}

export function getInviteTokenFromNext(next: string) {
	const path = getSafeInternalPath(next);
	if (!path) return null;

	try {
		const url = new URL(path, 'http://expense-manager.internal');
		const segments = url.pathname.split('/').filter(Boolean);
		if (segments.length !== 2 || segments[0] !== 'invite') return null;
		return segments[1] || null;
	} catch {
		return null;
	}
}
