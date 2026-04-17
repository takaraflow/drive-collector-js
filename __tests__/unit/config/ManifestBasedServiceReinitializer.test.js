import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ManifestBasedServiceReinitializer } from '../../../src/config/ManifestBasedServiceReinitializer.js';
import { serviceConfigManager } from '../../../src/config/ServiceConfigManager.js';
import { getConfig } from '../../../src/config/index.js';

vi.mock('../../../src/config/ServiceConfigManager.js', () => ({
    serviceConfigManager: {
        getReinitializationStrategy: vi.fn(),
        getServiceConfig: vi.fn(),
        getEmojiMapping: vi.fn(() => ({ success: '✅', error: '❌' }))
    }
}));

vi.mock('../../../src/config/index.js', () => ({
    getConfig: vi.fn()
}));

// Mock dynamic imports
vi.mock('../../../src/services/CacheService.js', () => ({ cache: { name: 'cache' } }));
vi.mock('../../../src/services/QueueService.js', () => ({ queueService: { name: 'queue' } }));
vi.mock('../../../src/services/logger/LoggerService.js', () => ({ logger: { name: 'logger' } }));
vi.mock('../../../src/services/telegram.js', () => ({ default: { name: 'telegram' } }));
vi.mock('../../../src/services/oss.js', () => ({ oss: { name: 'oss' } }));
vi.mock('../../../src/services/d1.js', () => ({ d1: { name: 'd1' } }));
vi.mock('../../../src/services/InstanceCoordinator.js', () => ({ instanceCoordinator: { name: 'instanceCoordinator' } }));

