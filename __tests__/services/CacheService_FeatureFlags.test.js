import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { CacheService } from '../../src/services/CacheService.js';
import { FileCache } from '../../src/services/cache/FileCache.js';
import { localCache } from '../../src/utils/LocalCache.js';

vi.mock('../../src/services/logger/index.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis()
    }
}));

describe('CacheService feature flag wiring', () => {
    let service;
    let cacheDir;
    const originalEnv = process.env;

    beforeEach(async () => {
        process.env = { ...originalEnv };
        cacheDir = await mkdtemp(path.join(os.tmpdir(), 'drive-collector-cache-service-'));
        localCache.clear();
    });

    afterEach(async () => {
        await service?.destroy().catch(() => {});
        await rm(cacheDir, { recursive: true, force: true });
        process.env = originalEnv;
        localCache.clear();
    });

    test('injected env should be the source of truth for optional cache features', async () => {
        process.env.CACHE_L3_ENABLED = 'false';
        process.env.CACHE_BLOOM_FILTER = 'false';

        service = new CacheService({
            env: {
                CACHE_L3_ENABLED: 'true',
                CACHE_BLOOM_FILTER: 'true',
                CACHE_L3_DIR: cacheDir
            }
        });
        await service.initialize();

        expect(service.currentProviderName).toBe('MemoryCache');
        expect(service.l3Enabled).toBe(true);
        expect(service.l3Cache?.getProviderName()).toBe('FileCache');
        expect(service.bloomFilterEnabled).toBe(true);
        expect(service.bloomFilter).toBeTruthy();
    });

    test('L2 miss should read from L3 and promote the value back to L2 and L1', async () => {
        const mockProvider = {
            initialize: vi.fn(),
            getProviderName: vi.fn(() => 'mock-provider'),
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(true),
            delete: vi.fn(),
            disconnect: vi.fn(),
            getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
        };

        service = new CacheService({ env: { CACHE_L3_ENABLED: 'true', CACHE_L3_DIR: cacheDir } });
        await service.initialize();
        service.primaryProvider = mockProvider;
        service.currentProviderName = 'mock-provider';
        await service.l3Cache.set('test-key', { data: 'l3-value' }, 3600);

        const result = await service.get('test-key');

        expect(result).toEqual({ data: 'l3-value' });
        expect(mockProvider.get).toHaveBeenCalledWith('test-key', 'json');
        expect(mockProvider.set).toHaveBeenCalledWith('test-key', { data: 'l3-value' }, 3600);
        expect(localCache.get('test-key')).toEqual({ data: 'l3-value' });
    });

    test('memory-only mode should still read and write through the optional L3 cache', async () => {
        service = new CacheService({ env: { CACHE_L3_ENABLED: 'true', CACHE_L3_DIR: cacheDir } });
        await service.initialize();

        await expect(service.set('memory-only-key', { data: 'persisted' }, 3600)).resolves.toBe(true);
        localCache.clear();

        await expect(service.get('memory-only-key')).resolves.toEqual({ data: 'persisted' });
    });

    test('bloom filter should be warmed from existing L3 keys on startup', async () => {
        const l3Cache = new FileCache({ basePath: cacheDir });
        await l3Cache.connect();
        await l3Cache.set('persisted-key', { data: 'from-previous-process' }, 3600);
        await l3Cache.disconnect();

        const mockProvider = {
            initialize: vi.fn(),
            getProviderName: vi.fn(() => 'mock-provider'),
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn().mockResolvedValue(true),
            delete: vi.fn(),
            disconnect: vi.fn(),
            getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
        };

        service = new CacheService({
            env: {
                CACHE_L3_ENABLED: 'true',
                CACHE_BLOOM_FILTER: 'true',
                CACHE_L3_DIR: cacheDir
            }
        });
        await service.initialize();
        service.primaryProvider = mockProvider;
        service.currentProviderName = 'mock-provider';

        const result = await service.get('persisted-key');

        expect(result).toEqual({ data: 'from-previous-process' });
        expect(mockProvider.set).toHaveBeenCalledWith('persisted-key', { data: 'from-previous-process' }, 3600);
    });

    test('bloom filter should not bypass authoritative L2 reads', async () => {
        const mockProvider = {
            initialize: vi.fn(),
            getProviderName: vi.fn(() => 'mock-provider'),
            get: vi.fn().mockResolvedValue({ data: 'l2-value' }),
            set: vi.fn(),
            delete: vi.fn(),
            disconnect: vi.fn(),
            getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
        };

        service = new CacheService({
            env: {
                CACHE_L3_ENABLED: 'true',
                CACHE_BLOOM_FILTER: 'true',
                CACHE_L3_DIR: cacheDir
            }
        });
        await service.initialize();
        service.primaryProvider = mockProvider;
        service.currentProviderName = 'mock-provider';

        const result = await service.get('key-written-by-another-instance');

        expect(result).toEqual({ data: 'l2-value' });
        expect(mockProvider.get).toHaveBeenCalledWith('key-written-by-another-instance', 'json');
        expect(service.bloomFilter.has('key-written-by-another-instance')).toBe(true);
    });

    test('bloom filter miss should avoid local L3 reads after an authoritative L2 miss', async () => {
        const mockProvider = {
            initialize: vi.fn(),
            getProviderName: vi.fn(() => 'mock-provider'),
            get: vi.fn().mockResolvedValue(null),
            set: vi.fn(),
            delete: vi.fn(),
            disconnect: vi.fn(),
            getConnectionInfo: vi.fn(() => ({ provider: 'mock-provider' }))
        };

        service = new CacheService({
            env: {
                CACHE_L3_ENABLED: 'true',
                CACHE_BLOOM_FILTER: 'true',
                CACHE_L3_DIR: cacheDir
            }
        });
        await service.initialize();
        service.primaryProvider = mockProvider;
        service.currentProviderName = 'mock-provider';
        const l3Get = vi.spyOn(service.l3Cache, 'get');

        const result = await service.get('never-seen-key');

        expect(result).toBeNull();
        expect(mockProvider.get).toHaveBeenCalledWith('never-seen-key', 'json');
        expect(l3Get).not.toHaveBeenCalled();
    });
});
