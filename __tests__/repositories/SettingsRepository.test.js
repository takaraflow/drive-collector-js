import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock dependencies
const mockKV = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined)
};
jest.unstable_mockModule('../../src/services/kv.js', () => ({
    kv: mockKV
}));

const mockCacheService = {
    get: jest.fn(),
    set: jest.fn()
};
jest.unstable_mockModule('../../src/utils/CacheService.js', () => ({
    cacheService: mockCacheService
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
            mockCacheService.get.mockReturnValue('cached_value');

            const result = await SettingsRepository.get('test_key');
            expect(result).toBe('cached_value');
            expect(mockCacheService.get).toHaveBeenCalledWith('setting:test_key');
            expect(mockKV.get).not.toHaveBeenCalled();
        });

        it('should return KV value if not in memory', async () => {
            mockCacheService.get.mockReturnValue(null);
            mockKV.get.mockResolvedValue('kv_value');

            const result = await SettingsRepository.get('test_key');
            expect(result).toBe('kv_value');
            expect(mockKV.get).toHaveBeenCalledWith('setting:test_key', 'text');
            expect(mockCacheService.set).toHaveBeenCalledWith('setting:test_key', 'kv_value', 30 * 60 * 1000);
        });

        it('should return default value if not found in KV', async () => {
            mockCacheService.get.mockReturnValue(null);
            mockKV.get.mockResolvedValue(null);

            const result = await SettingsRepository.get('test_key', 'default_value');
            expect(result).toBe('default_value');
        });

        it('should return default value on KV error', async () => {
            mockCacheService.get.mockReturnValue(null);
            mockKV.get.mockRejectedValue(new Error('KV Error'));

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

            expect(mockKV.set).toHaveBeenCalledWith('setting:test_key', 'test_value');
            expect(mockCacheService.set).toHaveBeenCalledWith('setting:test_key', 'test_value', 30 * 60 * 1000);
        });

        it('should handle KV errors by throwing', async () => {
            mockKV.set.mockRejectedValue(new Error('KV Error'));

            // Should throw since KV is the primary storage
            await expect(SettingsRepository.set('test_key', 'test_value')).rejects.toThrow('KV Error');
        });

        it('should handle null key gracefully', async () => {
            await SettingsRepository.set(null, 'value');
            // Should not call KV.set for null key
            expect(mockKV.set).not.toHaveBeenCalled();
        });
    });

    describe('getSettingsKey', () => {
        it('should prefix key with setting:', () => {
            const result = SettingsRepository.getSettingsKey('test');
            expect(result).toBe('setting:test');
        });
    });
});