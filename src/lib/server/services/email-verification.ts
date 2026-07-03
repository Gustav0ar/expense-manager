import { and, eq, inArray, lte } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { emailVerificationThrottle, user, workspace } from '$lib/server/db/schema';

const resendCooldownMs = 2 * 60 * 1000;
const maxVerificationEmailSends = 5;
const pendingRegistrationTtlMs = 60 * 60 * 1000;

type VerificationUser = {
	id: string;
	email: string;
	emailVerified: boolean;
};

export type VerificationEmailRequestResult =
	| { status: 'sent'; sentCount: number }
	| { status: 'cooldown'; retryAt: Date }
	| { status: 'limit'; deleteAfter: Date }
	| { status: 'expired' }
	| { status: 'not_found' }
	| { status: 'verified' };

export async function findVerificationUser(email: string) {
	const [existingUser] = await db
		.select({
			id: user.id,
			email: user.email,
			emailVerified: user.emailVerified
		})
		.from(user)
		.where(eq(user.email, email))
		.limit(1);

	return existingUser ?? null;
}

export async function recordInitialVerificationEmail(email: string, now = new Date()) {
	const existingUser = await findVerificationUser(email);
	if (!existingUser || existingUser.emailVerified) return;

	await db
		.insert(emailVerificationThrottle)
		.values({
			userId: existingUser.id,
			email: existingUser.email,
			sentCount: 1,
			lastSentAt: now,
			limitReachedAt: null,
			deleteAfter: null
		})
		.onConflictDoUpdate({
			target: emailVerificationThrottle.userId,
			set: {
				email: existingUser.email,
				sentCount: 1,
				lastSentAt: now,
				limitReachedAt: null,
				deleteAfter: null,
				updatedAt: now
			}
		});
}

export async function requestVerificationEmail({
	email,
	send,
	now = new Date()
}: {
	email: string;
	send: () => Promise<void>;
	now?: Date;
}): Promise<VerificationEmailRequestResult> {
	await pruneExpiredUnverifiedRegistrations(now);

	const existingUser = await findVerificationUser(email);
	if (!existingUser) return { status: 'not_found' };
	if (existingUser.emailVerified) return { status: 'verified' };

	const reservation = await reserveVerificationEmailAttempt(existingUser, now);
	if (reservation.status !== 'reserved') return reservation;

	await send();
	return { status: 'sent', sentCount: reservation.sentCount };
}

export async function pruneExpiredUnverifiedRegistrations(now = new Date()) {
	const expiredRows = await db
		.select({ userId: emailVerificationThrottle.userId })
		.from(emailVerificationThrottle)
		.innerJoin(user, eq(user.id, emailVerificationThrottle.userId))
		.where(and(eq(user.emailVerified, false), lte(emailVerificationThrottle.deleteAfter, now)));

	const userIds = expiredRows.map((row) => row.userId);
	if (userIds.length === 0) return { deletedUsers: 0 };

	return db.transaction(async (tx) => {
		await tx.delete(workspace).where(inArray(workspace.createdByUserId, userIds));
		const deleted = await tx
			.delete(user)
			.where(and(inArray(user.id, userIds), eq(user.emailVerified, false)))
			.returning({ id: user.id });

		return { deletedUsers: deleted.length };
	});
}

async function reserveVerificationEmailAttempt(existingUser: VerificationUser, now: Date) {
	const [throttle] = await db
		.select()
		.from(emailVerificationThrottle)
		.where(eq(emailVerificationThrottle.userId, existingUser.id))
		.limit(1);

	if (!throttle) {
		await db.insert(emailVerificationThrottle).values({
			userId: existingUser.id,
			email: existingUser.email,
			sentCount: 1,
			lastSentAt: now
		});
		return { status: 'reserved' as const, sentCount: 1 };
	}

	if (throttle.deleteAfter && throttle.deleteAfter <= now) {
		await deleteUnverifiedUser(existingUser.id);
		return { status: 'expired' as const };
	}

	if (throttle.sentCount >= maxVerificationEmailSends) {
		const deleteAfter = throttle.deleteAfter ?? new Date(now.getTime() + pendingRegistrationTtlMs);
		await markVerificationLimit(existingUser.id, now, deleteAfter);
		return { status: 'limit' as const, deleteAfter };
	}

	if (throttle.lastSentAt) {
		const retryAt = new Date(throttle.lastSentAt.getTime() + resendCooldownMs);
		if (retryAt > now) return { status: 'cooldown' as const, retryAt };
	}

	const nextSentCount = throttle.sentCount + 1;
	const limitReachedAt = nextSentCount >= maxVerificationEmailSends ? now : null;
	const deleteAfter =
		nextSentCount >= maxVerificationEmailSends
			? new Date(now.getTime() + pendingRegistrationTtlMs)
			: null;

	await db
		.update(emailVerificationThrottle)
		.set({
			email: existingUser.email,
			sentCount: nextSentCount,
			lastSentAt: now,
			limitReachedAt,
			deleteAfter,
			updatedAt: now
		})
		.where(eq(emailVerificationThrottle.userId, existingUser.id));

	return { status: 'reserved' as const, sentCount: nextSentCount };
}

async function markVerificationLimit(userId: string, now: Date, deleteAfter: Date) {
	await db
		.update(emailVerificationThrottle)
		.set({
			limitReachedAt: now,
			deleteAfter,
			updatedAt: now
		})
		.where(eq(emailVerificationThrottle.userId, userId));
}

async function deleteUnverifiedUser(userId: string) {
	await db.transaction(async (tx) => {
		await tx.delete(workspace).where(eq(workspace.createdByUserId, userId));
		await tx.delete(user).where(and(eq(user.id, userId), eq(user.emailVerified, false)));
	});
}
