import { auditEvent } from '$lib/server/db/schema';
import { user } from '$lib/server/db/auth.schema';
import { db } from '$lib/server/db';
import { and, desc, eq, lt, type SQL } from 'drizzle-orm';
import { decodeCursor, encodeCursor, isSafePositiveInteger } from '$lib/server/utils/cursor';
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
			actorName: user.name,
			metadata: auditEvent.metadata,
			createdAt: auditEvent.createdAt
		})
		.from(auditEvent)
		.leftJoin(user, eq(auditEvent.actorUserId, user.id))
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
	return encodeCursor({ id });
}

function decodeAuditCursor(cursor?: string) {
	return decodeCursor(cursor, (value): value is { id: number } => {
		const candidate = value && typeof value === 'object' ? (value as { id?: unknown }) : null;
		return Boolean(candidate && isSafePositiveInteger(candidate.id));
	});
}
