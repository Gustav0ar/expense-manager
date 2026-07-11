import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getPrivateEnv, getPrivateSecret } from '$lib/server/config';
import { db } from '$lib/server/db';
import { budgetAlertDelivery, emailDeliveryEvent } from '$lib/server/db/schema';

const mailjetEventTypes = ['sent', 'open', 'click', 'bounce', 'spam', 'blocked', 'unsub'] as const;
const mailjetWebhookMaxAgeMs = 48 * 60 * 60 * 1000;
const mailjetWebhookFutureToleranceMs = 5 * 60 * 1000;
export const emailDeliveryEventRetentionMs = 90 * 24 * 60 * 60 * 1000;
const emailDeliveryEventCleanupLockName = 'expense-manager:email-delivery-event-cleanup:v1';
const budgetAlertCustomIdPattern =
	/^budget-alert:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const providerIdentifier = z.union([
	z.string().trim().min(1).max(160),
	z.number().finite().nonnegative()
]);

const mailjetEventSchema = z
	.object({
		event: z.enum(mailjetEventTypes),
		time: z.number().int().nonnegative(),
		email: z
			.string()
			.trim()
			.min(3)
			.max(320)
			.refine((value) => value.includes('@')),
		CustomID: z.string().trim().max(255).optional(),
		MessageID: providerIdentifier.optional(),
		mj_message_id: providerIdentifier.optional(),
		Message_GUID: z.string().trim().min(1).max(160).optional(),
		MessageUUID: z.string().trim().min(1).max(160).optional()
	})
	.passthrough();

export type MailjetWebhookCredentials = {
	username: string;
	password: string;
};

export type MailjetDeliveryEvent = {
	eventType: (typeof mailjetEventTypes)[number];
	eventTime: Date;
	recipientEmail: string;
	providerReference: string | null;
	providerMessageId: string | null;
	providerMessageUuid: string | null;
	fingerprint: string;
};

export class InvalidMailjetWebhookPayloadError extends Error {}

export function getMailjetWebhookCredentials(): MailjetWebhookCredentials | null {
	const username = getPrivateEnv('MAILJET_WEBHOOK_USERNAME');
	const password = getPrivateSecret('MAILJET_WEBHOOK_PASSWORD');
	if (!username || !password) return null;
	return { username, password };
}

export function isMailjetWebhookAuthorized(
	authorization: string | null,
	credentials: MailjetWebhookCredentials
) {
	if (!authorization) return false;
	const match = authorization.match(/^Basic\s+([^\s]+)$/i);
	if (!match) return false;

	const decoded = Buffer.from(match[1], 'base64').toString('utf8');

	const separator = decoded.indexOf(':');
	if (separator < 0) return false;
	const username = decoded.slice(0, separator);
	const password = decoded.slice(separator + 1);
	const usernameMatches = safeEqual(username, credentials.username);
	const passwordMatches = safeEqual(password, credentials.password);
	return usernameMatches && passwordMatches;
}

export function parseMailjetWebhookPayload(
	payload: unknown,
	now: Date = new Date()
): MailjetDeliveryEvent[] {
	const values = Array.isArray(payload) ? payload : [payload];
	if (values.length === 0 || values.length > 100) {
		throw new InvalidMailjetWebhookPayloadError('Expected between one and 100 events.');
	}

	return values.map((value) => {
		const parsed = mailjetEventSchema.safeParse(value);
		if (!parsed.success) {
			throw new InvalidMailjetWebhookPayloadError('Mailjet event payload is invalid.');
		}

		const eventTime = new Date(parsed.data.time * 1000);
		if (
			!Number.isFinite(eventTime.getTime()) ||
			eventTime.getTime() < now.getTime() - mailjetWebhookMaxAgeMs ||
			eventTime.getTime() > now.getTime() + mailjetWebhookFutureToleranceMs
		) {
			throw new InvalidMailjetWebhookPayloadError('Mailjet event timestamp is outside the window.');
		}

		const customIdMatch = parsed.data.CustomID?.match(budgetAlertCustomIdPattern);
		return {
			eventType: parsed.data.event,
			eventTime,
			recipientEmail: parsed.data.email.toLowerCase(),
			providerReference: customIdMatch?.[1].toLowerCase() ?? null,
			providerMessageId:
				normalizeProviderIdentifier(parsed.data.mj_message_id) ??
				normalizeProviderIdentifier(parsed.data.MessageID),
			providerMessageUuid: parsed.data.Message_GUID ?? parsed.data.MessageUUID ?? null,
			fingerprint: createHash('sha256')
				.update('mailjet\0')
				.update(stableStringify(parsed.data))
				.digest('hex')
		};
	});
}

