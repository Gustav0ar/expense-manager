import { json, type RequestHandler } from '@sveltejs/kit';
import {
	getMailjetWebhookCredentials,
	InvalidMailjetWebhookPayloadError,
	isMailjetWebhookAuthorized,
	parseMailjetWebhookPayload,
	recordMailjetDeliveryEvents
} from '$lib/server/services/email-delivery-events';

const maxBodyBytes = 256 * 1024;

export const POST: RequestHandler = async ({ request }) => {
	const credentials = getMailjetWebhookCredentials();
	if (!credentials) {
		return webhookJson({ error: 'Webhook is not configured.' }, { status: 503 });
	}

	if (!isMailjetWebhookAuthorized(request.headers.get('authorization'), credentials)) {
		return webhookJson(
			{ error: 'Authentication required.' },
			{
				status: 401,
				headers: { 'WWW-Authenticate': 'Basic realm="Mailjet webhook", charset="UTF-8"' }
			}
		);
	}

	try {
		const body = await readBody(request, maxBodyBytes);
		const payload = JSON.parse(body);
		const result = await recordMailjetDeliveryEvents(parseMailjetWebhookPayload(payload));
		return webhookJson(result);
	} catch (error) {
		if (error instanceof PayloadTooLargeError) {
			return webhookJson({ error: 'Payload is too large.' }, { status: 413 });
		}
		if (error instanceof SyntaxError || error instanceof InvalidMailjetWebhookPayloadError) {
			return webhookJson({ error: 'Payload is invalid.' }, { status: 400 });
		}
		throw error;
	}
};

class PayloadTooLargeError extends Error {}

async function readBody(request: Request, limit: number) {
	const contentLength = Number(request.headers.get('content-length'));
	if (Number.isFinite(contentLength) && contentLength > limit) {
		await drainBody(request.body, limit * 2);
		throw new PayloadTooLargeError();
	}

	if (!request.body) return '';
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > limit) {
			await reader.cancel();
			throw new PayloadTooLargeError();
		}
		chunks.push(value);
	}

	const body = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(body);
	} catch {
		throw new InvalidMailjetWebhookPayloadError('Payload must be valid UTF-8.');
	}
}

async function drainBody(body: ReadableStream<Uint8Array> | null, limit: number) {
	if (!body) return;
	const reader = body.getReader();
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) return;
		length += value.byteLength;
		if (length > limit) {
			await reader.cancel();
			return;
		}
	}
}

function webhookJson(data: unknown, init: ResponseInit = {}) {
	const response = json(data, init);
	response.headers.set('Cache-Control', 'no-store');
	return response;
}
