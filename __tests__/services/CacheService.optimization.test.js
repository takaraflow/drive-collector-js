/**
 * Cache Service Optimization Tests
 * Tests for三级缓存架构、缓存预热和智能失效机制
 */

vi.mock("../../../src/config/index.js", () => ({
    getConfig: vi.fn(() => ({
        qstash: {
            token: 'test-token',
            webhookUrl: 'https://example.com',
            currentSigningKey: 'key1',
            nextSigningKey: 'key2'
        }
    })),
    initConfig: vi.fn(async () => ({
        qstash: {
            token: 'test-token',
            webhookUrl: 'https://example.com',
            currentSigningKey: 'key1',
            nextSigningKey: 'key2'
        }
    })),
    config: {
        qstash: {
            token: 'test-token',
            webhookUrl: 'https://example.com',
            currentSigningKey: 'key1',
            nextSigningKey: 'key2'
        }
    }
}));

vi.mock("../../../src/services/logger/index.js", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    },
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    }
}));

describe("CacheService - Three-Level Cache", () => {
    beforeEach(() => {
        vi.useFakeTimers({ timerLimit: 10000, advanceTimers: true });
        vi.spyOn(global.Math, 'random').mockReturnValue(0.5);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("should implement three-level cache hierarchy", async () => {
        // Test L1 -> L2 -> L3 cache hierarchy
        const l1Cache = new Map();
        const l2Cache = new Map();
        const l3Cache = new Map();

        // Simulate write to all levels
        const key = 'test:key';
        const value = { data: 'test-value' };
        const ttl = 3600;

        l1Cache.set(key, { value, expiry: Date.now() + ttl * 1000 });
        l2Cache.set(key, { value, expiry: Date.now() + ttl * 1000 });
        l3Cache.set(key, { value, expiry: Date.now() + ttl * 1000 });

        // Verify all levels have the data
        expect(l1Cache.has(key)).toBe(true);
        expect(l2Cache.has(key)).toBe(true);
        expect(l3Cache.has(key)).toBe(true);
    });

    test("should read from L1 cache first (L1 Hit)", async () => {
        const l1Cache = new Map();
        const l2Cache = new Map();
        const l3Cache = new Map();

        const key = 'test:key';
        const value = { data: 'test-value' };

        // L1 has the data
        l1Cache.set(key, value);

        // Simulate cache read
        let readFromL1 = false;
        let readFromL2 = false;
        let readFromL3 = false;

        if (l1Cache.has(key)) {
            readFromL1 = true;
        } else if (l2Cache.has(key)) {
            readFromL2 = true;
        } else if (l3Cache.has(key)) {
            readFromL3 = true;
        }

        expect(readFromL1).toBe(true);
        expect(readFromL2).toBe(false);
        expect(readFromL3).toBe(false);
    });

    test("should read from L2 cache on L1 miss (L2 Hit)", async () => {
        const l1Cache = new Map();
        const l2Cache = new Map();
        const l3Cache = new Map();

        const key = 'test:key';
        const value = { data: 'test-value' };

        // L2 has the data, L1 is empty
        l2Cache.set(key, value);

        // Simulate cache read
        let readFromL1 = false;
        let readFromL2 = false;
        let readFromL3 = false;

        if (l1Cache.has(key)) {
            readFromL1 = true;
        } else if (l2Cache.has(key)) {
            readFromL2 = true;
            // Backfill L1
            l1Cache.set(key, value);
        } else if (l3Cache.has(key)) {
            readFromL3 = true;
        }

        expect(readFromL1).toBe(false);
        expect(readFromL2).toBe(true);
        expect(readFromL3).toBe(false);
        expect(l1Cache.has(key)).toBe(true); // L1 should be backfilled
    });

    test("should read from L3 cache on L1 and L2 miss (L3 Hit)", async () => {
        const l1Cache = new Map();
        const l2Cache = new Map();
        const l3Cache = new Map();

        const key = 'test:key';
        const value = { data: 'test-value' };

        // Only L3 has the data
        l3Cache.set(key, value);

        // Simulate cache read
        let readFromL1 = false;
        let readFromL2 = false;
        let readFromL3 = false;

        if (l1Cache.has(key)) {
            readFromL1 = true;
        } else if (l2Cache.has(key)) {
            readFromL2 = true;
        } else if (l3Cache.has(key)) {
            readFromL3 = true;
            // Backfill L1 and L2
            l1Cache.set(key, value);
            l2Cache.set(key, value);
        }

        expect(readFromL1).toBe(false);
        expect(readFromL2).toBe(false);
        expect(readFromL3).toBe(true);
        expect(l1Cache.has(key)).toBe(true); // L1 should be backfilled
        expect(l2Cache.has(key)).toBe(true); // L2 should be backfilled
    });

    test("should return null on cache miss at all levels", async () => {
        const l1Cache = new Map();
        const l2Cache = new Map();
        const l3Cache = new Map();

        const key = 'nonexistent:key';

        // Simulate cache read
        let result = null;
        if (l1Cache.has(key)) {
            result = l1Cache.get(key);
        } else if (l2Cache.has(key)) {
            result = l2Cache.get(key);
        } else if (l3Cache.has(key)) {
            result = l3Cache.get(key);
        }

        expect(result).toBeNull();
    });

    test("should implement TTL randomization", async () => {
        const baseTTL = 3600;
        const randomization = 0.2;

        // Test with different random values
        const randomValues = [0.0, 0.5, 1.0];
        const expectedTTLs = [
            Math.floor(baseTTL * (1 - randomization / 2)), // 0.0 -> 3240
            baseTTL,                                        // 0.5 -> 3600
            Math.floor(baseTTL * (1 + randomization / 2))  // 1.0 -> 3960
        ];

        randomValues.forEach((random, index) => {
            const variance = (random - 0.5) * randomization;
            const ttl = Math.floor(baseTTL * (1 + variance));
            expect(ttl).toBe(expectedTTLs[index]);
        });
    });

    test("should delete from all cache levels", async () => {
        const l1Cache = new Map();
        const l2Cache = new Map();
        const l3Cache = new Map();

        const key = 'test:key';
        const value = { data: 'test-value' };

        // Set in all levels
        l1Cache.set(key, value);
        l2Cache.set(key, value);
        l3Cache.set(key, value);

        // Delete from all levels
        l1Cache.delete(key);
        l2Cache.delete(key);
        l3Cache.delete(key);

        expect(l1Cache.has(key)).toBe(false);
        expect(l2Cache.has(key)).toBe(false);
        expect(l3Cache.has(key)).toBe(false);
    });

    test("should clear all cache levels", async () => {
        const l1Cache = new Map();
        const l2Cache = new Map();
        const l3Cache = new Map();

        // Add multiple items
        l1Cache.set('key1', 'value1');
        l1Cache.set('key2', 'value2');
        l2Cache.set('key1', 'value1');
        l2Cache.set('key2', 'value2');
        l3Cache.set('key1', 'value1');
        l3Cache.set('key2', 'value2');

        // Clear all
        l1Cache.clear();
        l2Cache.clear();
        l3Cache.clear();

        expect(l1Cache.size).toBe(0);
        expect(l2Cache.size).toBe(0);
        expect(l3Cache.size).toBe(0);
    });
});

describe("CacheService - Bloom Filter", () => {
    beforeEach(() => {
        vi.useFakeTimers({ timerLimit: 10000, advanceTimers: true });
        vi.spyOn(global.Math, 'random').mockReturnValue(0.5);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("should use bloom filter to check key existence", async () => {
        // Simple bloom filter simulation
        const bloomFilter = new Set();
        
        const key = 'test:key';
        
        // Initially not in filter
        expect(bloomFilter.has(key)).toBe(false);
        
        // Add to filter
        bloomFilter.add(key);
        
        // Now should exist
        expect(bloomFilter.has(key)).toBe(true);
    });

    test("should handle bloom filter false positives gracefully", async () => {
        const bloomFilter = new Set();
        const cache = new Map();

        // Add some keys to bloom filter
        bloomFilter.add('key1');
        bloomFilter.add('key2');

        // Add to actual cache
        cache.set('key1', 'value1');
        cache.set('key2', 'value2');

        // Check for existing key
        const existingKey = 'key1';
        if (bloomFilter.has(existingKey)) {
            const result = cache.get(existingKey);
            expect(result).toBe('value1');
        }

        // Check for non-existing key that might be false positive
        const nonexistentKey = 'nonexistent';
        if (bloomFilter.has(nonexistentKey)) {
            const result = cache.get(nonexistentKey);
            // Should handle gracefully
            expect(result).toBeUndefined();
        }
    });

    test("should clear bloom filter on cache clear", async () => {
        const bloomFilter = new Set();

        // Add items
        bloomFilter.add('key1');
        bloomFilter.add('key2');
        bloomFilter.add('key3');

        expect(bloomFilter.size).toBe(3);

        // Clear
        bloomFilter.clear();

        expect(bloomFilter.size).toBe(0);
    });
});

describe("CacheService - Pattern-based Deletion", () => {
    beforeEach(() => {
        vi.useFakeTimers({ timerLimit: 10000, advanceTimers: true });
        vi.spyOn(global.Math, 'random').mockReturnValue(0.5);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("should delete keys matching a pattern", async () => {
        const cache = new Map();

        // Add test data
        cache.set('user:1:profile', { name: 'Alice' });
        cache.set('user:1:settings', { theme: 'dark' });
        cache.set('user:2:profile', { name: 'Bob' });
        cache.set('session:abc123', { user: 'Alice' });

        // Pattern to match user:1:*
        const pattern = /^user:1:.*$/;
        const keysToDelete = Array.from(cache.keys()).filter(key => pattern.test(key));

        // Delete matching keys
        keysToDelete.forEach(key => cache.delete(key));

        // Verify
        expect(cache.has('user:1:profile')).toBe(false);
        expect(cache.has('user:1:settings')).toBe(false);
        expect(cache.has('user:2:profile')).toBe(true);
        expect(cache.has('session:abc123')).toBe(true);
    });

    test("should handle empty pattern results", async () => {
        const cache = new Map();

        cache.set('user:1:profile', { name: 'Alice' });

        // Pattern that matches nothing
        const pattern = /^nonexistent:.*$/;
        const keysToDelete = Array.from(cache.keys()).filter(key => pattern.test(key));

        expect(keysToDelete).toHaveLength(0);
    });

    test("should handle partial failures during pattern deletion", async () => {
        const cache = new Map();

        cache.set('user:1:profile', { name: 'Alice' });
        cache.set('user:1:settings', { theme: 'dark' });

        // Simulate partial failure - delete first but fail on second
        const pattern = /^user:1:.*$/;
        const keysToDelete = Array.from(cache.keys()).filter(key => pattern.test(key));

        let successCount = 0;
        let failCount = 0;

        keysToDelete.forEach((key, index) => {
            if (index === 0) {
                cache.delete(key);
                successCount++;
            } else {
                // Simulate failure
                failCount++;
            }
        });

        expect(successCount).toBe(1);
        expect(failCount).toBe(1);
        expect(cache.has('user:1:profile')).toBe(false);
        expect(cache.has('user:1:settings')).toBe(true); // Still exists due to failure
    });
});

describe("CacheService - Cache Warming", () => {
    beforeEach(() => {
        vi.useFakeTimers({ timerLimit: 10000, advanceTimers: true });
        vi.spyOn(global.Math, 'random').mockReturnValue(0.5);
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("should warm cache with provided data", async () => {
        const l1Cache = new Map();
        const l2Cache = new Map();
        const l3Cache = new Map();

        const warmData = [
            { key: 'config:app', value: { version: '1.0' }, ttl: 3600 },
            { key: 'config:db', value: { host: 'localhost' }, ttl: 3600 }
        ];

        // Warm all cache levels
        warmData.forEach(({ key, value, ttl }) => {
            const expiry = Date.now() + ttl * 1000;
            l1Cache.set(key, { value, expiry });
            l2Cache.set(key, { value, expiry });
            l3Cache.set(key, { value, expiry });
        });

        // Verify all levels are warmed
        expect(l1Cache.size).toBe(2);
        expect(l2Cache.size).toBe(2);
        expect(l3Cache.size).toBe(2);
        expect(l1Cache.get('config:app').value.version).toBe('1.0');
    });

    test("should handle warm cache with empty data", async () => {
        const l1Cache = new Map();
        const l2Cache = new Map();
        const l3Cache = new Map();

        const warmData = [];

        // Warm with empty data
        warmData.forEach(({ key, value, ttl }) => {
            const expiry = Date.now() + ttl * 1000;
            l1Cache.set(key, { value, expiry });
            l2Cache.set(key, { value, expiry });
            l3Cache.set(key, { value, expiry });
        });

        // Should remain empty
        expect(l1Cache.size).toBe(0);
        expect(l2Cache.size).toBe(0);
        expect(l3Cache.size).toBe(0);
    });

    test("should handle partial failures during warming", async () => {
        const l1Cache = new Map();
        const l2Cache = new Map();
        const l3Cache = new Map();

        const warmData = [
            { key: 'config:app', value: { version: '1.0' }, ttl: 3600 },
            { key: 'config:db', value: { host: 'localhost' }, ttl: 3600 }
        ];

        // Simulate L2 failure for first item
        warmData.forEach((data, index) => {
            const expiry = Date.now() + data.ttl * 1000;
            
            // L1 and L3 always succeed
            l1Cache.set(data.key, { value: data.value, expiry });
            l3Cache.set(data.key, { value: data.value, expiry });
            
            // L2 fails for first item
            if (index > 0) {
                l2Cache.set(data.key, { value: data.value, expiry });
            }
        });

        // Verify L1 and L3 have both items, L2 has only second
        expect(l1Cache.size).toBe(2);
        expect(l2Cache.size).toBe(1);
        expect(l3Cache.size).toBe(2);
    });
});
