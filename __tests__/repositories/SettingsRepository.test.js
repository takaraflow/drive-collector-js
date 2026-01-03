import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock dependencies (必须在顶层定义)
const mockCache = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    getCurrentProvider: jest.fn().mockReturnValue("Cloudflare KV")
};

const mockLocalCache = {
    get: jest.fn(),
    set: jest.fn()
};

// Mock Config (虽然 SettingsRepository 不直接用，但 CacheService 可能用到)
const mockConfig = {
    CF_CACHE_ACCOUNT_ID: 'test-account-id',
    CF_CACHE_NAMESPACE_ID: 'test-namespace-id',
    CF_CACHE_API_TOKEN: 'test-api-token'
};

// 注册 Mocks
jest.unstable_mockModule('../../src/config/index.js', () => ({
    config: mockConfig,
    default: { config: mockConfig }
}));

jest.unstable_mockModule('../../src/services/CacheService.js', () => ({
    cache: mockCache
}));

jest.unstable_mockModule('../../src/utils/LocalCache.js', () => ({
    localCache: mockLocalCache
}));

describe('SettingsRepository', () => {
    let SettingsRepository;

    // 【关键修复】使用 beforeAll 和 resetModules
    beforeAll(async () => {
        // 1. 重置模块缓存，防止之前的测试加载了真实的 CacheService
        jest.resetModules();

        // 2. 动态导入 SettingsRepository (此时 Mock 已准备好)
        const module = await import('../../src/repositories/SettingsRepository.js');
        SettingsRepository = module.SettingsRepository;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('get', () => {
        it('should return memory cached value if available', async () => {
            mockLocalCache.get.mockReturnValue('cached_value');

            const result = await SettingsRepository.get('test_key');
            expect(result).toBe('cached_value');
            expect(mockLocalCache.get).toHaveBeenCalledWith('setting:test_key');
            expect(mockCache.get).not.toHaveBeenCalled();
        });

        it('should return KV value if not in memory', async () => {
            mockLocalCache.get.mockReturnValue(null);
            mockCache.get.mockResolvedValue('kv_value');

            const result = await SettingsRepository.get('test_key');
            expect(result).toBe('kv_value');
            expect(mockCache.get).toHaveBeenCalledWith('setting:test_key', 'text');
            expect(mockLocalCache.set).toHaveBeenCalledWith('setting:test_key', 'kv_value', 30 * 60 * 1000);
        });

        it('should return default value if not found in KV', async () => {
            mockLocalCache.get.mockReturnValue(null);
            mockCache.get.mockResolvedValue(null);

            const result = await SettingsRepository.get('test_key', 'default_value');
            expect(result).toBe('default_value');
        });

        it('should return default value on KV error', async () => {
            mockLocalCache.get.mockReturnValue(null);
            mockCache.get.mockRejectedValue(new Error('KV Error'));

            const result = await SettingsRepository.get('test_key', 'default_value');
            expect(result).toBe('default_value');
        });

        it('should handle null key gracefully', async () => {
            const result = await SettingsRepository.get(null);
            expect(result).toBeNull();
        });
    });

    describe('set', () => {
        it('should update KV and memory cache', async () => {
            await SettingsRepository.set('test_key', 'test_value');

            expect(mockCache.set).toHaveBeenCalledWith('setting:test_key', 'test_value');
            expect(mockLocalCache.set).toHaveBeenCalledWith('setting:test_key', 'test_value', 30 * 60 * 1000);
        });

        it('should handle KV errors by throwing', async () => {
            mockCache.set.mockRejectedValue(new Error('KV Error'));

            // Should throw since KV is the primary storage
            await expect(SettingsRepository.set('test_key', 'test_value')).rejects.toThrow('KV Error');
        });

        it('should handle null key gracefully', async () => {
            await SettingsRepository.set(null, 'value');
            // Should not call KV.set for null key
            expect(mockCache.set).not.toHaveBeenCalled();
        });
    });

    describe('getSettingsKey', () => {
        it('should prefix key with setting:', () => {
            const result = SettingsRepository.getSettingsKey('test');
            expect(result).toBe('setting:test');
        });
    });
});
