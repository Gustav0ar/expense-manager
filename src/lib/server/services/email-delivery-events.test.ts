import { describe, expect, it } from 'vitest';
import {
	InvalidMailjetWebhookPayloadError,
	isMailjetWebhookAuthorized,
	parseMailjetWebhookPayload
} from './email-delivery-events';

const now = new Date('2026-07-09T12:00:00.000Z');
const providerReference = '55d8e3af-9f0d-4e39-8a7a-d907e458db79';

describe('Mailjet delivery events', () => {
	it('checks Basic authentication without accepting malformed credentials', () => {
		const credentials = { username: 'mailjet-events', password: 'correct horse battery staple' };
		const authorization = `Basic ${Buffer.from(
			`${credentials.username}:${credentials.password}`
		).toString('base64')}`;

		expect(isMailjetWebhookAuthorized(authorization, credentials)).toBe(true);
		expect(isMailjetWebhookAuthorized(null, credentials)).toBe(false);
		expect(isMailjetWebhookAuthorized('Bearer token', credentials)).toBe(false);
		expect(
			isMailjetWebhookAuthorized(
				`Basic ${Buffer.from('mailjet-events:wrong').toString('base64')}`,
				credentials
			)
		).toBe(false);
	});

	it('normalizes grouped events and extracts the stable budget-alert reference', () => {
		const events = parseMailjetWebhookPayload(
			[
				{
					event: 'sent',
					time: 1_783_598_100,
					email: 'ADMIN@Example.com',
					CustomID: `budget-alert:${providerReference}`,
					MessageID: 19_421_777_835_146_490,
					Message_GUID: '1ab23cd4-e567-8901-2345-6789f0gh1i2j'
				},
				{
					event: 'open',
					time: 1_783_598_160,
					email: 'admin@example.com',
					CustomID: `budget-alert:${providerReference}`,
					mj_message_id: '19421777835146490'
				}
			],
			now
		);

		expect(events).toEqual([
			expect.objectContaining({
				eventType: 'sent',
				recipientEmail: 'admin@example.com',
				providerReference,
				providerMessageId: null,
				providerMessageUuid: '1ab23cd4-e567-8901-2345-6789f0gh1i2j',
				fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
			}),
			expect.objectContaining({
				eventType: 'open',
				providerMessageId: '19421777835146490'
			})
		]);
	});

	it('creates the same replay fingerprint regardless of object key order', () => {
		const first = parseMailjetWebhookPayload(
			{
				event: 'bounce',
				time: 1_783_598_100,
				email: 'admin@example.com',
				error: 'user unknown'
			},
			now
		)[0];
		const replay = parseMailjetWebhookPayload(
			{
				error: 'user unknown',
				email: 'admin@example.com',
				time: 1_783_598_100,
				event: 'bounce'
			},
			now
		)[0];

		expect(replay.fingerprint).toBe(first.fingerprint);
	});

	it('rejects unsupported, stale, future and oversized event batches', () => {
		const base = { time: 1_783_598_100, email: 'admin@example.com' };
		for (const payload of [
			{ ...base, event: 'unknown' },
			{ ...base, event: 'sent', time: 1_783_000_000 },
			{ ...base, event: 'sent', time: 1_783_600_000 },
			Array.from({ length: 101 }, () => ({ ...base, event: 'sent' }))
		]) {
			expect(() => parseMailjetWebhookPayload(payload, now)).toThrow(
				InvalidMailjetWebhookPayloadError
			);
		}
	});
});
