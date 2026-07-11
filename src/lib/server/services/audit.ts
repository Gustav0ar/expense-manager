import { auditEvent } from '$lib/server/db/schema';
import { db } from '$lib/server/db';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import type { WorkspaceContext } from './workspaces';

export type AuditInput = {
	workspaceId?: number | null;
	actorUserId?: string | null;
	action: string;
	entityType: string;
	entityId?: string | number | null;
	metadata?: Record<string, unknown>;
};

type AuditExecutor = Pick<typeof db, 'insert'>;

export async function insertAuditEvent(executor: AuditExecutor, input: AuditInput) {
	await executor.insert(auditEvent).values({
		workspaceId: input.workspaceId ?? null,
		actorUserId: input.actorUserId ?? null,
		action: input.action,
		entityType: input.entityType,
		entityId: input.entityId == null ? null : String(input.entityId),
		metadata: input.metadata ?? null
	});
}

// Reserved for audit events that are not paired with a database mutation.
export async function writeAuditEvent(input: AuditInput) {
	await insertAuditEvent(db, input);
}

export type AuditFilters = {
	action?: string;
	entityType?: string;
	cursor?: string;
	limit?: number;
};

export async function listAuditEvents(context: WorkspaceContext, filters: AuditFilters = {}) {
	const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
	const cursor = decodeAuditCursor(filters.cursor);
	const conditions: SQL[] = [eq(auditEvent.workspaceId, context.workspaceId)];

	if (filters.action) conditions.push(eq(auditEvent.action, filters.action));
	if (filters.entityType) conditions.push(eq(auditEvent.entityType, filters.entityType));
	if (cursor) conditions.push(lt(auditEvent.id, cursor.id));

	const rows = await db
		.select({
			id: auditEvent.id,
			action: auditEvent.action,
			entityType: auditEvent.entityType,
			entityId: auditEvent.entityId,
			actorUserId: auditEvent.actorUserId,
			metadata: auditEvent.metadata,
			createdAt: auditEvent.createdAt
		})
		.from(auditEvent)
		.where(and(...conditions))
		.orderBy(desc(auditEvent.id))
		.limit(limit + 1);

	const hasMore = rows.length > limit;
	const items = hasMore ? rows.slice(0, limit) : rows;
	const last = items.at(-1);

	return {
		items,
		nextCursor: hasMore && last ? encodeAuditCursor(last.id) : null
	};
}

function encodeAuditCursor(id: number) {
	return Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');
}

function decodeAuditCursor(cursor?: string) {
	if (!cursor) return null;
	try {
		const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
			id?: unknown;
		};
		return typeof parsed.id === 'number' && Number.isInteger(parsed.id) && parsed.id > 0
			? { id: parsed.id }
			: null;
	} catch {
		return null;
	}
}
