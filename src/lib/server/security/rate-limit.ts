import { error, type RequestEvent } from '@sveltejs/kit';
import { lte, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { rateLimitBucket } from '$lib/server/db/schema';
import { sha256 } from '$lib/server/utils/crypto';
import { translate } from '$lib/i18n';
import { getClientIp } from './client-ip';

type RateLimitOptions = {
	scope: string;
	identifier?: string;
	windowSeconds: number;
	max: number;
};

const cleanupIntervalMs = 60 * 60 * 1000;
let lastRateLimitCleanupAt = 0;

export async function assertRateLimit(event: RequestEvent, options: RateLimitOptions) {
	await cleanupExpiredRateLimitBuckets();

	const ip = getClientIp(event);
	const identifier = options.identifier ? options.identifier.toLowerCase() : '';
	const key = sha256(`${options.scope}:${ip}:${identifier}`);
	const resetAt = new Date(Date.now() + options.windowSeconds * 1000);
	const resetAtIso = resetAt.toISOString();

	const [bucket] = await db
		.insert(rateLimitBucket)
		.values({ key, count: 1, resetAt })
		.onConflictDoUpdate({
			target: rateLimitBucket.key,
			set: {
				count: sql`case when ${rateLimitBucket.resetAt} <= now() then 1 else ${rateLimitBucket.count} + 1 end`,
				resetAt: sql`case when ${rateLimitBucket.resetAt} <= now() then ${resetAtIso}::timestamptz else ${rateLimitBucket.resetAt} end`,
				updatedAt: new Date()
			}
		})
		.returning({ count: rateLimitBucket.count, resetAt: rateLimitBucket.resetAt });

	if (bucket.count > options.max) {
		const time = new Intl.DateTimeFormat(event.locals.locale, { timeStyle: 'medium' }).format(
			bucket.resetAt
		);
		throw error(
			429,
			translate(event.locals.locale, 'Too many attempts. Try again after {time}.', { time })
		);
	}
}

async function cleanupExpiredRateLimitBuckets() {
	const now = Date.now();
	if (now - lastRateLimitCleanupAt < cleanupIntervalMs) return;
	lastRateLimitCleanupAt = now;
	await db
		.delete(rateLimitBucket)
		.where(lte(rateLimitBucket.resetAt, new Date()))
		.catch(() => {});
}
