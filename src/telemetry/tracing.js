/**
 * OpenTelemetry Early Bootstrap Module
 *
 * MUST be loaded before the application entry point so that instrumentation
 * hooks are registered before any instrumented modules (http, ioredis,
 * undici/fetch) are imported.
 *
 * Activation: set NEW_RELIC_LICENSE_KEY env var.
 * If not set, this module is a no-op with zero overhead — OTel packages
 * are NOT even loaded (dynamic imports guard the import path).
 *
 * Export:
 *   - otelSDK: the NodeSDK instance (or null if disabled)
 *   - isOTelEnabled: boolean flag for downstream consumers
 *   - shutdownOTel: function to gracefully shut down the SDK
 */

import { hydrateEarlyRuntimeEnv } from '../bootstrap/runtime-env.js';

/** @type {import('@opentelemetry/sdk-node').NodeSDK | null} */
let sdk = null;

await hydrateEarlyRuntimeEnv({ requiredKeys: ['NEW_RELIC_LICENSE_KEY'] });

const REDACTED_URL = '[REDACTED_TELEGRAM_BOT_URL]';
const TELEGRAM_BOT_PATH_PATTERN = /\/bot[^/?#]+/i;
const URL_ATTRIBUTE_KEYS = [
    'http.url',
    'url.full',
    'url.path',
    'url.query',
    'http.target',
    'http.route',
    'http.request.method_original'
];

export function sanitizeTelegramBotUrl(value) {
    if (typeof value !== 'string') return value;
    if (!TELEGRAM_BOT_PATH_PATTERN.test(value)) return value;
    return value.replace(TELEGRAM_BOT_PATH_PATTERN, '/bot[REDACTED]');
}

function sanitizeSpanUrlAttributes(span) {
    if (!span || typeof span.setAttribute !== 'function') return;
    URL_ATTRIBUTE_KEYS.forEach(key => {
        span.setAttribute(key, REDACTED_URL);
    });
}

function requestLooksLikeTelegramBot(value) {
    return typeof value === 'string' && TELEGRAM_BOT_PATH_PATTERN.test(value);
}

function sanitizeHttpSpan(span, request) {
    const requestUrl = [
        request?.path,
        request?.pathname,
        request?.href,
        request?.url,
        request?.options?.path
    ].find(requestLooksLikeTelegramBot);

    if (requestUrl) {
        sanitizeSpanUrlAttributes(span);
    }
}

function sanitizeHttpStartSpan(request) {
    const requestUrl = [
        request?.path,
        request?.pathname,
        request?.href,
        request?.url,
        request?.options?.path
    ].find(requestLooksLikeTelegramBot);

    return requestUrl ? {
        'http.url': REDACTED_URL,
        'url.full': REDACTED_URL,
        'url.path': REDACTED_URL,
        'url.query': REDACTED_URL,
        'http.target': REDACTED_URL
    } : {};
}

function sanitizeUndiciSpan(span, request) {
    const url = `${request?.origin || ''}${request?.path || ''}`;
    if (requestLooksLikeTelegramBot(url)) {
        sanitizeSpanUrlAttributes(span);
    }
}

function sanitizeUndiciStartSpan(request) {
    const url = `${request?.origin || ''}${request?.path || ''}`;
    return requestLooksLikeTelegramBot(url) ? {
        'url.full': REDACTED_URL,
        'url.path': REDACTED_URL,
        'url.query': REDACTED_URL
    } : {};
}

/**
 * Gracefully shut down the OTel SDK, flushing pending spans and metrics.
 * @returns {Promise<void>}
 */
export async function shutdownOTel() {
    if (!sdk) return;
    try {
        await sdk.shutdown();
        console.log('[OTel] SDK shut down successfully');
    } catch (err) {
        console.error('[OTel] Shutdown error:', err?.message || err);
    }
}

const LICENSE_KEY = process.env.NEW_RELIC_LICENSE_KEY;

if (!LICENSE_KEY) {
    // OTel not configured — silent skip, zero runtime overhead
    // No OTel packages are loaded via dynamic import guard
    console.log('[OTel] NEW_RELIC_LICENSE_KEY not set, skipping initialization');
} else {
    // Dynamic imports: only load OTel packages when actually needed.
    // NOTE: top-level await intentionally blocks the main entry point for ~2-5s
    // so that instrumentations register BEFORE any instrumented modules load.
    // This is required by OTel — instrumentations must patch modules at import time.
    const [
        { NodeSDK },
        { OTLPTraceExporter },
        { OTLPMetricExporter },
        { PeriodicExportingMetricReader },
        { BatchSpanProcessor },
        { resourceFromAttributes },
        { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
        { HttpInstrumentation },
        { IORedisInstrumentation },
        { UndiciInstrumentation },
    ] = await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@opentelemetry/exporter-trace-otlp-proto'),
        import('@opentelemetry/exporter-metrics-otlp-proto'),
        import('@opentelemetry/sdk-metrics'),
        import('@opentelemetry/sdk-trace-base'),
        import('@opentelemetry/resources'),
        import('@opentelemetry/semantic-conventions'),
        import('@opentelemetry/instrumentation-http'),
        import('@opentelemetry/instrumentation-ioredis'),
        import('@opentelemetry/instrumentation-undici'),
    ]);

    const REGION = (process.env.NEW_RELIC_REGION || 'US').toUpperCase();

    /**
     * New Relic OTLP endpoints (official docs):
     *   US: https://otlp.nr-data.net:4318
     *   EU: https://otlp.eu01.nr-data.net:4318
     *
     * HTTP/Protobuf paths:
     *   Traces: /v1/traces
     *   Metrics: /v1/metrics
     *
     * Auth header: api-key: <NEW_RELIC_LICENSE_KEY>
     */
    const OTLP_BASE = REGION === 'EU'
        ? 'https://otlp.eu01.nr-data.net:4318'
        : 'https://otlp.nr-data.net:4318';

    const SERVICE_NAME = process.env.NEW_RELIC_APP_NAME || 'drive-collector';
    const SERVICE_VERSION = process.env.APP_VERSION || 'unknown';
    const DEPLOYMENT_ENV = process.env.NODE_ENV || 'unknown';
    const INSTANCE_ID = process.env.INSTANCE_ID || process.env.HOSTNAME || 'unknown';

    process.env.OTEL_SERVICE_NAME ||= SERVICE_NAME;
    process.env.OTEL_TRACES_SAMPLER ||= 'parentbased_traceidratio';
    process.env.OTEL_TRACES_SAMPLER_ARG ||= '0.1';
    process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE ||= 'delta';
    process.env.OTEL_RESOURCE_ATTRIBUTES = [
        process.env.OTEL_RESOURCE_ATTRIBUTES,
        `service.name=${SERVICE_NAME}`,
        `service.version=${SERVICE_VERSION}`,
        `deployment.environment=${DEPLOYMENT_ENV}`,
        `service.instance.id=${INSTANCE_ID}`,
    ].filter(Boolean).join(',');

    const traceExporter = new OTLPTraceExporter({
        url: `${OTLP_BASE}/v1/traces`,
        headers: { 'api-key': LICENSE_KEY },
    });

    const metricReader = new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
            url: `${OTLP_BASE}/v1/metrics`,
            headers: { 'api-key': LICENSE_KEY },
        }),
        // Export metrics every 60s to reduce memory pressure in 256MB containers
        exportIntervalMillis: 60_000,
    });

    sdk = new NodeSDK({
        resource: resourceFromAttributes({
            [ATTR_SERVICE_NAME]: SERVICE_NAME,
            [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
            'deployment.environment': DEPLOYMENT_ENV,
            'service.instance.id': INSTANCE_ID,
        }),
        // BatchSpanProcessor with constrained queue for 256MB containers
        spanProcessor: new BatchSpanProcessor(traceExporter, {
            maxQueueSize: 128,
            maxExportBatchSize: 32,
            scheduledDelayMillis: 5000,
        }),
        metricReader,
        instrumentations: [
            new HttpInstrumentation({
                // Ignore health check endpoints — they produce noise, not signal
                ignoreIncomingPaths: ['/health', '/healthz', '/ready'],
                startOutgoingSpanHook: sanitizeHttpStartSpan,
                requestHook: sanitizeHttpSpan,
                applyCustomAttributesOnSpan: sanitizeHttpSpan,
                redactedQueryParams: [
                    'token',
                    'access_token',
                    'auth',
                    'authorization',
                    'password',
                    'secret',
                    'key'
                ],
            }),
            new IORedisInstrumentation(),
            new UndiciInstrumentation({
                startSpanHook: sanitizeUndiciStartSpan,
                requestHook: sanitizeUndiciSpan,
            }),
        ],
    });

    sdk.start();
    console.log(`[OTel] SDK started → ${OTLP_BASE} (service: ${SERVICE_NAME}, region: ${REGION})`);

    // Note: The application's GracefulShutdown service handles process exit
    // and will call shutdownOTel() via a registered hook (see lifecycle.js).
    // We do NOT register our own SIGTERM/SIGINT handlers here to avoid
    // short-circuiting the app's graceful shutdown flow (buffered NR logs,
    // in-flight QStash messages, Redis connections, etc.).
}

export { sdk as otelSDK };
export const isOTelEnabled = !!sdk;
