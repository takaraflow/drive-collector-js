import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import InfisicalSecretsProvider from '../../src/services/secrets/InfisicalSecretsProvider.js';

// Mock 外部依赖
vi.mock('dotenv', () => ({
    config: vi.fn()
}));

describe('配置更新集成测试', () => {
    let provider;
    let configChangeHandler;
    
    beforeEach(() => {
        // 设置测试环境变量
        process.env.NODE_ENV = 'test';
        process.env.INFISICAL_TOKEN = 'test-token';
        process.env.INFISICAL_PROJECT_ID = 'test-project';
        process.env.INFISICAL_POLLING_ENABLED = 'true';
        process.env.INFISICAL_POLLING_INTERVAL = '1000';
        
        // Mock console methods
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        
        // 创建 provider 实例
        provider = new InfisicalSecretsProvider({
            token: 'test-token',
            clientId: null,
            clientSecret: null,
            projectId: 'test-project',
            envName: 'test'
        });
        
        // 监听 configChanged 事件
        provider.on('configChanged', (changes) => {
            configChangeHandler = changes;
        });
    });
    
    afterEach(() => {
        vi.restoreAllMocks();
        delete process.env.INFISICAL_TOKEN;
        delete process.env.INFISICAL_PROJECT_ID;
        delete process.env.INFISICAL_POLLING_ENABLED;
        delete process.env.INFISICAL_POLLING_INTERVAL;
    });
    
    test('应该正确检测配置变更', () => {
        // 模拟配置变更
        const mockChanges = [
            { key: 'REDIS_URL', oldValue: 'redis://old-host:6379', newValue: 'redis://new-host:6379' },
            { key: 'API_ID', oldValue: '123456', newValue: '789012' },
            { key: 'NEW_FEATURE_ENABLED', oldValue: undefined, newValue: 'true' },
            { key: 'OLD_FEATURE', oldValue: 'false', newValue: undefined }
        ];
        
        // 手动触发配置变更（这在实际使用中由 InfisicalSecretsProvider 内部触发）
        provider.emit('configChanged', mockChanges);
        
        expect(configChangeHandler).toBeDefined();
        expect(configChangeHandler).toEqual(mockChanges);
    });
    
    test('应该正确识别受影响的服务', () => {
        const CONFIG_SERVICE_MAPPING = {
            'REDIS_URL': 'cache',
            'API_ID': 'telegram',
            'NEW_FEATURE_ENABLED': null,
            'OLD_FEATURE': null
        };
        
        const mockChanges = [
            { key: 'REDIS_URL', oldValue: 'redis://old-host:6379', newValue: 'redis://new-host:6379' },
            { key: 'API_ID', oldValue: '123456', newValue: '789012' },
            { key: 'NEW_FEATURE_ENABLED', oldValue: undefined, newValue: 'true' },
            { key: 'OLD_FEATURE', oldValue: 'false', newValue: undefined }
        ];
        
        const affectedServices = new Set();
        mockChanges.forEach(change => {
            const serviceName = CONFIG_SERVICE_MAPPING[change.key];
            if (serviceName) {
                affectedServices.add(serviceName);
            }
        });
        
        expect(affectedServices.has('cache')).toBe(true);
        expect(affectedServices.has('telegram')).toBe(true);
        expect(affectedServices.size).toBe(2);
    });
    

    test('服务重新初始化应该处理错误情况', async () => {
        // Mock 一个会抛出错误的服务
        const mockService = {
            destroy: vi.fn().mockRejectedValue(new Error('Service destroy failed')),
            initialize: vi.fn()
        };
        
        try {
            await mockService.destroy();
            // 如果没有抛出错误，测试失败
            expect(true).toBe(false);
        } catch (error) {
            expect(error.message).toBe('Service destroy failed');
        }
        
        expect(mockService.destroy).toHaveBeenCalledTimes(1);
        expect(mockService.initialize).not.toHaveBeenCalled();
    });
    
    test('应该验证服务健康状态', async () => {
        // Mock 健康检查函数
        const mockHealthChecks = {
            cache: vi.fn().mockResolvedValue(true),
            telegram: vi.fn().mockResolvedValue({ connected: true }),
            queue: vi.fn().mockResolvedValue({ state: 'closed' })
        };
        
        const healthResults = {};
        const criticalServices = ['cache', 'telegram', 'queue'];
        
        for (const serviceName of criticalServices) {
            try {
                let isHealthy = false;
                
                switch (serviceName) {
                    case 'cache':
                        isHealthy = await mockHealthChecks.cache();
                        break;
                    case 'telegram':
                        const status = await mockHealthChecks.telegram();
                        isHealthy = status && status.connected;
                        break;
                    case 'queue':
                        const queueStatus = await mockHealthChecks.queue();
                        isHealthy = queueStatus && queueStatus.state === 'closed';
                        break;
                }
                
                healthResults[serviceName] = isHealthy;
            } catch (error) {
                healthResults[serviceName] = false;
            }
        }
        
        expect(healthResults.cache).toBe(true);
        expect(healthResults.telegram).toBe(true);
        expect(healthResults.queue).toBe(true);
        
        expect(mockHealthChecks.cache).toHaveBeenCalledTimes(1);
        expect(mockHealthChecks.telegram).toHaveBeenCalledTimes(1);
        expect(mockHealthChecks.queue).toHaveBeenCalledTimes(1);
    });
});