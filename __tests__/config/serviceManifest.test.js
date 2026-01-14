import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { serviceConfigManager } from '../../src/config/ServiceConfigManager.js';
import { ManifestBasedServiceReinitializer } from '../../src/config/ManifestBasedServiceReinitializer.js';

describe('ServiceConfigManager 测试', () => {
    beforeEach(() => {
        // 重置单例
        serviceConfigManager.initialized = false;
        serviceConfigManager.manifest = null;
        serviceConfigManager.configServiceMapping = null;
        
        // Mock console
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('应该成功加载service manifest', () => {
        serviceConfigManager.initialize();
        
        expect(serviceConfigManager.initialized).toBe(true);
        expect(serviceConfigManager.manifest).toBeDefined();
        expect(serviceConfigManager.configServiceMapping).toBeDefined();
        
        // 验证服务数量
        const serviceCount = Object.keys(serviceConfigManager.manifest.serviceMappings).length;
        expect(serviceCount).toBeGreaterThan(5);
    });

    test('应该正确映射配置键到服务', () => {
        serviceConfigManager.initialize();
        
        // 测试一些关键映射
        expect(serviceConfigManager.getServiceName('REDIS_URL')).toBe('cache');
        expect(serviceConfigManager.getServiceName('API_ID')).toBe('telegram');
        expect(serviceConfigManager.getServiceName('QSTASH_TOKEN')).toBe('queue');
        expect(serviceConfigManager.getServiceName('AXIOM_TOKEN')).toBe('logger');
        expect(serviceConfigManager.getServiceName('UNKNOWN_KEY')).toBeUndefined();
    });

    test('应该正确识别受影响的服务', () => {
        serviceConfigManager.initialize();
        
        const changes = [
            { key: 'REDIS_URL', oldValue: 'old', newValue: 'new' },
            { key: 'API_ID', oldValue: '123', newValue: '456' },
            { key: 'QSTASH_TOKEN', oldValue: undefined, newValue: 'token' },
            { key: 'UNKNOWN_KEY', oldValue: 'old', newValue: 'new' }
        ];
        
        const affectedServices = serviceConfigManager.getAffectedServices(changes);
        
        expect(affectedServices).toContain('cache');
        expect(affectedServices).toContain('telegram');
        expect(affectedServices).toContain('queue');
        expect(affectedServices).toHaveLength(3);
    });

    test('应该正确获取服务配置', () => {
        serviceConfigManager.initialize();
        
        const cacheConfig = serviceConfigManager.getServiceConfig('cache');
        expect(cacheConfig).toBeDefined();
        expect(cacheConfig.name).toBe('缓存服务');
        expect(cacheConfig.icon).toBe('💾');
        expect(cacheConfig.configKeys).toContain('REDIS_URL');
        expect(cacheConfig.reinitializationStrategy).toBeDefined();
    });

    test('应该正确获取重新初始化策略', () => {
        serviceConfigManager.initialize();
        
        const cacheStrategy = serviceConfigManager.getReinitializationStrategy('cache');
        expect(cacheStrategy.type).toBe('destroy_initialize');
        expect(cacheStrategy.graceful).toBe(true);
        expect(cacheStrategy.timeout).toBe(30000);
        
        const telegramStrategy = serviceConfigManager.getReinitializationStrategy('telegram');
        expect(telegramStrategy.type).toBe('lightweight_reconnect');
        expect(telegramStrategy.timeout).toBe(60000);
    });

    test('应该正确获取关键服务列表', () => {
        serviceConfigManager.initialize();
        
        const criticalServices = serviceConfigManager.getCriticalServices();
        expect(criticalServices).toContain('cache');
        expect(criticalServices).toContain('telegram');
        expect(criticalServices).toContain('queue');
    });

    test('应该正确获取日志配置', () => {
        serviceConfigManager.initialize();
        
        const loggingConfig = serviceConfigManager.getLoggingConfig();
        expect(loggingConfig.enabled).toBe(true);
        expect(loggingConfig.showDetails).toBe(true);
        expect(loggingConfig.emoji).toBeDefined();
        expect(loggingConfig.emoji.enabled).toBe(true);
    });

    test('应该正确获取性能配置', () => {
        serviceConfigManager.initialize();
        
        const performanceConfig = serviceConfigManager.getPerformanceConfig();
        expect(performanceConfig.parallelReinitialization).toBe(true);
        expect(performanceConfig.maxConcurrentServices).toBe(10);
    });

    test('应该正确获取emoji映射', () => {
        serviceConfigManager.initialize();
        
        const emojiMapping = serviceConfigManager.getEmojiMapping();
        expect(emojiMapping.separator).toBe('🔮');
        expect(emojiMapping.success).toBe('✅');
        expect(emojiMapping.error).toBe('❌');
        expect(emojiMapping.warning).toBe('⚠️');
    });
});

describe('ManifestBasedServiceReinitializer 测试', () => {
    let reinitializer;
    let consoleSpy;

    beforeEach(() => {
        reinitializer = new ManifestBasedServiceReinitializer();
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('应该成功创建实例', () => {
        expect(reinitializer).toBeDefined();
        expect(reinitializer.services).toBeDefined();
        expect(reinitializer.services.size).toBe(0);
    });

    test('应该正确记录重新初始化成功日志', () => {
        // 初始化serviceConfigManager
        serviceConfigManager.initialize();
        
        reinitializer.logServiceReinitialization('cache', true);
        
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('✨ 💾 缓存服务 服务重新初始化成功！')
        );
    });

    test('应该正确记录重新初始化失败日志', () => {
        // 初始化serviceConfigManager
        serviceConfigManager.initialize();
        
        const error = new Error('测试错误');
        reinitializer.logServiceReinitialization('cache', false, error);
        
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('❌ 💾 缓存服务 服务重新初始化失败: 测试错误')
        );
    });

    test('应该正确处理不同类型的重新初始化策略', async () => {
        // 模拟服务
        const mockService = {
            destroy: vi.fn(),
            initialize: vi.fn(),
            reconnect: vi.fn(),
            configure: vi.fn()
        };

        // 测试destroy_initialize策略
        await reinitializer.performReinitialization('cache', mockService, 'destroy_initialize');
        expect(mockService.destroy).toHaveBeenCalled();
        expect(mockService.initialize).toHaveBeenCalled();

        // 重置mock
        vi.clearAllMocks();

        // 测试reconnect策略
        await reinitializer.performReinitialization('d1', mockService, 'reconnect');
        expect(mockService.reconnect).toHaveBeenCalled();
        expect(mockService.destroy).not.toHaveBeenCalled();
        expect(mockService.initialize).not.toHaveBeenCalled();
    });

    test('应该正确处理超时', async () => {
        const mockService = {
            destroy: vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 2000))),
            initialize: vi.fn()
        };

        // 设置一个很短的超时时间来测试超时机制
        serviceConfigManager.initialize();
        const strategy = { type: 'destroy_initialize', timeout: 100 };

        await expect(
            reinitializer.executeReinitializationStrategy('cache', mockService, strategy)
        ).rejects.toThrow('Service cache reinitialization timeout after 100ms');
    });
});

