import type { RequestEvent } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export function getClientIp(event: Pick<RequestEvent, 'request' | 'getClientAddress'>) {
	if (env.TRUST_PROXY_HEADERS === 'true' || process.env.TRUST_PROXY_HEADERS === 'true') {
		const forwarded = event.request.headers.get('x-forwarded-for');
		const realIp = event.request.headers.get('x-real-ip');
		if (forwarded) return forwarded.split(',').at(-1)?.trim() || event.getClientAddress();
		if (realIp) return realIp.trim() || event.getClientAddress();
	}

	return event.getClientAddress();
}
