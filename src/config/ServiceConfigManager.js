import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

/**
 * 服务配置管理器
 * 负责加载和管理服务配置manifest
 */
class ServiceConfigManager {
    constructor() {
        this.manifest = null;
        this.configServiceMapping = null;
        this.initialized = false;
    }

    /**
     * 初始化配置管理器
     */
    initialize() {
        if (this.initialized) return;
        
        try {
            this.loadManifest();
            this.buildConfigMapping();
            this.initialized = true;
            console.log(`✅ ServiceConfigManager 初始化完成，加载了 ${Object.keys(this.manifest.serviceMappings).length} 个服务`);
        } catch (error) {
            console.warn('⚠️ ServiceConfigManager 初始化失败，使用默认配置:', error.message);
            this.createDefaultManifest();
            this.initialized = true;
        }
    }

    /**
     * 加载服务配置manifest
     */
    loadManifest() {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const manifestPath = path.join(__dirname, 'service-manifest.json');
        
        const manifestContent = readFileSync(manifestPath, 'utf8');
        this.manifest = JSON.parse(manifestContent);
        
        // 验证manifest结构
        if (!this.manifest.serviceMappings) {
            throw new Error('manifest缺少serviceMappings字段');
        }
    }

    /**
     * 构建配置键到服务的反向映射
     */
    buildConfigMapping() {
        this.configServiceMapping = {};
        Object.entries(this.manifest.serviceMappings).forEach(([serviceName, serviceConfig]) => {
            serviceConfig.configKeys.forEach(configKey => {
                this.configServiceMapping[configKey] = serviceName;
            });
        });
    }

    /**
     * 创建默认配置manifest（降级方案）
     */
    createDefaultManifest() {
        this.manifest = {
            serviceMappings: {
                cache: {
                    name: "缓存服务",
                    icon: "💾",
                    description: "多层缓存服务",
                    configKeys: ['REDIS_URL', 'CACHE_PROVIDERS', 'NF_REDIS_URL', 'REDIS_TOKEN'],
                    reinitializationStrategy: {
                        type: "destroy_initialize",
                        graceful: true,
                        timeout: 30000
                    }
                },
                telegram: {
                    name: "Telegram服务",
                    icon: "📱",
                    description: "Telegram客户端管理",
                    configKeys: ['API_ID', 'API_HASH', 'BOT_TOKEN', 'TG_PROXY_HOST', 'TG_PROXY_PORT'],
                    reinitializationStrategy: {
                        type: "lightweight_reconnect",
                        graceful: true,
                        timeout: 60000
                    }
                },
                queue: {
                    name: "队列服务",
                    icon: "📬",
                    description: "消息队列管理",
                    configKeys: ['QSTASH_TOKEN', 'LB_WEBHOOK_URL', 'QSTASH_CURRENT_SIGNING_KEY'],
                    reinitializationStrategy: {
                        type: "destroy_initialize",
                        graceful: true,
                        timeout: 15000
                    }
                }
            },
            criticalServices: ['cache', 'telegram', 'queue'],
            logging: {
                enabled: true,
                emoji: { enabled: true, separator: "🔮", success: "✅", error: "❌" }
            },
            performance: { parallelReinitialization: true }
        };
        
        this.buildConfigMapping();
    }

    /**
     * 根据配置键获取对应的服务名
     */
    getServiceName(configKey) {
        if (!this.initialized) {
            this.initialize();
        }
        return this.configServiceMapping[configKey];
    }

    /**
     * 获取服务配置信息
     */
    getServiceConfig(serviceName) {
        if (!this.initialized) {
            this.initialize();
        }
        return this.manifest.serviceMappings[serviceName];
    }

    /**
     * 获取所有服务映射
     */
    getAllServiceMappings() {
        if (!this.initialized) {
            this.initialize();
        }
        return this.configServiceMapping;
    }

    /**
     * 获取关键服务列表
     */
    getCriticalServices() {
        if (!this.initialized) {
            this.initialize();
        }
        return this.manifest.criticalServices || [];
    }

    /**
     * 获取健康检查配置
     */
    getHealthCheckConfig() {
        if (!this.initialized) {
            this.initialize();
        }
        return this.manifest.healthChecks || {};
    }

    /**
     * 获取日志配置
     */
    getLoggingConfig() {
        if (!this.initialized) {
            this.initialize();
        }
        return this.manifest.logging || {};
    }

    /**
     * 获取性能配置
     */
    getPerformanceConfig() {
        if (!this.initialized) {
            this.initialize();
        }
        return this.manifest.performance || {};
    }

    /**
     * 获取错误处理配置
     */
    getErrorHandlingConfig() {
        if (!this.initialized) {
            this.initialize();
        }
        return this.manifest.errorHandling || {};
    }

    /**
     * 根据配置变更获取受影响的服务列表
     */
    getAffectedServices(changes) {
        if (!this.initialized) {
            this.initialize();
        }
        
        const affectedServices = new Set();
        changes.forEach(change => {
            const serviceName = this.configServiceMapping[change.key];
            if (serviceName) {
                affectedServices.add(serviceName);
            }
        });
        
        return Array.from(affectedServices);
    }

    /**
     * 获取服务的重新初始化策略
     */
    getReinitializationStrategy(serviceName) {
        const serviceConfig = this.getServiceConfig(serviceName);
        return serviceConfig?.reinitializationStrategy || {
            type: 'restart',
            graceful: true,
            timeout: 30000
        };
    }

    /**
     * 检查日志emoji是否启用
     */
    isEmojiEnabled() {
        const loggingConfig = this.getLoggingConfig();
        return loggingConfig.emoji?.enabled !== false;
    }

    /**
     * 获取emoji映射
     */
    getEmojiMapping() {
        const loggingConfig = this.getLoggingConfig();
        return loggingConfig.emoji || {
            separator: '🔮',
            success: '✅',
            warning: '⚠️',
            error: '❌',
            info: '📊',
            progress: '🔄'
        };
    }
}

// 创建单例实例
export const serviceConfigManager = new ServiceConfigManager();

// 为了向后兼容，导出配置映射
export function getConfigServiceMapping() {
    return serviceConfigManager.getAllServiceMappings();
}