import fs from "fs";
import path from "path";
import { logger } from "../services/logger.js";
import infisicalClient from "../services/InfisicalClient.js";

/**
 * --- 1. 基础配置与环境初始化 ---
 */

// Global config store
let configStore = null;

/**
 * 验证必需的环境变量
 */
function validateEnvironment(envVars) {
    const required = [
        { key: 'API_ID', name: 'API_ID' },
        { key: 'API_HASH', name: 'API_HASH' },
        { key: 'BOT_TOKEN', name: 'BOT_TOKEN' }
    ];
    
    // 在测试环境或诊断模式中跳过验证
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'diagnostic') {
        logger.warn('⚠️ 测试环境或诊断模式，跳过环境变量验证');
        return {
            apiId: parseInt(envVars.API_ID || '0'),
            apiHash: envVars.API_HASH || 'test_hash',
            botToken: envVars.BOT_TOKEN || 'test_token'
        };
    }
    
    for (const { key, name } of required) {
        if (!envVars[key]) {
            throw new Error(`Missing required environment variable: ${name}`);
        }
    }
    
    const apiId = parseInt(envVars.API_ID);
    if (isNaN(apiId) || apiId <= 0) {
        throw new Error(`Invalid API_ID: must be a positive number, got '${envVars.API_ID}'`);
    }
    
    return {
        apiId,
        apiHash: envVars.API_HASH,
        botToken: envVars.BOT_TOKEN
    };
}

/**
 * 检查缓存配置是否完整
 */
export function isCacheConfigComplete(envVars) {
    const hasCloudflare = !!(envVars.CF_CACHE_ACCOUNT_ID && envVars.CF_CACHE_NAMESPACE_ID && envVars.CF_CACHE_TOKEN);
    const hasRedis = !!(envVars.NF_REDIS_URL || (envVars.NF_REDIS_HOST && envVars.NF_REDIS_PORT));
    const hasUpstash = !!(envVars.UPSTASH_REDIS_REST_URL && envVars.UPSTASH_REDIS_REST_TOKEN);
    
    return hasCloudflare || hasRedis || hasUpstash;
}

/**
 * 验证缓存配置
 */
function validateCacheConfig(envVars) {
    if (!isCacheConfigComplete(envVars)) {
        logger.warn('⚠️ No complete cache configuration found, cache service may not work properly');
    }
}

/**
 * TLS 逻辑判断
 * 规则：如果显式设置了 REDIS_TLS_ENABLED=false，则强制禁用，无论 URL 是什么
 */
function getTlsConfig(envVars) {
    const nfRedisUrl = envVars.NF_REDIS_URL || '';
    const redisUrl = envVars.REDIS_URL || '';
    const isRediss = nfRedisUrl.includes('rediss://') || redisUrl.includes('rediss://');
    const forceDisabled = envVars.REDIS_TLS_ENABLED === 'false' || envVars.NF_REDIS_TLS_ENABLED === 'false';
    const forceEnabled = envVars.REDIS_TLS_ENABLED === 'true' || envVars.NF_REDIS_TLS_ENABLED === 'true';

    // 优先级：强制禁用 > 强制启用 > URL 协议
    const tlsEnabled = forceDisabled ? false : (forceEnabled || isRediss);

    // 日志输出 TLS 配置决策
    if (process.env.NODE_ENV === 'diagnostic' || process.env.NODE_ENV === 'development') {
        logger.debug(`[Config] Redis TLS Decision: forceDisabled=${forceDisabled}, forceEnabled=${forceEnabled}, isRediss=${isRediss} => tlsEnabled=${tlsEnabled}`);
    }

    return tlsEnabled;
}

/**
 * 构建配置对象
 */
