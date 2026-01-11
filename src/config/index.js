import { loadDotenv } from './dotenv.js';
import os from 'os';
import path from 'path';
import { fetchInfisicalSecrets } from '../services/InfisicalClient.js';
import { mapNodeEnvToInfisicalEnv, normalizeNodeEnv } from '../utils/envMapper.js';

// 保护重要环境变量不被 .env 覆盖
const PROTECTED_ENV_VARS = ['NODE_ENV', 'INFISICAL_ENV', 'INFISICAL_TOKEN', 'INFISICAL_PROJECT_ID'];

// 保存需要保护的环境变量
const protectedEnvValues = {};
PROTECTED_ENV_VARS.forEach(key => {
    if (process.env[key]) {
        protectedEnvValues[key] = process.env[key];
    }
});

// 规范化 NODE_ENV（在执行 dotenv 之前）
const normalizedNodeEnv = normalizeNodeEnv(process.env.NODE_ENV);
process.env.NODE_ENV = normalizedNodeEnv;

// 立即执行 dotenv 确保凭证可用
const shouldOverrideEnv = process.env.NODE_ENV !== 'test';

// 根据 NODE_ENV 加载对应的 .env 文件
const envFile = normalizedNodeEnv === 'dev' ? '.env' : `.env.${normalizedNodeEnv}`;
loadDotenv({ path: envFile, override: shouldOverrideEnv });

// 恢复被保护的环境变量（无条件恢复，确保优先级）
Object.entries(protectedEnvValues).forEach(([key, value]) => {
    process.env[key] = value;
});

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

function parseOptionalInt(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
}

export const CACHE_TTL = 10 * 60 * 1000;

export async function initConfig() {
    if (isInitialized) return config;

    // 确保 NODE_ENV 得到规范化（支持测试中动态修改后的重新规范化）
    process.env.NODE_ENV = normalizeNodeEnv(process.env.NODE_ENV);

    console.log(`🚀 Initializing configuration...`);

    // 环境验证机制
    function validateEnvironmentConsistency() {
        const nodeEnv = process.env.NODE_ENV || 'dev';
        const infisicalEnv = process.env.INFISICAL_ENV;
        const expectedInfisicalEnv = mapNodeEnvToInfisicalEnv(nodeEnv);

        // 检查INFISICAL_ENV与NODE_ENV是否匹配
        if (infisicalEnv && infisicalEnv !== expectedInfisicalEnv) {
            console.warn(`⚠️ 环境不一致警告:`);
            console.warn(`   NODE_ENV: ${nodeEnv} (期望 Infisical: ${expectedInfisicalEnv})`);
            console.warn(`   INFISICAL_ENV: ${infisicalEnv}`);
            console.warn(`   建议统一设置环境变量以避免配置错误`);

            // prod环境严格检查
            if (nodeEnv === 'prod') {
                const error = new Error('Environment mismatch in production');
                error.isProductionMismatch = true; // 标记为生产环境不匹配错误
                console.error(`❌ 生产环境环境变量不一致，为安全起见停止启动`);
                console.error(`   请设置 INFISICAL_ENV=prod 或移除 INFISICAL_ENV`);
                throw error;
            }
        }

        // 验证环境变量合法性
        const validEnvs = ['dev', 'pre', 'prod', 'test'];
        if (!validEnvs.includes(nodeEnv)) {
            console.warn(`⚠️ 无效的 NODE_ENV: ${nodeEnv}，将使用默认值 'dev'`);
            process.env.NODE_ENV = 'dev';
        }
    }

    // 执行环境验证
    try {
        validateEnvironmentConsistency();
    } catch (error) {
        // 检查是否为生产环境不匹配错误（使用错误标记而非字符串比较）
        if (error.isProductionMismatch || (error.message && error.message.includes('production'))) {
            console.error(`❌ 严重错误: ${error.message}`);
            throw error;
        }
        console.warn(`⚠️ 环境验证失败: ${error.message}`);
    }

    const clientId = process.env.INFISICAL_CLIENT_ID;
    const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
    const projectId = process.env.INFISICAL_PROJECT_ID;

    // 只有当 Infisical 配置存在时才尝试动态拉取
    if (((clientId && clientSecret) || process.env.INFISICAL_TOKEN) && projectId) {
        if (process.env.SKIP_INFISICAL_RUNTIME === 'true') {
            console.log(`ℹ️ Skipping Infisical runtime fetch (SKIP_INFISICAL_RUNTIME=true)`);
        } else if (process.env.NODE_ENV === 'test') {
            console.log(`ℹ️ Skipping Infisical fetch in test environment`);
        } else {
            try {
                const infisicalEnvName = mapNodeEnvToInfisicalEnv(process.env.NODE_ENV || 'dev');
                console.log(`ℹ️ Attempting to fetch Infisical secrets for environment: ${infisicalEnvName} (mapped from NODE_ENV: ${process.env.NODE_ENV || 'dev'})`);
                const secrets = await fetchInfisicalSecrets({
                    clientId,
                    clientSecret,
                    projectId,
                    envName: infisicalEnvName
                });
                
                if (secrets) {
                    for (const key in secrets) {
                        const cleanValue = sanitizeValue(secrets[key]);
                        process.env[key] = cleanValue;
                    }
                }
                console.log(`✅ Successfully fetched Infisical secrets.`);
            } catch (error) {
                console.warn(`⚠️ Infisical fetch failed, falling back to .env or system envs: ${error.message}`);
            }
        }
    }

    const env = process.env;

    config = {
        downloadDir: path.resolve(env.DOWNLOAD_DIR || path.join(os.tmpdir(), 'downloads')),
        apiId: parseInt(env.API_ID) || null,
        apiHash: env.API_HASH || null,
        botToken: env.BOT_TOKEN || null,
        ownerId: env.OWNER_ID || null,
        remoteName: env.RCLONE_REMOTE || null,
        remoteFolder: env.REMOTE_FOLDER || null,
        port: env.PORT || "3000",
        http2: {
            enabled: env.HTTP2_ENABLED === 'true',
            plain: env.HTTP2_PLAIN === 'true',
            allowHttp1: env.HTTP2_ALLOW_HTTP1 !== 'false',
            keyPath: env.HTTP2_TLS_KEY_PATH || env.TLS_KEY_PATH || null,
            certPath: env.HTTP2_TLS_CERT_PATH || env.TLS_CERT_PATH || null
        },
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
            serverDc: parseOptionalInt(env.TG_SERVER_DC),
            serverIp: env.TG_SERVER_IP || null,
            serverPort: parseOptionalInt(env.TG_SERVER_PORT),
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
    console.log(`[Config] NODE_ENV=${process.env.NODE_ENV}, NODE_MODE=${envMode}, Telegram Test Mode: ${config.telegram.testMode}`);
    
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

export function __resetConfigForTests() {
    if (process.env.NODE_ENV !== 'test') {
        return;
    }
    config = null;
    isInitialized = false;
}

export { config };
