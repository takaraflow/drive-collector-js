import dotenv from 'dotenv';
// 立即执行 dotenv 确保凭证可用
dotenv.config();

import { fetchInfisicalSecrets } from '../services/InfisicalClient.js';

let config = null;
let isInitialized = false;

function sanitizeValue(val) {
    if (typeof val !== 'string') return val;
    const markdownLinkRegex = /\[.*\]\((.*)\)/;
    const match = val.match(markdownLinkRegex);
    if (match && match[1]) {
        return match[1];
    }
    return val.trim();
}

export const CACHE_TTL = 10 * 60 * 1000;

export async function initConfig() {
    if (isInitialized) return config;

    console.log('[v4.7.1] 🚀 Initializing configuration...');

    const clientId = process.env.INFISICAL_CLIENT_ID;
    const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
    const projectId = process.env.INFISICAL_PROJECT_ID;

    if (((clientId && clientSecret) || process.env.INFISICAL_TOKEN) && projectId) {
        if (process.env.NODE_ENV === 'test') {
            console.log('[v4.7.1] ℹ️ Skipping Infisical fetch in test environment');
        } else {
            try {
                const secrets = await fetchInfisicalSecrets({
                    clientId,
                    clientSecret,
                    projectId,
                    envName: process.env.NODE_ENV || 'dev'
                });
                
                if (secrets) {
                    for (const key in secrets) {
                        const cleanValue = sanitizeValue(secrets[key]);
                        process.env[key] = cleanValue;
                    }
                }
            } catch (error) {
                console.warn(`[v4.7.1] ⚠️ Infisical fetch skipped/failed, using existing env: ${error.message}`);
            }
        }
    }

    const env = process.env;

    config = {
        apiId: parseInt(env.API_ID) || null,
        apiHash: env.API_HASH || null,
        botToken: env.BOT_TOKEN || null,
        ownerId: env.OWNER_ID || null,
        remoteName: env.RCLONE_REMOTE || null,
        remoteFolder: env.REMOTE_FOLDER || null,
        port: env.PORT || "3000",
        redis: {
            url: env.NF_REDIS_URL || env.REDIS_URL || null,
            token: env.REDIS_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || null,
            tls: {
                enabled: (env.REDIS_TLS_ENABLED || env.NF_REDIS_TLS_ENABLED) !== 'false' && 
                        ((env.NF_REDIS_URL || env.REDIS_URL || '').startsWith('rediss://') || 
                         (env.REDIS_TLS_ENABLED || env.NF_REDIS_TLS_ENABLED) === 'true')
            }
        },
        kv: {
            accountId: env.CF_CACHE_ACCOUNT_ID || env.CF_KV_ACCOUNT_ID || env.CF_ACCOUNT_ID || null,
            namespaceId: env.CF_CACHE_NAMESPACE_ID || env.CF_KV_NAMESPACE_ID || null,
            token: env.CF_CACHE_TOKEN || env.CF_KV_TOKEN || null
        },
        qstash: {
            token: env.QSTASH_TOKEN || null,
            currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY || null,
            nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY || null,
            webhookUrl: env.LB_WEBHOOK_URL || null,
        },
        oss: {
            endpoint: env.R2_ENDPOINT || null,
            accessKeyId: env.R2_ACCESS_KEY_ID || null,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY || null,
            bucket: env.R2_BUCKET || 'drive-collector',
            publicUrl: env.R2_PUBLIC_URL || null,
            workerUrl: env.OSS_WORKER_URL || null,
            workerSecret: env.OSS_WORKER_SECRET || null
        },
        d1: {
            accountId: env.CF_D1_ACCOUNT_ID || env.CF_ACCOUNT_ID || null,
            databaseId: env.CF_D1_DATABASE_ID || null,
            token: env.CF_D1_TOKEN || null
        },
        telegram: {
            apiId: parseInt(env.API_ID) || null,
            apiHash: env.API_HASH || null,
            deviceModel: env.TG_DEVICE_MODEL || 'DriveCollector',
            systemVersion: env.TG_SYSTEM_VERSION || '1.0.0',
            appVersion: env.TG_APP_VERSION || '4.7.1',
            // Test mode logic: Explicit TG_TEST_MODE overrides dev mode default
            testMode: env.TG_TEST_MODE !== undefined
                ? env.TG_TEST_MODE === 'true'
                : (process.env.NODE_ENV === 'dev' || process.env.NODE_MODE === 'dev'),
            proxy: (env.TG_PROXY_HOST || env.TELEGRAM_PROXY_HOST) ? {
                host: env.TG_PROXY_HOST || env.TELEGRAM_PROXY_HOST,
                port: parseInt(env.TG_PROXY_PORT || env.TELEGRAM_PROXY_PORT),
                type: env.TG_PROXY_TYPE || env.TELEGRAM_PROXY_TYPE || 'socks5',
                username: env.TG_PROXY_USERNAME || env.TELEGRAM_PROXY_USERNAME,
                password: env.TG_PROXY_PASSWORD || env.TELEGRAM_PROXY_PASSWORD
            } : null
        }
    };

    isInitialized = true;
    
    // Log environment and test mode status
    const envMode = process.env.NODE_MODE || 'unknown';
    const testModeSource = env.TG_TEST_MODE !== undefined ? `TG_TEST_MODE=${env.TG_TEST_MODE}` : `default (NODE_MODE=${envMode})`;
    console.log(`[Config] Environment: ${envMode}, Telegram Test Mode: ${config.telegram.testMode} (source: ${testModeSource})`);
    
    return config;
}

export function validateConfig() {
    if (!isInitialized) return false;
    const c = config;
    const errors = [];

    if (!c.apiId || !c.apiHash) errors.push("Telegram API_ID/API_HASH 缺失");
    if (!c.botToken) errors.push("Telegram BOT_TOKEN 缺失");
    
    if (errors.length > 0) {
        console.error("❌ 配置验证失败:");
        errors.forEach(err => console.error(`  - ${err}`));
        return false;
    }
    console.log("✅ 核心配置验证通过");
    return true;
}

export function getRedisConnectionConfig() {
    const c = getConfig();
    if (!c.redis.url) return { url: '', options: {} };

    const url = c.redis.url;
    const options = {
        password: c.redis.token,
        tls: c.redis.tls.enabled ? {} : undefined,
        retryStrategy: (times) => Math.min(times * 50, 2000),
        maxRetriesPerRequest: 3
    };

    return { url, options };
}

export function getConfig() {
    if (!isInitialized || !config) {
        throw new Error('Configuration not initialized. Call initConfig() first.');
    }
    return config;
}

export { config };
