
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { serviceConfigManager, getConfigServiceMapping } from '../../../src/config/ServiceConfigManager.js';

vi.mock('fs');

describe('ServiceConfigManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        serviceConfigManager.initialized = false;
        serviceConfigManager.manifest = null;
        serviceConfigManager.configServiceMapping = null;
    });

    it('should initialize successfully with valid manifest', () => {
        const mockManifest = {
            serviceMappings: {
                testService: {
                    name: 'Test Service',
                    configKeys: ['TEST_KEY_1', 'TEST_KEY_2'],
                }
            },
            criticalServices: ['testService'],
            healthChecks: { testService: { method: 'ping' } },
            logging: { enabled: true, emoji: { enabled: true, separator: '🔥' } },
            performance: { maxConcurrentServices: 5 },
            errorHandling: { maxRetries: 3 }
        };

        vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockManifest));

        serviceConfigManager.initialize();

        expect(serviceConfigManager.initialized).toBe(true);
        expect(serviceConfigManager.manifest).toEqual(mockManifest);
        expect(serviceConfigManager.configServiceMapping).toEqual({
            'TEST_KEY_1': 'testService',
            'TEST_KEY_2': 'testService'
        });
    });

    it('should fallback to default manifest if loading fails', () => {
        vi.mocked(readFileSync).mockImplementation(() => {
            throw new Error('File not found');
        });

        serviceConfigManager.initialize();

        expect(serviceConfigManager.initialized).toBe(true);
        expect(serviceConfigManager.manifest).toBeDefined();
        expect(serviceConfigManager.manifest.serviceMappings).toBeDefined();
        expect(serviceConfigManager.manifest.serviceMappings.cache).toBeDefined();
        expect(serviceConfigManager.configServiceMapping).toBeDefined();
        expect(serviceConfigManager.configServiceMapping['REDIS_URL']).toBe('cache');
    });

    it('should throw error if manifest is invalid during loadManifest', () => {
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ invalidField: true }));

        expect(() => {
            serviceConfigManager.loadManifest();
        }).toThrow('manifest缺少serviceMappings字段');
    });

    describe('Getters', () => {
        beforeEach(() => {
            const mockManifest = {
                serviceMappings: {
                    testService: {
                        name: 'Test Service',
                        configKeys: ['TEST_KEY'],
                        reinitializationStrategy: { type: 'reconnect' }
                    }
                },
                criticalServices: ['testService'],
                healthChecks: { testService: { method: 'ping' } },
                logging: { enabled: true, emoji: { enabled: true, separator: '🔥' } },
                performance: { maxConcurrentServices: 5 },
                errorHandling: { maxRetries: 3 }
            };
            vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockManifest));
        });

        it('getServiceName should return correct service name', () => {
            expect(serviceConfigManager.getServiceName('TEST_KEY')).toBe('testService');
        });

        it('getServiceConfig should return correct config', () => {
            expect(serviceConfigManager.getServiceConfig('testService').name).toBe('Test Service');
        });

        it('getAllServiceMappings should return mapping', () => {
            expect(serviceConfigManager.getAllServiceMappings()).toEqual({ 'TEST_KEY': 'testService' });
        });

        it('getCriticalServices should return critical services array', () => {
            expect(serviceConfigManager.getCriticalServices()).toEqual(['testService']);
        });

        it('getHealthCheckConfig should return health check config', () => {
            expect(serviceConfigManager.getHealthCheckConfig()).toEqual({ testService: { method: 'ping' } });
        });

        it('getLoggingConfig should return logging config', () => {
            expect(serviceConfigManager.getLoggingConfig().enabled).toBe(true);
        });

        it('getPerformanceConfig should return performance config', () => {
            expect(serviceConfigManager.getPerformanceConfig().maxConcurrentServices).toBe(5);
        });

        it('getErrorHandlingConfig should return error handling config', () => {
            expect(serviceConfigManager.getErrorHandlingConfig().maxRetries).toBe(3);
        });

        it('getAffectedServices should return affected services based on changes', () => {
            const changes = [{ key: 'TEST_KEY' }, { key: 'UNKNOWN_KEY' }];
            expect(serviceConfigManager.getAffectedServices(changes)).toEqual(['testService']);
        });

        it('getReinitializationStrategy should return correct strategy', () => {
            expect(serviceConfigManager.getReinitializationStrategy('testService')).toEqual({ type: 'reconnect' });
        });

        it('getReinitializationStrategy should return default strategy if undefined', () => {
            expect(serviceConfigManager.getReinitializationStrategy('unknownService')).toEqual({
                type: 'restart',
                graceful: true,
                timeout: 30000
            });
        });

        it('isEmojiEnabled should return correct boolean', () => {
            expect(serviceConfigManager.isEmojiEnabled()).toBe(true);
        });

        it('getEmojiMapping should return correct mapping', () => {
            expect(serviceConfigManager.getEmojiMapping().separator).toBe('🔥');
        });
    });

    describe('Getters - Fallback Default values', () => {
        beforeEach(() => {
            // Mock empty manifest to test fallback defaults
            const mockManifest = { serviceMappings: {} };
            vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockManifest));
        });

        it('should return empty array for getCriticalServices if not defined', () => {
            expect(serviceConfigManager.getCriticalServices()).toEqual([]);
        });

        it('should return empty object for configs if not defined', () => {
            expect(serviceConfigManager.getHealthCheckConfig()).toEqual({});
            expect(serviceConfigManager.getLoggingConfig()).toEqual({});
            expect(serviceConfigManager.getPerformanceConfig()).toEqual({});
            expect(serviceConfigManager.getErrorHandlingConfig()).toEqual({});
        });

        it('should return default emoji mapping if not defined', () => {
            expect(serviceConfigManager.getEmojiMapping()).toEqual({
                separator: '🔮',
                success: '✅',
                warning: '⚠️',
                error: '❌',
                info: '📊',
                progress: '🔄'
            });
        });
    });

    describe('Exported function', () => {
        it('getConfigServiceMapping should work', () => {
            const mockManifest = {
                serviceMappings: {
                    testService: { configKeys: ['TEST_KEY'] }
                }
            };
            vi.mocked(readFileSync).mockReturnValue(JSON.stringify(mockManifest));
            // Force re-init by making it false first
            serviceConfigManager.initialized = false;
            expect(getConfigServiceMapping()).toEqual({ 'TEST_KEY': 'testService' });
        });
    });
});
