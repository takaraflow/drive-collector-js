import fs from "fs";
import path from "path";
import { logger } from "../services/logger.js";

/**
 * --- 1. 基础配置与环境初始化 ---
 */
/**
 * 验证必需的环境变量
 */
function validateEnvironment() {
    const required = [
        { key: 'API_ID', name: 'API_ID' },
        { key: 'API_HASH', name: 'API_HASH' },
        { key: 'BOT_TOKEN', name: 'BOT_TOKEN' }
    ];
    
    // 在测试环境或诊断模式中跳过验证
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'diagnostic') {
        logger.warn('⚠️ 测试环境或诊断模式，跳过环境变量验证');
        return {
            apiId: parseInt(process.env.API_ID || '0'),
            apiHash: process.env.API_HASH || 'test_hash',
            botToken: process.env.BOT_TOKEN || 'test_token'
        };
    }
    
    for (const { key, name } of required) {
        if (!process.env[key]) {
            throw new Error(`Missing required environment variable: ${name}`);
        }
    }
    
    const apiId = parseInt(process.env.API_ID);
    if (isNaN(apiId) || apiId <= 0) {
        throw new Error(`Invalid API_ID: must be a positive number, got '${process.env.API_ID}'`);
    }
    
    return {
        apiId,
        apiHash: process.env.API_HASH,
        botToken: process.env.BOT_TOKEN
    };
}

/**
 * 检查缓存配置是否完整
 */
export function isCacheConfigComplete() {
    const hasCloudflare = !!(process.env.CF_CACHE_ACCOUNT_ID && process.env.CF_CACHE_NAMESPACE_ID && process.env.CF_CACHE_TOKEN);
    const hasRedis = !!(process.env.NF_REDIS_URL || (process.env.NF_REDIS_HOST && process.env.NF_REDIS_PORT));
    const hasUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
    
    return hasCloudflare || hasRedis || hasUpstash;
}

/**
 * 验证缓存配置
 */
function validateCacheConfig() {
    if (!isCacheConfigComplete()) {
        logger.warn('⚠️ No complete cache configuration found, cache service may not work properly');
    }
}

// 验证环境变量
const envConfig = validateEnvironment();

validateCacheConfig();

/**
 * TLS 逻辑判断
 * 规则：如果显式设置了 REDIS_TLS_ENABLED=false，则强制禁用，无论 URL 是什么
 */
const nfRedisUrl = process.env.NF_REDIS_URL || '';
const redisUrl = process.env.REDIS_URL || '';
const isRediss = nfRedisUrl.includes('rediss://') || redisUrl.includes('rediss://');
const forceDisabled = process.env.REDIS_TLS_ENABLED === 'false' || process.env.NF_REDIS_TLS_ENABLED === 'false';
const forceEnabled = process.env.REDIS_TLS_ENABLED === 'true' || process.env.NF_REDIS_TLS_ENABLED === 'true';

// 优先级：强制禁用 > 强制启用 > URL 协议
const tlsEnabled = forceDisabled ? false : (forceEnabled || isRediss);

// 日志输出 TLS 配置决策
if (process.env.NODE_ENV === 'diagnostic' || process.env.NODE_ENV === 'development') {
    logger.debug(`[Config] Redis TLS Decision: forceDisabled=${forceDisabled}, forceEnabled=${forceEnabled}, isRediss=${isRediss} => tlsEnabled=${tlsEnabled}`);
}

