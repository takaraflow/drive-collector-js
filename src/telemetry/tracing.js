/**
 * OpenTelemetry Early Bootstrap Module
 *
 * MUST be loaded via `--import` BEFORE the application entry point
 * so that instrumentation hooks are registered before any instrumented
 * modules (http, ioredis, undici/fetch) are imported.
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

import fs from 'fs';
import { InfisicalSDK } from '@infisical/sdk';
import { mapNodeEnvToInfisicalEnv, normalizeNodeEnv } from '../utils/envMapper.js';

/** @type {import('@opentelemetry/sdk-node').NodeSDK | null} */
let sdk = null;

function sanitizeValue(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    const markdownLink = trimmed.match(/^\[.*\]\((.+)\)$/);
    return markdownLink?.[1] || trimmed.replace(/^['"]|['"]$/g, '');
}

function parseDotenvLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) return null;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
    return [key, sanitizeValue(value)];
}

function loadLocalRuntimeEnv() {
    const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV);
    process.env.NODE_ENV = nodeEnv;
    const envFile = nodeEnv === 'dev' ? '.env' : `.env.${nodeEnv}`;
    if (!fs.existsSync(envFile)) return;

    const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const parsed = parseDotenvLine(line);
        if (!parsed) continue;
        const [key, value] = parsed;
        if (process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

async function loadInfisicalRuntimeEnv() {
    if (process.env.SKIP_INFISICAL_RUNTIME === 'true' || process.env.NODE_ENV === 'test') return;
    if (process.env.NEW_RELIC_LICENSE_KEY) return;

    const token = process.env.INFISICAL_TOKEN;
    const clientId = process.env.INFISICAL_CLIENT_ID;
    const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
    const projectId = process.env.INFISICAL_PROJECT_ID;
    if ((!token && (!clientId || !clientSecret)) || !projectId) return;

    try {
        const infisical = new InfisicalSDK({ siteUrl: process.env.INFISICAL_SITE_URL || 'https://app.infisical.com' });
        if (token) {
            infisical.auth().accessToken(token);
        } else {
            await infisical.auth().universalAuth.login({ clientId, clientSecret });
        }

        const response = await infisical.secrets().listSecrets({
            environment: mapNodeEnvToInfisicalEnv(process.env.NODE_ENV || 'dev'),
            projectId,
            secretPath: process.env.INFISICAL_SECRET_PATH || '/',
            includeImports: true
        });

        for (const secret of response?.secrets || []) {
            if (process.env[secret.secretKey] === undefined) {
                process.env[secret.secretKey] = sanitizeValue(secret.secretValue);
            }
        }
    } catch (error) {
        console.warn(`[OTel] Infisical runtime env load skipped: ${error?.message || error}`);
    }
}

loadLocalRuntimeEnv();
await loadInfisicalRuntimeEnv();

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
            }),
            new IORedisInstrumentation(),
            new UndiciInstrumentation(),
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