export async function recordMailjetDeliveryEvents(events: MailjetDeliveryEvent[]) {
	const references = [...new Set(events.flatMap((event) => event.providerReference ?? []))];
	const deliveries =
		references.length === 0
			? []
			: await db
					.select({
						id: budgetAlertDelivery.id,
						providerReference: budgetAlertDelivery.providerReference,
						recipientEmail: budgetAlertDelivery.recipientEmail
					})
					.from(budgetAlertDelivery)
					.where(inArray(budgetAlertDelivery.providerReference, references));
	const deliveryByReferenceAndEmail = new Map(
		deliveries.map((delivery) => [
			`${delivery.providerReference}:${delivery.recipientEmail.toLowerCase()}`,
			delivery
		])
	);

	return db.transaction(async (tx) => {
		let accepted = 0;
		let duplicates = 0;
		let matched = 0;

		for (const event of events) {
			const delivery = event.providerReference
				? deliveryByReferenceAndEmail.get(`${event.providerReference}:${event.recipientEmail}`)
				: undefined;
			const inserted = await tx
				.insert(emailDeliveryEvent)
				.values({
					provider: 'mailjet',
					fingerprint: event.fingerprint,
					eventType: event.eventType,
					eventTime: event.eventTime,
					budgetAlertDeliveryId: delivery?.id,
					providerMessageId: event.providerMessageId,
					providerMessageUuid: event.providerMessageUuid
				})
				.onConflictDoNothing()
				.returning({ id: emailDeliveryEvent.id });

			if (inserted.length === 0) {
				duplicates++;
				continue;
			}

			accepted++;
			if (!delivery) continue;
			matched++;
			if (event.eventType === 'sent' || event.eventType === 'open' || event.eventType === 'click') {
				await tx
					.update(budgetAlertDelivery)
					.set({
						status: 'sent',
						sentAt: sql`coalesce(
							${budgetAlertDelivery.sentAt},
							${event.eventTime.toISOString()}::timestamptz
						)`,
						claimToken: null,
						claimExpiresAt: null,
						lastErrorCategory: null,
						updatedAt: new Date()
					})
					.where(
						and(
							eq(budgetAlertDelivery.id, delivery.id),
							inArray(budgetAlertDelivery.status, ['pending', 'sending', 'failed'])
						)
					);
			}
			await tx
				.update(budgetAlertDelivery)
				.set({
					provider: 'mailjet',
					...(event.providerMessageId ? { providerMessageId: event.providerMessageId } : {}),
					...(event.providerMessageUuid ? { providerMessageUuid: event.providerMessageUuid } : {}),
					lastProviderEvent: event.eventType,
					lastProviderEventAt: event.eventTime,
					updatedAt: new Date()
				})
				.where(
					and(
						eq(budgetAlertDelivery.id, delivery.id),
						or(
							isNull(budgetAlertDelivery.lastProviderEventAt),
							lte(budgetAlertDelivery.lastProviderEventAt, event.eventTime)
						)
					)
				);
		}

		return { accepted, duplicates, matched };
	});
}

export async function pruneEmailDeliveryEvents(now: Date = new Date()) {
	const cutoff = new Date(now.getTime() - emailDeliveryEventRetentionMs);
	return db.transaction(async (tx) => {
		const [lock] = await tx.execute<{ acquired: boolean }>(sql`
			SELECT pg_try_advisory_xact_lock(
				hashtextextended(${emailDeliveryEventCleanupLockName}, 0)
			) AS acquired
		`);
		if (!lock?.acquired) return { deletedEvents: 0, skipped: true };

		const deleted = await tx
			.delete(emailDeliveryEvent)
			.where(lt(emailDeliveryEvent.receivedAt, cutoff))
			.returning({ id: emailDeliveryEvent.id });
		return { deletedEvents: deleted.length };
	});
}

function normalizeProviderIdentifier(value: string | number | undefined) {
	if (typeof value === 'string') return value;
	if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
	return null;
}

function safeEqual(left: string, right: string) {
	const leftHash = createHash('sha256').update(left).digest();
	const rightHash = createHash('sha256').update(right).digest();
	return timingSafeEqual(leftHash, rightHash);
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) =>
					`${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
			)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}