describe('ManifestBasedServiceReinitializer', () => {
    let reinitializer;

    beforeEach(() => {
        reinitializer = new ManifestBasedServiceReinitializer();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('initializeServices', () => {
        it('should import and set services correctly', async () => {
            await reinitializer.initializeServices();
            expect(reinitializer.services.get('cache')).toBeDefined();
            expect(reinitializer.services.get('queue')).toBeDefined();
            expect(reinitializer.services.get('logger')).toBeDefined();
            expect(reinitializer.services.get('telegram')).toBeDefined();
            expect(reinitializer.services.get('oss')).toBeDefined();
            expect(reinitializer.services.get('d1')).toBeDefined();
            expect(reinitializer.services.get('instanceCoordinator')).toBeDefined();
        });

        it('should handle import errors gracefully', async () => {
            // Force an error by overriding a module temporarily or injecting a faulty mock.
            // Since modules are statically mocked, testing dynamic import failure is tricky without `vi.resetModules()`.
            // Instead, we can mock `this.services.set` to throw.
            vi.spyOn(reinitializer.services, 'set').mockImplementationOnce(() => {
                throw new Error('Import error');
            });
            await reinitializer.initializeServices();
            expect(console.warn).toHaveBeenCalledWith('⚠️ 部分服务模块导入失败:', 'Import error');
        });
    });

    describe('reinitializeService', () => {
        it('should throw if service does not exist', async () => {
            await expect(reinitializer.reinitializeService('unknown')).rejects.toThrow('Unknown service: unknown');
        });

        it('should fetch strategy and execute it for existing service', async () => {
            reinitializer.services.set('test-service', { test: true });
            serviceConfigManager.getReinitializationStrategy.mockReturnValue({ type: 'restart' });
            vi.spyOn(reinitializer, 'executeReinitializationStrategy').mockResolvedValue();
            vi.spyOn(reinitializer, 'logServiceReinitialization').mockImplementation(() => {});

            const result = await reinitializer.reinitializeService('test-service');

            expect(result).toBe(true);
            expect(serviceConfigManager.getReinitializationStrategy).toHaveBeenCalledWith('test-service');
            expect(reinitializer.executeReinitializationStrategy).toHaveBeenCalledWith('test-service', { test: true }, { type: 'restart' });
            expect(reinitializer.logServiceReinitialization).toHaveBeenCalledWith('test-service', true);
        });

        it('should log failure and throw if execution fails', async () => {
            reinitializer.services.set('test-service', { test: true });
            serviceConfigManager.getReinitializationStrategy.mockReturnValue({ type: 'restart' });

            const error = new Error('Execution failed');
            vi.spyOn(reinitializer, 'executeReinitializationStrategy').mockRejectedValue(error);
            vi.spyOn(reinitializer, 'logServiceReinitialization').mockImplementation(() => {});

            await expect(reinitializer.reinitializeService('test-service')).rejects.toThrow('Execution failed');
            expect(reinitializer.logServiceReinitialization).toHaveBeenCalledWith('test-service', false, error);
        });
    });

    describe('executeReinitializationStrategy', () => {
        it('should complete before timeout', async () => {
            vi.spyOn(reinitializer, 'performReinitialization').mockResolvedValue('done');
            await expect(reinitializer.executeReinitializationStrategy('test-service', {}, { type: 'restart', timeout: 1000 })).resolves.toBeUndefined();
            expect(reinitializer.performReinitialization).toHaveBeenCalledWith('test-service', {}, 'restart');
        });

        it('should throw if timeout is exceeded', async () => {
            vi.spyOn(reinitializer, 'performReinitialization').mockImplementation(() => new Promise(resolve => setTimeout(resolve, 200)));
            await expect(reinitializer.executeReinitializationStrategy('test-service', {}, { type: 'restart', timeout: 50 }))
                .rejects.toThrow('Service test-service reinitialization timeout after 50ms');
        });
    });

    describe('performReinitialization and specific handlers', () => {
        it('should call destroy_initialize', async () => {
            const service = { destroy: vi.fn(), initialize: vi.fn() };
            await reinitializer.performReinitialization('test-service', service, 'destroy_initialize');
            expect(service.destroy).toHaveBeenCalled();
            expect(service.initialize).toHaveBeenCalled();
        });

        it('should call lightweight_reconnect', async () => {
            const service = { reconnectBot: vi.fn() };
            await reinitializer.performReinitialization('test-service', service, 'lightweight_reconnect');
            expect(service.reconnectBot).toHaveBeenCalledWith(true);
        });

        it('should call reconfigure for logger', async () => {
            const service = { configure: vi.fn() };
            getConfig.mockReturnValue({ test: 'config' });
            await reinitializer.performReinitialization('logger', service, 'reconfigure');
            expect(getConfig).toHaveBeenCalled();
            expect(service.configure).toHaveBeenCalledWith({ test: 'config' });
        });

        it('should call reconfigure for generic service', async () => {
            const service = { configure: vi.fn() };
            await reinitializer.performReinitialization('test-service', service, 'reconfigure');
            expect(service.configure).toHaveBeenCalledWith();
        });

        it('should call reconnect', async () => {
            const service = { reconnect: vi.fn() };
            await reinitializer.performReinitialization('test-service', service, 'reconnect');
            expect(service.reconnect).toHaveBeenCalled();
        });

        it('should call restart for instanceCoordinator', async () => {
            const service = { stop: vi.fn(), start: vi.fn() };
            await reinitializer.performReinitialization('instanceCoordinator', service, 'restart');
            expect(service.stop).toHaveBeenCalled();
            expect(service.start).toHaveBeenCalled();
        });

        it('should call generic fallback', async () => {
            const service = { destroy: vi.fn(), initialize: vi.fn() };
            await reinitializer.performReinitialization('test-service', service, 'unknown_strategy');
            expect(service.destroy).toHaveBeenCalled();
            expect(service.initialize).toHaveBeenCalled();
        });
    });

    describe('logServiceReinitialization', () => {
        it('should log success message', () => {
            serviceConfigManager.getServiceConfig.mockReturnValue({ icon: '✨', name: 'Test Service' });
            reinitializer.logServiceReinitialization('test-service', true);
            expect(console.log).toHaveBeenCalledWith('✨ ✨ Test Service 服务重新初始化成功！');
        });

        it('should log failure message with error', () => {
            serviceConfigManager.getServiceConfig.mockReturnValue({ icon: '✨', name: 'Test Service' });
            reinitializer.logServiceReinitialization('test-service', false, new Error('Test Error'));
            expect(console.log).toHaveBeenCalledWith('❌ ✨ Test Service 服务重新初始化失败: Test Error');
        });

        it('should fallback to defaults if config missing', () => {
            serviceConfigManager.getServiceConfig.mockReturnValue(null);
            reinitializer.logServiceReinitialization('test-service', true);
            expect(console.log).toHaveBeenCalledWith('✨ ✅ test-service 服务重新初始化成功！');
        });
    });
});
