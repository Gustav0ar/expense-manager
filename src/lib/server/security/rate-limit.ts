import { error, type RequestEvent } from '@sveltejs/kit';
import { lte, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { rateLimitBucket } from '$lib/server/db/schema';
import { sha256 } from '$lib/server/utils/crypto';
import { translate } from '$lib/i18n';
import { getPrivateEnv } from '$lib/server/config';
import { getClientIp } from './client-ip';

type RateLimitOptions = {
	scope: string;
	identifier: string;
	windowSeconds: number;
	identifierMax: number;
	ipMax?: number;
};

const cleanupIntervalMs = 60 * 60 * 1000;
const defaultIpLimitMultiplier = 20;
const postgresIntegerMax = 2_147_483_647;
const rateLimitKeyVersion = 'rate-limit:v2';
let lastRateLimitCleanupAt = 0;

export async function assertRateLimit(event: RequestEvent, options: RateLimitOptions) {
	await cleanupExpiredRateLimitBuckets();

	const ip = getClientIp(event);
	const identifier = normalizeRateLimitIdentifier(options.identifier);
	const limits = resolveRateLimits(options);
	const dimensions = [
		{
			key: rateLimitKey(options.scope, 'ip', ip),
			max: limits.ipMax
		},
		{
			key: rateLimitKey(options.scope, 'identifier', identifier),
			max: limits.identifierMax
		}
	];
	const resetAt = new Date(Date.now() + limits.windowSeconds * 1000);
	const resetAtIso = resetAt.toISOString();

	// Both independent dimensions are consumed by one INSERT ... ON CONFLICT
	// statement. PostgreSQL applies the statement atomically, so a concurrent
	// attempt cannot increment one dimension without the other.
	const buckets = await db
		.insert(rateLimitBucket)
		.values(dimensions.map(({ key }) => ({ key, count: 1, resetAt })))
		.onConflictDoUpdate({
			target: rateLimitBucket.key,
			set: {
				count: sql`case when ${rateLimitBucket.resetAt} <= now() then 1 else ${rateLimitBucket.count} + 1 end`,
				resetAt: sql`case when ${rateLimitBucket.resetAt} <= now() then ${resetAtIso}::timestamptz else ${rateLimitBucket.resetAt} end`,
				updatedAt: new Date()
			}
		})
		.returning({
			key: rateLimitBucket.key,
			count: rateLimitBucket.count,
			resetAt: rateLimitBucket.resetAt
		});

	const limitsByKey = new Map(dimensions.map((dimension) => [dimension.key, dimension.max]));
	const blocked = buckets.filter((bucket) => bucket.count > (limitsByKey.get(bucket.key) ?? 0));
	if (blocked.length > 0) {
		const retryAt = new Date(Math.max(...blocked.map((bucket) => bucket.resetAt.getTime())));
		const time = new Intl.DateTimeFormat(event.locals.locale, { timeStyle: 'medium' }).format(
			retryAt
		);
		throw error(
			429,
			translate(event.locals.locale, 'Too many attempts. Try again after {time}.', { time })
		);
	}
}

export function normalizeRateLimitIdentifier(value: string) {
	return value.normalize('NFKC').trim().toLowerCase();
}

function rateLimitKey(scope: string, dimension: 'ip' | 'identifier', value: string) {
	return sha256(`${rateLimitKeyVersion}:${scope}:${dimension}:${value}`);
}

function resolveRateLimits(options: RateLimitOptions) {
	const identifierMax = positiveIntegerEnv('AUTH_RATE_LIMIT_IDENTIFIER_MAX', options.identifierMax);
	const defaultIpMax = Math.min(
		postgresIntegerMax,
		options.ipMax ?? identifierMax * defaultIpLimitMultiplier
	);
	return {
		identifierMax,
		ipMax: positiveIntegerEnv('AUTH_RATE_LIMIT_IP_MAX', defaultIpMax),
		windowSeconds: positiveIntegerEnv('AUTH_RATE_LIMIT_WINDOW_SECONDS', options.windowSeconds)
	};
}

function positiveIntegerEnv(name: string, fallback: number) {
	const value = getPrivateEnv(name);
	if (!value) return fallback;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 && parsed <= postgresIntegerMax ? parsed : fallback;
}

async function cleanupExpiredRateLimitBuckets() {
	const now = Date.now();
	if (now - lastRateLimitCleanupAt < cleanupIntervalMs) return;
	await db
		.delete(rateLimitBucket)
		.where(lte(rateLimitBucket.resetAt, new Date()))
		.then(() => {
			lastRateLimitCleanupAt = now;
		})
		.catch(() => {});
}
