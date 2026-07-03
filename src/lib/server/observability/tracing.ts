import type { RequestEvent } from '@sveltejs/kit';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';
import {
	context,
	propagation,
	SpanKind,
	SpanStatusCode,
	trace,
	type TextMapGetter
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK, tracing } from '@opentelemetry/sdk-node';

const defaultSampleRate = 0.1;
const tracerName = 'expense-manager.sveltekit';

let sdk: NodeSDK | null = null;
let started = false;

const requestHeaderGetter: TextMapGetter<Headers> = {
	get(headers, key) {
		return headers.get(key) ?? undefined;
	},
	keys(headers) {
		return Array.from(headers.keys());
	}
};

export function normalizeOtelTracesEndpoint(endpoint: string | undefined, tracesEndpoint?: string) {
	const explicitTracesEndpoint = tracesEndpoint?.trim();
	if (explicitTracesEndpoint) return explicitTracesEndpoint;

	const baseEndpoint = endpoint?.trim();
	if (!baseEndpoint) return '';

	if (baseEndpoint.endsWith('/v1/traces')) return baseEndpoint;
	return `${baseEndpoint.replace(/\/+$/, '')}/v1/traces`;
}

export function parseTraceSampleRate(value: string | undefined) {
	if (!value?.trim()) return defaultSampleRate;

	const sampleRate = Number.parseFloat(value);
	if (!Number.isFinite(sampleRate)) return defaultSampleRate;
	if (sampleRate < 0) return 0;
	if (sampleRate > 1) return 1;
	return sampleRate;
}

export function startTracing() {
	if (building || started || env.OTEL_TRACING_ENABLED !== 'true') return started;

	const url = normalizeOtelTracesEndpoint(
		env.OTEL_EXPORTER_OTLP_ENDPOINT,
		env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
	);

	if (!url) {
		console.warn('OpenTelemetry tracing is enabled but no OTLP traces endpoint is configured.');
		return false;
	}

	const sampleRate = parseTraceSampleRate(env.OTEL_TRACES_SAMPLE_RATE);
	const serviceName = env.OTEL_SERVICE_NAME || 'expense-manager';
	const deploymentEnvironment = env.OTEL_DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || 'production';

	sdk = new NodeSDK({
		resource: resourceFromAttributes({
			'service.name': serviceName,
			'deployment.environment.name': deploymentEnvironment
		}),
		traceExporter: new OTLPTraceExporter({ url }),
		sampler: new tracing.ParentBasedSampler({
			root: new tracing.TraceIdRatioBasedSampler(sampleRate)
		})
	});

	try {
		sdk.start();
		started = true;
		console.info(
			JSON.stringify({
				level: 'info',
				message: 'OpenTelemetry tracing started.',
				serviceName,
				sampleRate
			})
		);
	} catch (error) {
		console.error('OpenTelemetry tracing failed to start.', error);
		sdk = null;
		started = false;
	}

	return started;
}

export async function shutdownTracing() {
	if (!sdk) return;

	await sdk.shutdown();
	sdk = null;
	started = false;
}

export async function traceRequest(
	event: RequestEvent,
	handleRequest: () => Response | Promise<Response>
) {
	if (!startTracing()) return handleRequest();

	const routeId = event.route.id || event.url.pathname;
	const spanName = `${event.request.method} ${routeId}`;
	const parentContext = propagation.extract(
		context.active(),
		event.request.headers,
		requestHeaderGetter
	);
	const tracer = trace.getTracer(tracerName);
	const startedAt = performance.now();

	return context.with(parentContext, () =>
		tracer.startActiveSpan(
			spanName,
			{
				kind: SpanKind.SERVER,
				attributes: {
					'http.request.method': event.request.method,
					'url.path': event.url.pathname,
					'http.route': routeId,
					'app.request_id': event.locals.requestId || '',
					'app.authenticated': Boolean(event.locals.user)
				}
			},
			async (span) => {
				try {
					const response = await handleRequest();
					span.setAttribute('http.response.status_code', response.status);
					span.setAttribute('app.duration_ms', Math.round(performance.now() - startedAt));
					span.setAttribute('app.authenticated', Boolean(event.locals.user));
					if (response.status >= 500) {
						span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
					}
					setTraceHeader(response, span.spanContext().traceId);
					return response;
				} catch (error) {
					const status = getThrownStatus(error);
					span.setAttribute('http.response.status_code', status);
					span.setAttribute('app.duration_ms', Math.round(performance.now() - startedAt));
					if (status >= 500) {
						if (error instanceof Error) span.recordException(error);
						span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
					}
					throw error;
				} finally {
					span.end();
				}
			}
		)
	);
}

function getThrownStatus(error: unknown) {
	if (typeof error === 'object' && error !== null && 'status' in error) {
		const status = Number((error as { status: unknown }).status);
		if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
	}

	return 500;
}

function setTraceHeader(response: Response, traceId: string) {
	try {
		response.headers.set('X-Trace-Id', traceId);
	} catch {
		// Some framework-generated responses can have immutable headers. Tracing
		// must never change the success or failure behavior of the request.
	}
}
