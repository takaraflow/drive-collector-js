/**
 * 基于manifest配置的服务重新初始化器
 */
import { serviceConfigManager } from './ServiceConfigManager.js';
import { getConfig } from './index.js';

export class ManifestBasedServiceReinitializer {
    constructor() {
        this.services = new Map();
    }

    async initializeServices() {
        // 导入服务实例
        try {
            const { cache } = await import('../services/CacheService.js');
            const { queueService } = await import('../services/QueueService.js');
            const { logger } = await import('../services/logger/LoggerService.js');
            const telegramModule = await import('../services/telegram.js');
            const { oss } = await import('../services/oss.js');
            const { d1 } = await import('../services/d1.js');
            const { instanceCoordinator } = await import('../services/InstanceCoordinator.js');
            
            this.services.set('cache', cache);
            this.services.set('queue', queueService);
            this.services.set('logger', logger);
            this.services.set('telegram', telegramModule);
            this.services.set('oss', oss);
            this.services.set('d1', d1);
            this.services.set('instanceCoordinator', instanceCoordinator);
        } catch (error) {
            console.warn('⚠️ 部分服务模块导入失败:', error.message);
        }
    }
    
    async reinitializeService(serviceName) {
        const service = this.services.get(serviceName);
        if (!service) {
            throw new Error(`Unknown service: ${serviceName}`);
        }
        
        try {
            // 从manifest获取重新初始化策略
            const strategy = serviceConfigManager.getReinitializationStrategy(serviceName);
            
            // 根据策略执行重新初始化
            await this.executeReinitializationStrategy(serviceName, service, strategy);
            
            this.logServiceReinitialization(serviceName, true);
            return true;
        } catch (error) {
            this.logServiceReinitialization(serviceName, false, error);
            throw error;
        }
    }

    async executeReinitializationStrategy(serviceName, service, strategy) {
        const { type, timeout = 30000 } = strategy;
        
        // 设置超时
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Service ${serviceName} reinitialization timeout after ${timeout}ms`)), timeout);
        });
        
        const reinitializationPromise = this.performReinitialization(serviceName, service, type);
        
        await Promise.race([reinitializationPromise, timeoutPromise]);
    }

    async performReinitialization(serviceName, service, strategyType) {
        switch (strategyType) {
            case 'destroy_initialize':
                await this.reinitializeDestroyInitialize(service);
                break;
            case 'lightweight_reconnect':
                await this.reinitializeLightweightReconnect(service);
                break;
            case 'reconfigure':
                await this.reinitializeReconfigure(service, serviceName);
                break;
            case 'reconnect':
                await this.reinitializeReconnect(service);
                break;
            case 'restart':
                await this.initializeRestart(service, serviceName);
                break;
            default:
                await this.genericReinitialize(service, serviceName);
        }
    }

    async reinitializeDestroyInitialize(service) {
        if (service.destroy && service.initialize) {
            await service.destroy();
            await service.initialize();
        }
    }

    async reinitializeLightweightReconnect(service) {
        // 轻量级重连
        const { reconnectBot } = service;
        if (reconnectBot) {
            await reconnectBot(true); // lightweight reconnect
        }
    }

    async reinitializeReconfigure(service, serviceName) {
        if (serviceName === 'logger') {
            const currentConfig = getConfig();
            if (service.configure) {
                await service.configure(currentConfig);
            }
        } else if (service.configure) {
            await service.configure();
        }
    }

    async reinitializeReconnect(service) {
        if (service.reconnect) {
            await service.reconnect();
        }
    }

    async initializeRestart(service, serviceName) {
        // 重新注册实例
        if (serviceName === 'instanceCoordinator') {
            if (service.stop && service.start) {
                await service.stop();
                await service.start();
            }
        }
    }
    
    async genericReinitialize(service, serviceName) {
        // 通用重新初始化逻辑
        if (typeof service.destroy === 'function') {
            await service.destroy();
        }
        if (typeof service.initialize === 'function') {
            await service.initialize();
        }
    }

    /**
     * 显示服务重新初始化的醒目日志（基于manifest配置）
     */
    logServiceReinitialization(serviceName, success, error = null) {
        const serviceConfig = serviceConfigManager.getServiceConfig(serviceName);
        const emojiMapping = serviceConfigManager.getEmojiMapping();
        
        const icon = serviceConfig?.icon || (emojiMapping.success || '✅');
        const displayName = serviceConfig?.name || serviceName;
        
        if (success) {
            console.log(`✨ ${icon} ${displayName} 服务重新初始化成功！`);
        } else {
            console.log(`❌ ${icon} ${displayName} 服务重新初始化失败: ${error?.message || '未知错误'}`);
        }
    }
}