import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock dependencies
const mockCache = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    getCurrentProvider: jest.fn().mockReturnValue("Cloudflare KV")
};

const mockLocalCache = {
    get: jest.fn(),
    set: jest.fn()
};

jest.unstable_mockModule('../../src/services/CacheService.js', () => ({
    cache: mockCache
}));

jest.unstable_mockModule('../../src/utils/LocalCache.js', () => ({
    localCache: mockLocalCache
}));

const { SettingsRepository } = await import('../../src/repositories/SettingsRepository.js');

describe('SettingsRepository', () => {
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
