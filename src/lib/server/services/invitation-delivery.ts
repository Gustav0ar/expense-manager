import { and, eq, sql } from 'drizzle-orm';
import { advisoryLockClient, db } from '$lib/server/db';
import { workspaceInvitationDelivery } from '$lib/server/db/schema';
import {
	emailDeliveryConcurrency,
	sendInvitationEmail,
	type MailDeliveryReceipt
} from '$lib/server/email';
import { randomToken } from '$lib/server/utils/crypto';
import { mapWithConcurrency } from '$lib/server/utils/concurrency';
import { decryptInvitationToken } from './invitation-token';
import type { SupportedLocale } from '$lib/i18n';

export const invitationDeliverySchedulerLockKey = 7_273_299_173;
export const invitationDeliveryClaimTtlMs = 10 * 60 * 1000;
export const invitationDeliveryMaxAttempts = 8;
export const invitationDeliveryBatchSize = 25;

type InvitationSender = (
	to: string,
	workspaceName: string,
	url: string,
	locale: SupportedLocale
) => Promise<MailDeliveryReceipt | void>;

type InvitationDeliveryOptions = {
	send?: InvitationSender;
	now?: Date;
	origin?: string;
};

type ClaimedInvitation = {
	id: number;
	invitationId: number;
	encryptedToken: string;
	locale: SupportedLocale;
	recipientEmail: string;
	tokenHash: string;
	workspaceName: string;
};

export type InvitationDeliveryErrorCategory =
	| 'timeout'
	| 'configuration'
	| 'provider_rejected'
	| 'provider_unavailable'
	| 'network'
	| 'encryption'
	| 'expired'
	| 'unknown';

export async function deliverInvitation(
	invitationId: number,
	options: InvitationDeliveryOptions = {}
) {
	return processInvitationDeliveries({ ...options, invitationId, limit: 1 });
}

export async function runInvitationDeliveryScheduler(options: InvitationDeliveryOptions = {}) {
	const reserved = await advisoryLockClient.reserve();
	try {
		const [lock] = await reserved<{ acquired: boolean }[]>`
			SELECT pg_try_advisory_lock(${invitationDeliverySchedulerLockKey}) AS acquired
		`;
		if (!lock?.acquired) return { processed: 0, sent: 0, failed: 0, skipped: true };

		try {
			const result = await processInvitationDeliveries({
				...options,
				limit: invitationDeliveryBatchSize
			});
			const [outstanding] = await db.execute<{ failed: number }>(sql`
				select count(*)::integer as "failed"
				from "workspace_invitation_delivery"
				where "status" = 'failed'
					and "last_error_category" is distinct from 'expired'
			`);
			return { ...result, failed: Number(outstanding.failed) };
		} finally {
			await reserved`SELECT pg_advisory_unlock(${invitationDeliverySchedulerLockKey})`;
		}
	} finally {
		reserved.release();
	}
}

async function processInvitationDeliveries(
	options: InvitationDeliveryOptions & { invitationId?: number; limit: number }
) {
	const now = options.now ?? new Date();
	const claimToken = randomToken(18);
	const claimExpiresAt = new Date(now.getTime() + invitationDeliveryClaimTtlMs);
	const claimed = await claimInvitationDeliveries(
		claimToken,
		claimExpiresAt,
		now,
		options.limit,
		options.invitationId
	);
	const send = options.send ?? sendInvitationEmail;
	const origin = (options.origin ?? process.env.ORIGIN ?? 'http://localhost:5173').replace(
		/\/$/,
		''
	);

	let sent = 0;
	let failed = 0;
	await mapWithConcurrency(claimed, emailDeliveryConcurrency(), async (delivery) => {
		let token: string;
		try {
			token = decryptInvitationToken(delivery.encryptedToken, delivery.tokenHash);
		} catch {
			failed++;
			await markInvitationDeliveryFailed(delivery.id, claimToken, 'encryption', now);
			logDeliveryFailure(delivery.id, 'encryption');
			return;
		}

		try {
			const receipt = await send(
				delivery.recipientEmail,
				delivery.workspaceName,
				`${origin}/invite/${token}`,
				delivery.locale
			);
			const updated = await db
				.update(workspaceInvitationDelivery)
				.set({
					status: 'sent',
					claimToken: null,
					claimExpiresAt: null,
					lastErrorCategory: null,
					provider: receipt?.provider ?? null,
					providerMessageId: receipt?.messageId ?? null,
					providerMessageUuid: receipt?.messageUuid ?? null,
					sentAt: now,
					updatedAt: now
				})
				.where(
					and(
						eq(workspaceInvitationDelivery.id, delivery.id),
						eq(workspaceInvitationDelivery.claimToken, claimToken)
					)
				)
				.returning({ id: workspaceInvitationDelivery.id });
			sent += updated.length;
		} catch (error) {
			failed++;
			const category = classifyInvitationDeliveryError(error);
			await markInvitationDeliveryFailed(delivery.id, claimToken, category, now);
			logDeliveryFailure(delivery.id, category);
		}
	});

	return { processed: claimed.length, sent, failed };
}

