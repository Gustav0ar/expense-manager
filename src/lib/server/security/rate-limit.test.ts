import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const privateEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);

vi.mock('$env/dynamic/private', () => ({ env: privateEnv }));

import { getClientIp } from './client-ip';
import { assertRateLimit } from './rate-limit';
import { db } from '$lib/server/db';
import { rateLimitBucket } from '$lib/server/db/schema';
import { sha256 } from '$lib/server/utils/crypto';

function requestWithHeaders(headers: Record<string, string>) {
	return {
		request: new Request('http://localhost/login', { headers }),
		getClientAddress: () => '198.51.100.10'
	};
}

describe('rate limit client IP resolution', () => {
	beforeEach(() => {
		Object.keys(privateEnv).forEach((key) => delete privateEnv[key]);
		privateEnv.TRUSTED_PROXY_CIDR = '198.51.100.0/24';
	});

	afterEach(() => {
		Object.keys(privateEnv).forEach((key) => delete privateEnv[key]);
	});

	it('ignores forwarded headers unless proxy headers are trusted', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'false';

		expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.10' }))).toBe(
			'198.51.100.10'
		);
	});

	it('uses the rightmost (proxy-appended) forwarded IP when proxy headers are trusted', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';

		// The rightmost value is appended by the trusted proxy and cannot be
		// forged by the client, unlike the leftmost value.
		expect(
			getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.10, 198.51.100.20' }))
		).toBe('198.51.100.20');
	});

	it('falls back to x-real-ip when there is no forwarded chain', () => {
		privateEnv.TRUST_PROXY_HEADERS = 'true';

		expect(getClientIp(requestWithHeaders({ 'x-real-ip': '203.0.113.20' }))).toBe('203.0.113.20');
	});

	describe('X-Forwarded-For security: rightmost-IP prevents rate-limit bypass', () => {
		it('returns the last IP in a multi-hop chain (proxy-appended, unforgeable)', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			// Client sends fake IP as first hop; real proxy appends real IP at the end.
			// We must use the rightmost value so the attacker cannot bypass rate limits
			// by rotating the leading IP.
			const result = getClientIp(
				requestWithHeaders({ 'x-forwarded-for': '192.0.2.30, 192.0.2.40, 198.51.100.20' })
			);
			expect(result).toBe('198.51.100.20');
		});

		it('trims whitespace from the extracted IP', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			expect(
				getClientIp(requestWithHeaders({ 'x-forwarded-for': '192.0.2.30,  198.51.100.20  ' }))
			).toBe('198.51.100.20');
		});

		it('falls back to getClientAddress when forwarded header is empty', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '' }))).toBe('198.51.100.10');
		});

		it('falls back to getClientAddress when forwarded header is whitespace-only', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '   ' }))).toBe('198.51.100.10');
		});

		it('falls back to getClientAddress when x-real-ip is empty', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-real-ip': '' }))).toBe('198.51.100.10');
		});

		it('falls back to getClientAddress when x-real-ip is whitespace-only', () => {
			privateEnv.TRUST_PROXY_HEADERS = 'true';

			expect(getClientIp(requestWithHeaders({ 'x-real-ip': '  ' }))).toBe('198.51.100.10');
		});
	});
});

