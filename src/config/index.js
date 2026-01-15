import { loadDotenv } from './dotenv.js';
import os from 'os';
import path from 'path';
import fs from 'fs';
import InfisicalSecretsProvider from '../services/secrets/InfisicalSecretsProvider.js';
import { mapNodeEnvToInfisicalEnv, normalizeNodeEnv } from '../utils/envMapper.js';
import { serviceConfigManager } from './ServiceConfigManager.js';
import { ManifestBasedServiceReinitializer } from './ManifestBasedServiceReinitializer.js';

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
// 默认只在 dev 环境允许 .env 覆盖系统环境变量（避免 prod/pre 被空的 .env.* 覆盖导致凭证丢失）
const dotenvOverrideFlag = (process.env.DOTENV_OVERRIDE || '').toLowerCase();
const shouldOverrideEnv = normalizedNodeEnv === 'dev'
    ? dotenvOverrideFlag !== 'false'
    : dotenvOverrideFlag === 'true';

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

function loadManifestEnvKeys() {
    try {
        const manifestPath = path.resolve(process.cwd(), 'manifest.json');
        const raw = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(raw);
        const envConfig = manifest?.config?.env || {};
        return new Set(Object.keys(envConfig));
    } catch (error) {
        return null;
    }
}

function warnUnknownInfisicalKeys(secrets) {
    try {
        if (!secrets || typeof secrets !== 'object') return;
        const manifestKeys = loadManifestEnvKeys();
        if (!manifestKeys) return;

        const secretKeys = Object.keys(secrets);
        const unknown = secretKeys.filter(key => !manifestKeys.has(key));
        if (unknown.length === 0) return;

        console.warn(`⚠️ Infisical returned ${unknown.length} key(s) not present in manifest.json config.env (possible typos or stale secrets):`);
        unknown.slice(0, 30).forEach(key => console.warn(`   - ${key}`));
        if (unknown.length > 30) {
            console.warn(`   ...and ${unknown.length - 30} more`);
        }
    } catch (e) {
        // Do not block startup on validation errors
    }
}

/**
 * 显示配置更新的醒目日志
 */
function logConfigurationUpdate(changes, affectedServices) {
    const separator = '🔮'.repeat(25);
    console.log('\n' + separator);
    console.log('🚀☁️🌩️  云端配置更新检测到！  🌩️☁️🚀');
    console.log(separator);
    
    // 更新统计
    console.log('📊 配置更新摘要:');
    console.log(`   🔄 总变更数: ${changes.length}`);
    console.log(`   📦 新增配置: ${changes.filter(c => c.oldValue === undefined).length}`);
    console.log(`   ✏️  修改配置: ${changes.filter(c => c.oldValue !== undefined && c.newValue !== undefined).length}`);
    console.log(`   🗑️  删除配置: ${changes.filter(c => c.newValue === undefined).length}`);
    
    // 详细变更
    console.log('\n⬇️ 详细配置变更:');
    changes.forEach((change, index) => {
        const icon = change.newValue === undefined ? '🗑️' : 
                     change.oldValue === undefined ? '📦' : '✏️';
        const action = change.newValue === undefined ? '删除' : 
                      change.oldValue === undefined ? '新增' : '修改';
        
        console.log(`   ${index + 1}. ${icon} ${change.key} (${action})`);
        if (change.newValue !== undefined) {
            console.log(`      ${change.oldValue || '(空)'} → ${change.newValue}`);
        } else {
            console.log(`      ${change.oldValue} → (已删除)`);
        }
    });
    
    // 影响的服务
    if (affectedServices.length > 0) {
        console.log('\n🎯 需要重新初始化的服务:');
        affectedServices.forEach((service, index) => {
            const icons = {
                cache: '💾',
                telegram: '📱',
                queue: '📬',
                logger: '📝',
                oss: '☁️',
                d1: '🗄️',
                instanceCoordinator: '🏗️'
            };
            console.log(`   ${index + 1}. ${icons[service] || '⚙️'} ${service}`);
        });
    }
    
    console.log(separator);
}

/**
 * 显示服务重新初始化的醒目日志
 */
function logServiceReinitialization(serviceName, success, error = null) {
    const icons = {
        cache: '💾',
        telegram: '📱', 
        queue: '📬',
        logger: '📝',
        oss: '☁️',
        d1: '🗄️',
        instanceCoordinator: '🏗️'
    };
    
    const icon = icons[serviceName] || '⚙️';
    
    if (success) {
        console.log(`✨ ${icon} ${serviceName} 服务重新初始化成功！`);
    } else {
        console.log(`❌ ${icon} ${serviceName} 服务重新初始化失败: ${error?.message || '未知错误'}`);
    }
}



/**
 * 验证关键服务健康状态
 */
async function validateCriticalServices() {
    const criticalServices = serviceConfigManager.getCriticalServices();
    const healthCheckConfig = serviceConfigManager.getHealthCheckConfig();
    const emojiMapping = serviceConfigManager.getEmojiMapping();
    
    for (const serviceName of criticalServices) {
        try {
            let isHealthy = false;
            
            switch (serviceName) {
                case 'cache':
                    try {
                        const { cache } = await import('../services/CacheService.js');
                        isHealthy = cache && typeof cache.ping === 'function' ? await cache.ping() : true;
                    } catch (error) {
                        isHealthy = false;
                    }
                    break;
                case 'telegram':
                    try {
                        const telegramModule = await import('../services/telegram.js');
                        const { getTelegramStatus } = telegramModule;
                        if (getTelegramStatus) {
                            const status = await getTelegramStatus();
                            isHealthy = status && status.connected;
                        }
                    } catch (error) {
                        isHealthy = false;
                    }
                    break;
                case 'queue':
                    try {
                        const { queueService } = await import('../services/QueueService.js');
                        isHealthy = queueService && typeof queueService.getCircuitBreakerStatus === 'function';
                    } catch (error) {
                        isHealthy = false;
                    }
                    break;
            }
            
            const emojiMapping = serviceConfigManager.getEmojiMapping();
            const icon = isHealthy ? (emojiMapping.success || '✅') : (emojiMapping.error || '❌');
            const serviceConfig = serviceConfigManager.getServiceConfig(serviceName);
            const displayName = serviceConfig?.name || serviceName;
            console.log(`   ${icon} ${displayName} (${serviceName}) 健康检查: ${isHealthy ? '正常' : '异常'}`);
            
            if (!isHealthy) {
                console.warn(`${emojiMapping.warning || '⚠️'} 警告: ${displayName} 服务可能需要手动干预`);
            }
            
        } catch (error) {
            console.error(`❌ ${serviceName} 健康检查失败:`, error.message);
        }
    }
}