async function claimInvitationDeliveries(
	claimToken: string,
	claimExpiresAt: Date,
	now: Date,
	limit: number,
	invitationId?: number
) {
	return db.transaction(async (tx) => {
		await tx.execute(sql`
			with expired as (
				update "workspace_invitation"
				set "status" = 'expired'
				where "status" = 'pending' and "expires_at" <= ${now.toISOString()}::timestamptz
				returning "id"
			)
			update "workspace_invitation_delivery" as d
			set "status" = 'failed',
				"claim_token" = null,
				"claim_expires_at" = null,
				"last_error_category" = 'expired',
				"updated_at" = ${now.toISOString()}::timestamptz
			where d."invitation_id" in (select "id" from expired)
		`);

		const rows = await tx.execute<ClaimedInvitation>(sql`
			with candidates as (
				select d."id"
				from "workspace_invitation_delivery" d
				join "workspace_invitation" i on i."id" = d."invitation_id"
				where i."status" = 'pending'
					and i."expires_at" > ${now.toISOString()}::timestamptz
					and d."attempt_count" < ${invitationDeliveryMaxAttempts}
					and (
						d."status" in ('pending', 'failed')
						or (
							d."status" = 'sending'
							and d."claim_expires_at" < ${now.toISOString()}::timestamptz
						)
					)
					${invitationId == null ? sql`` : sql`and i."id" = ${invitationId}`}
				order by d."created_at", d."id"
				for update of d skip locked
				limit ${limit}
			), claimed as (
				update "workspace_invitation_delivery" d
				set "status" = 'sending',
					"claim_token" = ${claimToken},
					"claim_expires_at" = ${claimExpiresAt.toISOString()}::timestamptz,
					"attempt_count" = d."attempt_count" + 1,
					"last_error_category" = null,
					"updated_at" = ${now.toISOString()}::timestamptz
				from candidates c
				where d."id" = c."id"
				returning d."id", d."invitation_id", d."encrypted_token", d."locale"
			)
			select c."id",
				c."invitation_id" as "invitationId",
				c."encrypted_token" as "encryptedToken",
				c."locale",
				i."email" as "recipientEmail",
				i."token_hash" as "tokenHash",
				w."name" as "workspaceName"
			from claimed c
			join "workspace_invitation" i on i."id" = c."invitation_id"
			join "workspace" w on w."id" = i."workspace_id"
		`);

		return rows.map((row) => ({
			...row,
			id: Number(row.id),
			invitationId: Number(row.invitationId)
		}));
	});
}

async function markInvitationDeliveryFailed(
	deliveryId: number,
	claimToken: string,
	category: InvitationDeliveryErrorCategory,
	now: Date
) {
	await db
		.update(workspaceInvitationDelivery)
		.set({
			status: 'failed',
			claimToken: null,
			claimExpiresAt: null,
			lastErrorCategory: category,
			updatedAt: now
		})
		.where(
			and(
				eq(workspaceInvitationDelivery.id, deliveryId),
				eq(workspaceInvitationDelivery.claimToken, claimToken)
			)
		);
}

export function classifyInvitationDeliveryError(error: unknown): InvitationDeliveryErrorCategory {
	if (!(error instanceof Error)) return 'unknown';
	const value = `${error.name} ${error.message}`.toLowerCase();
	if (/timeout|timed out|abort/.test(value)) return 'timeout';
	if (/not configured|configuration|credential|api key|secret/.test(value)) return 'configuration';
	if (/http 4\d\d/.test(value)) return 'provider_rejected';
	if (/http 5\d\d|service unavailable|bad gateway/.test(value)) return 'provider_unavailable';
	if (/network|fetch failed|econn|enotfound|socket/.test(value)) return 'network';
	return 'unknown';
}

function logDeliveryFailure(deliveryId: number, category: InvitationDeliveryErrorCategory) {
	console.error(
		JSON.stringify({
			level: 'error',
			message: 'invitation_delivery: send failed',
			deliveryId,
			errorCategory: category
		})
	);
}