function buildConfig(envVars) {
    const tlsEnabled = getTlsConfig(envVars);
    const envConfig = validateEnvironment(envVars);
    validateCacheConfig(envVars);

    return {
        apiId: envConfig.apiId,
        apiHash: envConfig.apiHash,
        botToken: envConfig.botToken,
        ownerId: envVars.OWNER_ID,
        remoteName: envVars.RCLONE_REMOTE || "mega",
        remoteFolder: envVars.REMOTE_FOLDER || "/DriveCollectorBot",
        downloadDir: "/tmp/downloads",
        configPath: "/tmp/rclone.conf",
        port: envVars.PORT || 7860,
        qstash: {
            token: envVars.QSTASH_AUTH_TOKEN || envVars.QSTASH_TOKEN,
            url: envVars.QSTASH_URL,
            webhookUrl: envVars.LB_WEBHOOK_URL
        },
        oss: {
            workerUrl: envVars.OSS_WORKER_URL,
            workerSecret: envVars.OSS_WORKER_SECRET,
            r2: {
                endpoint: envVars.R2_ENDPOINT,
                accessKeyId: envVars.R2_ACCESS_KEY_ID,
                secretAccessKey: envVars.R2_SECRET_ACCESS_KEY,
                bucket: envVars.R2_BUCKET,
                publicUrl: envVars.R2_PUBLIC_URL
            }
        },
        axiom: {
            token: envVars.AXIOM_TOKEN,
            orgId: envVars.AXIOM_ORG_ID,
            dataset: envVars.AXIOM_DATASET || 'drive-collector',
        },
        redis: {
            url: (envVars.NF_REDIS_URL && envVars.NF_REDIS_URL.trim() !== '') ? envVars.NF_REDIS_URL : ((envVars.REDIS_URL && envVars.REDIS_URL.trim() !== '') ? envVars.REDIS_URL : undefined),
            host: (envVars.NF_REDIS_HOST && envVars.NF_REDIS_HOST.trim() !== '') ? envVars.NF_REDIS_HOST : ((envVars.REDIS_HOST && envVars.REDIS_HOST.trim() !== '') ? envVars.REDIS_HOST : undefined),
            port: (envVars.NF_REDIS_PORT && envVars.NF_REDIS_PORT.trim() !== '') ? parseInt(envVars.NF_REDIS_PORT, 10) : ((envVars.REDIS_PORT && envVars.REDIS_PORT.trim() !== '') ? parseInt(envVars.REDIS_PORT, 10) : 6379),
            password: (envVars.NF_REDIS_PASSWORD && envVars.NF_REDIS_PASSWORD.trim() !== '') ? envVars.NF_REDIS_PASSWORD :
                     ((envVars.REDIS_PASSWORD && envVars.REDIS_PASSWORD.trim() !== '') ? envVars.REDIS_PASSWORD :
                     ((envVars.REDIS_TOKEN && envVars.REDIS_TOKEN.trim() !== '') ? envVars.REDIS_TOKEN :
                     ((envVars.UPSTASH_REDIS_REST_TOKEN && envVars.UPSTASH_REDIS_REST_TOKEN.trim() !== '') ? envVars.UPSTASH_REDIS_REST_TOKEN : undefined))),
            tls: {
                enabled: tlsEnabled,
                rejectUnauthorized: envVars.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false' && envVars.NF_REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
                ca: (envVars.REDIS_TLS_CA && envVars.REDIS_TLS_CA.trim() !== '') ? envVars.REDIS_TLS_CA : ((envVars.NF_REDIS_TLS_CA && envVars.NF_REDIS_TLS_CA.trim() !== '') ? envVars.NF_REDIS_TLS_CA : undefined),
                cert: (envVars.REDIS_TLS_CLIENT_CERT && envVars.REDIS_TLS_CLIENT_CERT.trim() !== '') ? envVars.REDIS_TLS_CLIENT_CERT : ((envVars.NF_REDIS_TLS_CLIENT_CERT && envVars.NF_REDIS_TLS_CLIENT_CERT.trim() !== '') ? envVars.NF_REDIS_TLS_CLIENT_CERT : undefined),
                key: (envVars.REDIS_TLS_CLIENT_KEY && envVars.REDIS_TLS_CLIENT_KEY.trim() !== '') ? envVars.REDIS_TLS_CLIENT_KEY : ((envVars.NF_REDIS_TLS_CLIENT_KEY && envVars.NF_REDIS_TLS_CLIENT_KEY.trim() !== '') ? envVars.NF_REDIS_TLS_CLIENT_KEY : undefined),
                servername: (envVars.REDIS_SNI_SERVERNAME && envVars.REDIS_SNI_SERVERNAME.trim() !== '') ? envVars.REDIS_SNI_SERVERNAME : ((envVars.NF_REDIS_SNI_SERVERNAME && envVars.NF_REDIS_SNI_SERVERNAME.trim() !== '') ? envVars.NF_REDIS_SNI_SERVERNAME : undefined)
            }
        },
        telegram: {
            proxy: {
                host: envVars.TELEGRAM_PROXY_HOST,
                port: envVars.TELEGRAM_PROXY_PORT,
                type: envVars.TELEGRAM_PROXY_TYPE,
                username: envVars.TELEGRAM_PROXY_USERNAME,
                password: envVars.TELEGRAM_PROXY_PASSWORD,
            }
        }
    };
}