describe('配置更新的完整流程测试', () => {
    beforeEach(() => {
        serviceConfigManager.initialized = false;
        serviceConfigManager.manifest = null;
        serviceConfigManager.configServiceMapping = null;
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('应该正确处理完整的配置更新流程', async () => {
        // 初始化
        serviceConfigManager.initialize();
        
        // 模拟配置变更
        const changes = [
            { key: 'REDIS_URL', oldValue: 'redis://old:6379', newValue: 'redis://new:6379' },
            { key: 'API_ID', oldValue: '123456', newValue: '789012' },
            { key: 'QSTASH_TOKEN', oldValue: undefined, newValue: 'new-token' }
        ];
        
        // 1. 识别受影响的服务
        const affectedServices = serviceConfigManager.getAffectedServices(changes);
        expect(affectedServices).toEqual(['cache', 'telegram', 'queue']);
        
        // 2. 获取重新初始化策略
        const strategies = affectedServices.map(service => ({
            service,
            strategy: serviceConfigManager.getReinitializationStrategy(service)
        }));
        
        expect(strategies).toEqual(expect.arrayContaining([
            expect.objectContaining({
                service: 'cache',
                strategy: expect.objectContaining({ type: 'destroy_initialize' })
            }),
            expect.objectContaining({
                service: 'telegram',
                strategy: expect.objectContaining({ type: 'lightweight_reconnect' })
            }),
            expect.objectContaining({
                service: 'queue',
                strategy: expect.objectContaining({ type: 'destroy_initialize' })
            })
        ]));
        
        // 3. 验证日志配置
        const loggingConfig = serviceConfigManager.getLoggingConfig();
        expect(loggingConfig.enabled).toBe(true);
        expect(loggingConfig.showAffectedServices).toBe(true);
        expect(loggingConfig.showDetails).toBe(true);
    });
});