export const config = {
    apiId: envConfig.apiId,
    apiHash: envConfig.apiHash,
    botToken: envConfig.botToken,
    ownerId: process.env.OWNER_ID, // 7428626313
    remoteName: process.env.RCLONE_REMOTE || "mega",
    remoteFolder: process.env.REMOTE_FOLDER || "/DriveCollectorBot",
    downloadDir: "/tmp/downloads",
    configPath: "/tmp/rclone.conf",
    port: process.env.PORT || 7860,
    qstash: {
        token: process.env.QSTASH_AUTH_TOKEN || process.env.QSTASH_TOKEN,
        url: process.env.QSTASH_URL,
        webhookUrl: process.env.LB_WEBHOOK_URL
    },
    oss: {
        workerUrl: process.env.OSS_WORKER_URL,
        workerSecret: process.env.OSS_WORKER_SECRET,
        r2: {
            endpoint: process.env.R2_ENDPOINT,
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
            bucket: process.env.R2_BUCKET,
            publicUrl: process.env.R2_PUBLIC_URL
        }
    },
    axiom: {
        token: process.env.AXIOM_TOKEN,
        orgId: process.env.AXIOM_ORG_ID,
        dataset: process.env.AXIOM_DATASET || 'drive-collector',
    },
    redis: {
        url: (process.env.NF_REDIS_URL && process.env.NF_REDIS_URL.trim() !== '') ? process.env.NF_REDIS_URL : ((process.env.REDIS_URL && process.env.REDIS_URL.trim() !== '') ? process.env.REDIS_URL : undefined),
        host: (process.env.NF_REDIS_HOST && process.env.NF_REDIS_HOST.trim() !== '') ? process.env.NF_REDIS_HOST : ((process.env.REDIS_HOST && process.env.REDIS_HOST.trim() !== '') ? process.env.REDIS_HOST : undefined),
        port: (process.env.NF_REDIS_PORT && process.env.NF_REDIS_PORT.trim() !== '') ? parseInt(process.env.NF_REDIS_PORT, 10) : ((process.env.REDIS_PORT && process.env.REDIS_PORT.trim() !== '') ? parseInt(process.env.REDIS_PORT, 10) : 6379),
        password: (process.env.NF_REDIS_PASSWORD && process.env.NF_REDIS_PASSWORD.trim() !== '') ? process.env.NF_REDIS_PASSWORD : 
                 ((process.env.REDIS_PASSWORD && process.env.REDIS_PASSWORD.trim() !== '') ? process.env.REDIS_PASSWORD : 
                 ((process.env.REDIS_TOKEN && process.env.REDIS_TOKEN.trim() !== '') ? process.env.REDIS_TOKEN :
                 ((process.env.UPSTASH_REDIS_REST_TOKEN && process.env.UPSTASH_REDIS_REST_TOKEN.trim() !== '') ? process.env.UPSTASH_REDIS_REST_TOKEN : undefined))),
        tls: {
            enabled: tlsEnabled,
            rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false' && process.env.NF_REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
            ca: (process.env.REDIS_TLS_CA && process.env.REDIS_TLS_CA.trim() !== '') ? process.env.REDIS_TLS_CA : ((process.env.NF_REDIS_TLS_CA && process.env.NF_REDIS_TLS_CA.trim() !== '') ? process.env.NF_REDIS_TLS_CA : undefined),
            cert: (process.env.REDIS_TLS_CLIENT_CERT && process.env.REDIS_TLS_CLIENT_CERT.trim() !== '') ? process.env.REDIS_TLS_CLIENT_CERT : ((process.env.NF_REDIS_TLS_CLIENT_CERT && process.env.NF_REDIS_TLS_CLIENT_CERT.trim() !== '') ? process.env.NF_REDIS_TLS_CLIENT_CERT : undefined),
            key: (process.env.REDIS_TLS_CLIENT_KEY && process.env.REDIS_TLS_CLIENT_KEY.trim() !== '') ? process.env.REDIS_TLS_CLIENT_KEY : ((process.env.NF_REDIS_TLS_CLIENT_KEY && process.env.NF_REDIS_TLS_CLIENT_KEY.trim() !== '') ? process.env.NF_REDIS_TLS_CLIENT_KEY : undefined),
            servername: (process.env.REDIS_SNI_SERVERNAME && process.env.REDIS_SNI_SERVERNAME.trim() !== '') ? process.env.REDIS_SNI_SERVERNAME : ((process.env.NF_REDIS_SNI_SERVERNAME && process.env.NF_REDIS_SNI_SERVERNAME.trim() !== '') ? process.env.NF_REDIS_SNI_SERVERNAME : undefined)
        }
    },
    telegram: {
        proxy: {
            host: process.env.TELEGRAM_PROXY_HOST,
            port: process.env.TELEGRAM_PROXY_PORT,
            type: process.env.TELEGRAM_PROXY_TYPE,
            username: process.env.TELEGRAM_PROXY_USERNAME,
            password: process.env.TELEGRAM_PROXY_PASSWORD,
        }
    }
};