/**
 * 初始化配置（异步，从 Infisical 获取）
 */
export async function initConfig() {
    if (configStore) {
        logger.warn('⚠️ Config already initialized, skipping...');
        return configStore;
    }

    logger.info('🚀 Initializing configuration...');

    // 获取合并后的环境变量（Infisical + Process Env）
    const envVars = await infisicalClient.getMergedConfig();

    // 构建配置对象
    configStore = buildConfig(envVars);

    // 文件系统操作（保持原有逻辑）
    if (!fs.existsSync(configStore.downloadDir)) fs.mkdirSync(configStore.downloadDir, { recursive: true });
    if (envVars.RCLONE_CONF_BASE64) fs.writeFileSync(configStore.configPath, Buffer.from(envVars.RCLONE_CONF_BASE64, 'base64'));

    logger.info('✅ Configuration initialized');
    return configStore;
}

/**
 * 获取配置（必须先调用 initConfig）
 */
export function getConfig() {
    if (!configStore) {
        if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
            // Check if we can initialize synchronously for tests
            if (process.env.API_ID && process.env.API_HASH && process.env.BOT_TOKEN) {
               try {
                   configStore = buildConfig(process.env);
                   return configStore;
               } catch (e) {
                   // Ignore error and fall back to default
               }
            }
            return createDefaultConfig();
        }
        throw new Error('Config not initialized. Call initConfig() first.');
    }
    return configStore;
}

/**
 * 检测缓存提供商可用性
 */
