import fs from "fs";
import path from "path";

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
        console.warn('⚠️ 测试环境或诊断模式，跳过环境变量验证');
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
        console.warn('⚠️ No complete cache configuration found, cache service may not work properly');
    }
}

// 验证环境变量
const envConfig = validateEnvironment();

import logger from "../services/logger.js";
validateCacheConfig();

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
        token: process.env.QSTASH_TOKEN,
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
        url: (process.env.NF_REDIS_URL && process.env.NF_REDIS_URL.trim() !== '') ? process.env.NF_REDIS_URL : (process.env.REDIS_URL || undefined),
        host: (process.env.NF_REDIS_HOST && process.env.NF_REDIS_HOST.trim() !== '') ? process.env.NF_REDIS_HOST : (process.env.REDIS_HOST || undefined),
        port: parseInt(process.env.NF_REDIS_PORT || process.env.REDIS_PORT || '6379', 10),
        password: (process.env.NF_REDIS_PASSWORD && process.env.NF_REDIS_PASSWORD.trim() !== '') ? process.env.NF_REDIS_PASSWORD : (process.env.REDIS_PASSWORD || undefined),
        tls: {
            enabled: !!process.env.REDIS_TLS_ENABLED || !!process.env.NF_REDIS_TLS_ENABLED || !!process.env.NF_REDIS_URL?.includes('rediss://') || !!process.env.REDIS_URL?.includes('rediss://'),
            rejectUnauthorized: process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false' && process.env.NF_REDIS_TLS_REJECT_UNAUTHORIZED !== 'false',
            ca: process.env.REDIS_TLS_CA || process.env.NF_REDIS_TLS_CA,  // Base64
            cert: process.env.REDIS_TLS_CLIENT_CERT || process.env.NF_REDIS_TLS_CLIENT_CERT,  // Base64
            key: process.env.REDIS_TLS_CLIENT_KEY || process.env.NF_REDIS_TLS_CLIENT_KEY,    // Base64
            servername: process.env.REDIS_SNI_SERVERNAME || process.env.NF_REDIS_SNI_SERVERNAME
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

// Export a function to create a default config for tests
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