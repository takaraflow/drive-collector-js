import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock dependencies
const mockD1 = {
    fetchOne: jest.fn(),
    run: jest.fn()
};
jest.unstable_mockModule('../../src/services/d1.js', () => ({
    d1: mockD1
}));

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

        it('should return KV cached value if not in memory', async () => {
            mockCacheService.get.mockReturnValue(null);
            mockKV.get.mockResolvedValue('kv_cached_value');

            const result = await SettingsRepository.get('test_key');
            expect(result).toBe('kv_cached_value');
            expect(mockKV.get).toHaveBeenCalledWith('setting:test_key', 'text');
            expect(mockCacheService.set).toHaveBeenCalledWith('setting:test_key', 'kv_cached_value', 30 * 60 * 1000);
        });

        it('should fetch from D1 if not cached anywhere', async () => {
            mockCacheService.get.mockReturnValue(null);
            mockKV.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue({ value: 'db_value' });

            const result = await SettingsRepository.get('test_key');
            expect(result).toBe('db_value');
            expect(mockD1.fetchOne).toHaveBeenCalledWith("SELECT value FROM system_settings WHERE key = ?", ['test_key']);
            expect(mockKV.set).toHaveBeenCalled();
            expect(mockCacheService.set).toHaveBeenCalledWith('setting:test_key', 'db_value', 30 * 60 * 1000);
        });

        it('should return default value if not found in any layer', async () => {
            mockCacheService.get.mockReturnValue(null);
            mockKV.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue(null);

            const result = await SettingsRepository.get('test_key', 'default_value');
            expect(result).toBe('default_value');
        });

        it('should return default value on database error', async () => {
            mockCacheService.get.mockReturnValue(null);
            mockKV.get.mockResolvedValue(null);
            mockD1.fetchOne.mockRejectedValue(new Error('DB Error'));

            const result = await SettingsRepository.get('test_key', 'default_value');
            expect(result).toBe('default_value');
        });

        it('should handle null key gracefully', async () => {
            const result = await SettingsRepository.get(null);
            expect(result).toBeNull();
        });
    });

    describe('set', () => {
        it('should update D1, KV and memory cache', async () => {
            await SettingsRepository.set('test_key', 'test_value');

            expect(mockD1.run).toHaveBeenCalledWith(
                "INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
                ['test_key', 'test_value']
            );
            expect(mockKV.set).toHaveBeenCalledWith('setting:test_key', 'test_value');
            expect(mockCacheService.set).toHaveBeenCalledWith('setting:test_key', 'test_value', 30 * 60 * 1000);
        });

        it('should handle database errors gracefully', async () => {
            mockD1.run.mockRejectedValue(new Error('DB Error'));

            // Should throw since D1 is the primary storage
            await expect(SettingsRepository.set('test_key', 'test_value')).rejects.toThrow('DB Error');
        });

        it('should handle null key gracefully', async () => {
            await SettingsRepository.set(null, 'value');
            // Should not call D1.run for null key
            expect(mockD1.run).not.toHaveBeenCalled();
        });
    });

    describe('getSettingsKey', () => {
        it('should prefix key with setting:', () => {
            const result = SettingsRepository.getSettingsKey('test');
            expect(result).toBe('setting:test');
        });
    });
});