export function detectCacheProviders() {
    const envVars = configStore ? {
        CF_CACHE_ACCOUNT_ID: process.env.CF_CACHE_ACCOUNT_ID,
        CF_CACHE_NAMESPACE_ID: process.env.CF_CACHE_NAMESPACE_ID,
        CF_CACHE_TOKEN: process.env.CF_CACHE_TOKEN,
        NF_REDIS_URL: process.env.NF_REDIS_URL,
        NF_REDIS_HOST: process.env.NF_REDIS_HOST,
        NF_REDIS_PORT: process.env.NF_REDIS_PORT,
        UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN
    } : process.env;

    const hasCloudflare = !!(envVars.CF_CACHE_ACCOUNT_ID && envVars.CF_CACHE_NAMESPACE_ID && envVars.CF_CACHE_TOKEN);
    const hasRedis = !!(envVars.NF_REDIS_URL || (envVars.NF_REDIS_HOST && envVars.NF_REDIS_PORT));
    const hasUpstash = !!(envVars.UPSTASH_REDIS_REST_URL && envVars.UPSTASH_REDIS_REST_TOKEN);
    
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
    const config = getConfig();
    const envVars = {
        REDIS_CONNECT_TIMEOUT: process.env.REDIS_CONNECT_TIMEOUT,
        REDIS_KEEP_ALIVE: process.env.REDIS_KEEP_ALIVE,
        REDIS_LAZY_CONNECT: process.env.REDIS_LAZY_CONNECT,
        REDIS_ENABLE_READY_CHECK: process.env.REDIS_ENABLE_READY_CHECK,
        REDIS_MAX_RETRIES_PER_REQUEST: process.env.REDIS_MAX_RETRIES_PER_REQUEST,
        REDIS_ENABLE_AUTO_PIPELINING: process.env.REDIS_ENABLE_AUTO_PIPELINING,
        REDIS_MAX_RETRIES: process.env.REDIS_MAX_RETRIES,
        REDIS_RETRY_BASE_DELAY: process.env.REDIS_RETRY_BASE_DELAY,
        REDIS_RETRY_MAX_DELAY: process.env.REDIS_RETRY_MAX_DELAY,
        NF_REDIS_MAX_RETRIES_PER_REQUEST: process.env.NF_REDIS_MAX_RETRIES_PER_REQUEST,
        NF_REDIS_URL: process.env.NF_REDIS_URL,
        NODE_ENV: process.env.NODE_ENV,
        DEBUG: process.env.DEBUG
    };

    const redisOptions = {
        connectTimeout: parseInt(envVars.REDIS_CONNECT_TIMEOUT || '15000', 10),
        keepAlive: parseInt(envVars.REDIS_KEEP_ALIVE || '30000', 10),
        family: 4, // 强制 IPv4 避免 Northflank IPv6 解析问题
        lazyConnect: envVars.REDIS_LAZY_CONNECT !== 'false',
        enableReadyCheck: envVars.REDIS_ENABLE_READY_CHECK !== 'false',
        maxRetriesPerRequest: parseInt(envVars.REDIS_MAX_RETRIES_PER_REQUEST || '5', 10),
        enableAutoPipelining: envVars.REDIS_ENABLE_AUTO_PIPELINING !== 'false',
        retryStrategy: (times) => {
            const maxRetries = parseInt(envVars.REDIS_MAX_RETRIES || '5', 10);
            if (times > maxRetries) {
                return null;
            }
            const baseDelay = parseInt(envVars.REDIS_RETRY_BASE_DELAY || '500', 10);
            const maxDelay = parseInt(envVars.REDIS_RETRY_MAX_DELAY || '30000', 10);
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
    const rawUrl = config.redis.url || envVars.NF_REDIS_URL || '';
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

        if (envVars.NODE_ENV === 'diagnostic' || envVars.DEBUG === 'true') {
            logger.debug(`[Config] Redis TLS detail: rejectUnauthorized=${redisOptions.tls.rejectUnauthorized}, servername=${servername}, host=${redisOptions.host}, port=${redisOptions.port}`);
        }
    }

    // 返回格式统一：{ url, options }
    // 如果有 URL 则优先使用 URL 实例化
    if (urlString) {
        // Northflank 特殊优化
        if (urlString.includes('northflank') || envVars.NF_REDIS_URL) {
            redisOptions.maxRetriesPerRequest = parseInt(envVars.NF_REDIS_MAX_RETRIES_PER_REQUEST || '0', 10);
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
    const config = getConfig();
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
    const config = getConfig();
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

// Legacy export for backward compatibility (synchronous access)
// This will throw if initConfig() hasn't been called
export const CACHE_TTL = 10 * 60 * 1000;
export const config = new Proxy({}, {
    get(target, prop) {
        const cfg = getConfig();
        return cfg[prop];
    },
    set(target, prop, value) {
        // Allow modifying config in test environment
        if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
            const cfg = getConfig();
            cfg[prop] = value;
            return true;
        }
        throw new Error('Cannot modify config directly. Use initConfig() or modify process.env.');
    }
});