if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });
if (process.env.RCLONE_CONF_BASE64) fs.writeFileSync(config.configPath, Buffer.from(process.env.RCLONE_CONF_BASE64, 'base64'));

// 缓存有效期常量
export const CACHE_TTL = 10 * 60 * 1000; // 缓存有效期 10 分钟

/**
 * 检测缓存提供商可用性
 */
export function detectCacheProviders() {
    const hasCloudflare = !!(process.env.CF_CACHE_ACCOUNT_ID && process.env.CF_CACHE_NAMESPACE_ID && process.env.CF_CACHE_TOKEN);
    const hasRedis = !!(process.env.NF_REDIS_URL || (process.env.NF_REDIS_HOST && process.env.NF_REDIS_PORT));
    const hasUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
    
    return {
        hasCloudflare,
        hasRedis,
        hasUpstash
    };
}

/**
 * 获取 Redis 连接配置
 * 使用原始的 NF Redis URL，保持原样
 */
export function getRedisConnectionConfig() {
    const redisOptions = {
        connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT || '15000', 10),
        keepAlive: parseInt(process.env.REDIS_KEEP_ALIVE || '30000', 10),
        family: 4, // 强制 IPv4 避免 Northflank IPv6 解析问题
        lazyConnect: process.env.REDIS_LAZY_CONNECT !== 'false',
        enableReadyCheck: process.env.REDIS_ENABLE_READY_CHECK !== 'false',
        maxRetriesPerRequest: parseInt(process.env.REDIS_MAX_RETRIES_PER_REQUEST || '5', 10),
        enableAutoPipelining: process.env.REDIS_ENABLE_AUTO_PIPELINING !== 'false',
        retryStrategy: (times) => {
            const maxRetries = parseInt(process.env.REDIS_MAX_RETRIES || '5', 10);
            if (times > maxRetries) {
                return null;
            }
            const baseDelay = parseInt(process.env.REDIS_RETRY_BASE_DELAY || '500', 10);
            const maxDelay = parseInt(process.env.REDIS_RETRY_MAX_DELAY || '30000', 10);
            const delay = Math.min(times * baseDelay, maxDelay);
            return delay;
        },
        reconnectOnError: (err) => {
            const msg = err.message.toLowerCase();
            const shouldReconnect = msg.includes('econnreset') ||
                                   msg.includes('timeout') ||
                                   msg.includes('network') ||
                                   !msg.includes('auth');
            return shouldReconnect;
        }
    };

    // 提取 URL
    const rawUrl = config.redis.url || process.env.NF_REDIS_URL || process.env.REDIS_URL || '';
    let urlString = rawUrl;
    let extractedHost = '';
    let extractedPort = 6379;
    
    if (rawUrl) {
        try {
            // 处理 ioredis 特有的 redis:// 或 rediss:// 格式
            // 如果开启了 TLS 且没有协议头，强制使用 rediss://
            const protocol = config.redis.tls.enabled ? 'rediss://' : 'redis://';
            const normalizedUrl = rawUrl.includes('://') ? rawUrl : `${protocol}${rawUrl}`;
            
            // 关键：如果已经有端口号，不要重复添加
            // 改进：使用更严谨的正则匹配
            const finalUrl = /:\d+$/.test(normalizedUrl) 
                ? normalizedUrl 
                : `${normalizedUrl}:6379`;

            // 更新最终使用的 urlString
            urlString = finalUrl;
            
            const parsed = new URL(finalUrl);
            extractedHost = parsed.hostname;
            extractedPort = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'rediss:' ? 6379 : 6379);
        } catch (e) {
            logger.warn(`[Config] Failed to parse Redis URL: ${rawUrl}`, e.message);
        }
    }

    // TLS 配置决策
    if (config.redis.tls.enabled) {
        // 关键修复：servername 必须正确设置，否则 TLS 握手会失败 (ETIMEDOUT)
        const servername = config.redis.tls.servername || 
                          process.env.NF_REDIS_SNI_SERVERNAME || 
                          process.env.REDIS_SNI_SERVERNAME || 
                          extractedHost || 
                          config.redis.host;

        redisOptions.tls = {
            servername,
            rejectUnauthorized: config.redis.tls.rejectUnauthorized,
            ca: config.redis.tls.ca ? Buffer.from(config.redis.tls.ca, 'base64') : undefined,
            cert: config.redis.tls.cert ? Buffer.from(config.redis.tls.cert, 'base64') : undefined,
            key: config.redis.tls.key ? Buffer.from(config.redis.tls.key, 'base64') : undefined
        };

        // 确保 ioredis 选项中也包含必要的字段
        redisOptions.host = extractedHost || config.redis.host;
        redisOptions.port = extractedPort || config.redis.port;

        if (process.env.NODE_ENV === 'diagnostic' || process.env.DEBUG === 'true') {
            logger.debug(`[Config] Redis TLS detail: rejectUnauthorized=${redisOptions.tls.rejectUnauthorized}, servername=${servername}, host=${redisOptions.host}, port=${redisOptions.port}`);
        }
    }

    // 返回格式统一：{ url, options }
    // 如果有 URL 则优先使用 URL 实例化
    if (urlString) {
        // Northflank 特殊优化
        if (urlString.includes('northflank') || process.env.NF_REDIS_URL) {
            redisOptions.maxRetriesPerRequest = parseInt(process.env.NF_REDIS_MAX_RETRIES_PER_REQUEST || '0', 10);
        }
        
        // 补全 options 中的 host 和 port，确保 CacheService 日志能正确显示
        redisOptions.host = extractedHost || config.redis.host;
        redisOptions.port = extractedPort || config.redis.port;
        
        // 关键修复：如果 URL 中没有密码（Northflank 常见情况），必须从环境变量注入
        // ioredis 优先使用 URL 中的密码，如果 URL 无密码则使用 options.password
        if (config.redis.password) {
            redisOptions.password = config.redis.password;
        }

        return { url: urlString, options: redisOptions };
    }

    // 否则返回 host/port 配置
    return {
        options: {
            ...redisOptions,
            host: config.redis.host,
            port: config.redis.port,
            password: config.redis.password
        }
    };
}

