import type { RequestHandler } from './$types';
import { sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { getBackgroundJobsHealth } from '$lib/server/background-jobs';

export const GET: RequestHandler = async () => {
	const startedAt = performance.now();
	try {
		await db.execute(sql`select 1`);
		return Response.json({
			ok: true,
			database: 'ok',
			backgroundJobs: getBackgroundJobsHealth(),
			timestamp: new Date().toISOString(),
			durationMs: Math.round(performance.now() - startedAt)
		});
	} catch {
		return Response.json(
			{
				ok: false,
				database: 'error',
				backgroundJobs: getBackgroundJobsHealth(),
				timestamp: new Date().toISOString(),
				durationMs: Math.round(performance.now() - startedAt)
			},
			{ status: 503 }
		);
	}
};