describe('rate limit persistence', () => {
	it('normalizes identifiers and resets identifier buckets independently', async () => {
		privateEnv.TRUST_PROXY_HEADERS = 'false';
		const scope = `coverage-${randomUUID()}`;
		const identifier = 'Person@Example.COM';
		const event = rateLimitEvent('198.51.100.10');
		const keys = bucketKeys(scope, '198.51.100.10', identifier);
		try {
			await expect(
				assertRateLimit(event, {
					scope,
					identifier,
					windowSeconds: 60,
					identifierMax: 1,
					ipMax: 10
				})
			).resolves.toBeUndefined();
			await expect(
				assertRateLimit(event, {
					scope,
					identifier: `  ${identifier.toLowerCase()}  `,
					windowSeconds: 60,
					identifierMax: 1,
					ipMax: 10
				})
			).rejects.toMatchObject({ status: 429 });
			await db
				.update(rateLimitBucket)
				.set({ resetAt: new Date(Date.now() - 1_000) })
				.where(eq(rateLimitBucket.key, keys.identifier));
			await expect(
				assertRateLimit(event, {
					scope,
					identifier,
					windowSeconds: 60,
					identifierMax: 1,
					ipMax: 10
				})
			).resolves.toBeUndefined();
			const rows = await bucketCounts([keys.ip, keys.identifier]);
			expect(rows.get(keys.ip)).toBe(3);
			expect(rows.get(keys.identifier)).toBe(1);
		} finally {
			await deleteBuckets([keys.ip, keys.identifier]);
		}
	});

	it('blocks one-account attacks even when the client rotates IP addresses', async () => {
		privateEnv.TRUST_PROXY_HEADERS = 'false';
		const scope = `identifier-rotation-${randomUUID()}`;
		const identifier = 'target@example.com';
		const ips = ['198.51.100.11', '198.51.100.12', '198.51.100.13'];
		const keys = [
			bucketKeys(scope, ips[0], identifier).identifier,
			...ips.map((ip) => bucketKeys(scope, ip, identifier).ip)
		];
		try {
			for (const ip of ips.slice(0, 2)) {
				await expect(
					assertRateLimit(rateLimitEvent(ip), {
						scope,
						identifier,
						windowSeconds: 60,
						identifierMax: 2,
						ipMax: 10
					})
				).resolves.toBeUndefined();
			}
			await expect(
				assertRateLimit(rateLimitEvent(ips[2]), {
					scope,
					identifier,
					windowSeconds: 60,
					identifierMax: 2,
					ipMax: 10
				})
			).rejects.toMatchObject({ status: 429 });
		} finally {
			await deleteBuckets(keys);
		}
	});

	it('blocks account spraying from one IP with a higher shared-network allowance', async () => {
		privateEnv.TRUST_PROXY_HEADERS = 'false';
		const scope = `account-spray-${randomUUID()}`;
		const ip = '198.51.100.20';
		const identifiers = ['first@example.com', 'second@example.com', 'third@example.com'];
		const keys = [
			bucketKeys(scope, ip, identifiers[0]).ip,
			...identifiers.map((identifier) => bucketKeys(scope, ip, identifier).identifier)
		];
		try {
			for (const identifier of identifiers.slice(0, 2)) {
				await expect(
					assertRateLimit(rateLimitEvent(ip), {
						scope,
						identifier,
						windowSeconds: 60,
						identifierMax: 1,
						ipMax: 2
					})
				).resolves.toBeUndefined();
			}
			await expect(
				assertRateLimit(rateLimitEvent(ip), {
					scope,
					identifier: identifiers[2],
					windowSeconds: 60,
					identifierMax: 1,
					ipMax: 2
				})
			).rejects.toMatchObject({ status: 429 });
		} finally {
			await deleteBuckets(keys);
		}
	});

	it('atomically consumes both buckets under concurrent attempts', async () => {
		privateEnv.TRUST_PROXY_HEADERS = 'false';
		const scope = `atomic-${randomUUID()}`;
		const ip = '198.51.100.30';
		const identifier = 'concurrent@example.com';
		const keys = bucketKeys(scope, ip, identifier);
		const options = { scope, identifier, windowSeconds: 60, identifierMax: 1, ipMax: 1 };
		try {
			const results = await Promise.allSettled([
				assertRateLimit(rateLimitEvent(ip), options),
				assertRateLimit(rateLimitEvent(ip), options)
			]);
			expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
			const rows = await bucketCounts([keys.ip, keys.identifier]);
			expect(rows.get(keys.ip)).toBe(2);
			expect(rows.get(keys.identifier)).toBe(2);
		} finally {
			await deleteBuckets([keys.ip, keys.identifier]);
		}
	});

	it('honors global identifier and shared-network IP limit overrides', async () => {
		privateEnv.TRUST_PROXY_HEADERS = 'false';
		privateEnv.AUTH_RATE_LIMIT_IDENTIFIER_MAX = '2';
		privateEnv.AUTH_RATE_LIMIT_IP_MAX = '4';
		const scope = `configured-${randomUUID()}`;
		const ip = '198.51.100.40';
		const identifiers = [
			'configured-a@example.com',
			'configured-b@example.com',
			'configured-c@example.com'
		];
		const keys = [
			bucketKeys(scope, ip, identifiers[0]).ip,
			...identifiers.map((identifier) => bucketKeys(scope, ip, identifier).identifier)
		];
		const options = { scope, windowSeconds: 60, identifierMax: 1, ipMax: 1 };
		try {
			await expect(
				assertRateLimit(rateLimitEvent(ip), { ...options, identifier: identifiers[0] })
			).resolves.toBeUndefined();
			await expect(
				assertRateLimit(rateLimitEvent(ip), { ...options, identifier: identifiers[0] })
			).resolves.toBeUndefined();
			await expect(
				assertRateLimit(rateLimitEvent(ip), { ...options, identifier: identifiers[0] })
			).rejects.toMatchObject({ status: 429 });
			await expect(
				assertRateLimit(rateLimitEvent(ip), { ...options, identifier: identifiers[1] })
			).resolves.toBeUndefined();
			await expect(
				assertRateLimit(rateLimitEvent(ip), { ...options, identifier: identifiers[2] })
			).rejects.toMatchObject({ status: 429 });
		} finally {
			delete privateEnv.AUTH_RATE_LIMIT_IDENTIFIER_MAX;
			delete privateEnv.AUTH_RATE_LIMIT_IP_MAX;
			await deleteBuckets(keys);
		}
	});
});

function rateLimitEvent(ip: string) {
	return {
		request: new Request('http://localhost/login'),
		getClientAddress: () => ip,
		locals: { locale: 'en' }
	} as unknown as RequestEvent;
}

function bucketKeys(scope: string, ip: string, identifier: string) {
	return {
		ip: sha256(`rate-limit:v2:${scope}:ip:${ip}`),
		identifier: sha256(
			`rate-limit:v2:${scope}:identifier:${identifier.normalize('NFKC').trim().toLowerCase()}`
		)
	};
}

async function bucketCounts(keys: string[]) {
	const rows = await db
		.select({ key: rateLimitBucket.key, count: rateLimitBucket.count })
		.from(rateLimitBucket)
		.where(inArray(rateLimitBucket.key, keys));
	return new Map(rows.map((row) => [row.key, row.count]));
}

async function deleteBuckets(keys: string[]) {
	await db.delete(rateLimitBucket).where(inArray(rateLimitBucket.key, keys));
}