/**
 * 获取 Cloudflare KV 配置
 */
export function getCloudflareKVConfig() {
    const accountId = process.env.CF_CACHE_ACCOUNT_ID || process.env.CF_KV_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
    const namespaceId = process.env.CF_CACHE_NAMESPACE_ID || process.env.CF_KV_NAMESPACE_ID;
    const token = process.env.CF_CACHE_TOKEN || process.env.CF_KV_TOKEN || process.env.CF_D1_TOKEN;
    
    if (!accountId || !namespaceId || !token) {
        return null;
    }
    
    return {
        accountId,
        namespaceId,
        token,
        apiUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}`
    };
}

/**
 * 获取 Upstash Redis 配置
 */
export function getUpstashConfig() {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    
    if (!url || !token) {
        return null;
    }
    
    return {
        url,
        token
    };
}

/**
 * 诊断 Redis 配置
 */
export function diagnoseRedisConfig() {
    const config = getRedisConnectionConfig();
    const providers = detectCacheProviders();
    
    return {
        providers,
        redisConfig: {
            url: config.url,
            host: config.host,
            port: config.port,
            password: config.password ? '***' : undefined,
            tls: config.tls,
            connectTimeout: config.connectTimeout,
            keepAlive: config.keepAlive,
            maxRetriesPerRequest: config.maxRetriesPerRequest
        }
    };
}

/**
 * Export a function to create a default config for tests
 */
export function createDefaultConfig() {
    return {
        redis: {
            url: undefined,
            host: undefined,
            port: 6379,
            password: undefined,
            tls: {
                enabled: false,
                rejectUnauthorized: true,
                ca: undefined,
                cert: undefined,
                key: undefined,
                servername: undefined
            }
        }
    };
}