export async function initConfig() {
    if (isInitialized) return config;

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
                
                // 使用新的 InfisicalSecretsProvider
                const provider = new InfisicalSecretsProvider({
                    token: process.env.INFISICAL_TOKEN,
                    clientId: clientId,
                    clientSecret: clientSecret,
                    projectId: projectId,
                    envName: infisicalEnvName
                });
                
                // 首次拉取
                const secrets = await provider.fetchSecrets();
                
                if (secrets) {
                    warnUnknownInfisicalKeys(secrets);
                    for (const key in secrets) {
                        const cleanValue = sanitizeValue(secrets[key]);
                        process.env[key] = cleanValue;
                    }
                }
                console.log(`✅ Successfully fetched Infisical secrets.`);
                
                // 启动轮询（可配置）
                const pollingEnabled = process.env.INFISICAL_POLLING_ENABLED === 'true';
                if (pollingEnabled) {
                    const pollInterval = parseInt(process.env.INFISICAL_POLLING_INTERVAL) || 300000;
                    
                    // 监听配置变更
                    provider.on('configChanged', async (changes) => {
                        // 确保ServiceConfigManager已初始化
                        serviceConfigManager.initialize();
                        
                        // 1. 分析变更，确定受影响的服务
                        const affectedServices = serviceConfigManager.getAffectedServices(changes);
                        
                        // 2. 显示醒目的配置更新日志
                        logConfigurationUpdate(changes, affectedServices);
                        
                        // 3. 更新环境变量
                        changes.forEach(change => {
                            if (change.newValue !== undefined) {
                                const cleanValue = sanitizeValue(change.newValue);
                                process.env[change.key] = cleanValue;
                            } else {
                                delete process.env[change.key];
                            }
                        });
                        
                        // 4. 重新初始化受影响的服务
                        if (affectedServices.length > 0) {
                            console.log('\n🔄 开始重新初始化受影响的服务...');
                            
                            const reinitializer = new ManifestBasedServiceReinitializer();
                            await reinitializer.initializeServices();
                            
                            // 并行重新初始化所有受影响的服务
                            const reinitPromises = Array.from(affectedServices).map(async serviceName => {
                                try {
                                    await reinitializer.reinitializeService(serviceName);
                                    return { service: serviceName, success: true };
                                } catch (error) {
                                    console.error(`重新初始化 ${serviceName} 失败:`, error);
                                    return { service: serviceName, success: false, error };
                                }
                            });
                            
                            const reinitResults = await Promise.allSettled(reinitPromises);
                            
                            // 5. 显示重新初始化结果摘要
                            console.log('\n📋 服务重新初始化结果:');
                            reinitResults.forEach((result, index) => {
                                if (result.status === 'fulfilled') {
                                    const { service, success, error } = result.value;
                                    const status = success ? '✅' : '❌';
                                    console.log(`   ${status} ${service}`);
                                } else {
                                    console.log(`   ❌ 未知服务: ${result.reason?.message || '未知错误'}`);
                                }
                            });
                            
                            // 6. 验证关键服务健康状态
                            console.log('\n🔍 验证关键服务健康状态...');
                            await validateCriticalServices();
                            
                            console.log('\n' + '🔮'.repeat(25) + '\n');
                        }
                    });
                    
                    // 启动轮询
                    provider.startPolling(pollInterval);
                    console.log(`🚀 Infisical polling started (interval: ${pollInterval}ms)`);
                }
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
            accountId: env.CLOUDFLARE_KV_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || null,
            namespaceId: env.CLOUDFLARE_KV_NAMESPACE_ID || null,
            token: env.CLOUDFLARE_KV_TOKEN || null
        },
        qstash: {
            // Prefer the new v2 token, but keep backward compatibility with legacy naming.
            token: env.QSTASH_TOKEN || env.QSTASH_AUTH_TOKEN || null,
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
            accountId: env.CLOUDFLARE_D1_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID || null,
            databaseId: env.CLOUDFLARE_D1_DATABASE_ID || null,
            token: env.CLOUDFLARE_D1_TOKEN || null
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
        },
        tunnel: {
            enabled: env.TUNNEL_ENABLED === 'true',
            provider: env.TUNNEL_PROVIDER || 'cloudflare',
            metricsPort: parseInt(env.TUNNEL_METRICS_PORT) || 2000,
            metricsHost: env.TUNNEL_METRICS_HOST || '127.0.0.1'
        },
        streamForwarding: {
            enabled: env.STREAM_FORWARDING_ENABLED === 'true',
            secret: env.INSTANCE_SECRET || 'default_secret',
            externalUrl: env.APP_EXTERNAL_URL || null,
            lbUrl: env.LB_WEBHOOK_URL || env.APP_EXTERNAL_URL || null
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