import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';

vi.mock('../../src/services/CacheService.js', () => ({
    cache: {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn()
    }
}));

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        acquireLock: vi.fn(),
        releaseLock: vi.fn(),
        getInstanceId: vi.fn()
    }
}));

vi.mock('../../src/utils/LocalCache.js', () => ({
    localCache: {
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn(),
        clear: vi.fn(),
        size: vi.fn()
    }
}));

// QStash 保持 mock 作为"防复活"回归锁:缓存失效广播已改走 pub/sub,绝不能再回 QStash。
vi.mock('../../src/services/QueueService.js', () => ({
    queueService: {
        publish: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock('../../src/services/Broadcaster.js', () => ({
    broadcaster: {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined)
    },
    CHANNELS: {
        stateChanged: 'dc:state:changed',
        cacheInvalidate: 'dc:cache:invalidate',
        batchEvents: 'dc:batch:events'
    }
}));

import { cache } from '../../src/services/CacheService.js';
import { instanceCoordinator } from '../../src/services/InstanceCoordinator.js';
import { localCache } from '../../src/utils/LocalCache.js';
import { queueService } from '../../src/services/QueueService.js';
import { broadcaster, CHANNELS } from '../../src/services/Broadcaster.js';
import { ConsistentCache } from '../../src/services/ConsistentCache.js';

describe('ConsistentCache - service facade', () => {
    let cacheInstance;

    beforeEach(() => {
        vi.clearAllMocks();
        cache.get.mockResolvedValue(null);
        cache.set.mockResolvedValue(true);
        cache.delete.mockResolvedValue(true);
        localCache.size.mockReturnValue(0);
        instanceCoordinator.acquireLock.mockResolvedValue(true);
        instanceCoordinator.releaseLock.mockResolvedValue(true);
        instanceCoordinator.getInstanceId.mockReturnValue('test-instance');
        broadcaster.publish.mockResolvedValue(undefined);
        broadcaster.subscribe.mockResolvedValue(undefined);
        cacheInstance = new ConsistentCache();
    });

    afterEach(() => {
        cacheInstance.syncInProgress.clear();
    });

    test('initializes with consistent prefix and tracking map', () => {
        expect(cacheInstance.prefix).toBe('consistent:');
        expect(cacheInstance.syncInProgress).toBeInstanceOf(Map);
    });

    test('set writes through to remote cache and local cache', async () => {
        const payload = { foo: 'bar' };

        const result = await cacheInstance.set('user:123', payload);

        expect(result).toBe(true);
        expect(cache.set).toHaveBeenCalledWith('consistent:user:123', payload, 3600);
        expect(localCache.set).toHaveBeenCalledWith('consistent:user:123', payload, 60);
        expect(broadcaster.publish).toHaveBeenCalledWith(
            CHANNELS.cacheInvalidate,
            expect.objectContaining({ action: 'set', key: 'consistent:user:123' })
        );
        // 防复活:缓存失效广播绝不再走 QStash
        expect(queueService.publish).not.toHaveBeenCalled();
    });

    test('set succeeds when the invalidation notification is dropped', async () => {
        broadcaster.publish.mockResolvedValue(undefined);

        const result = await cacheInstance.set('user:123', { foo: 'bar' });

        expect(result).toBe(true);
        expect(cache.set).toHaveBeenCalledWith('consistent:user:123', { foo: 'bar' }, 3600);
    });

    test('set honors lock option and always releases the lock', async () => {
        await cacheInstance.set('locked', 'value', { lockKey: 'lock-1' });

        expect(instanceCoordinator.acquireLock).toHaveBeenCalledWith('cache_write:lock-1', 30);
        expect(instanceCoordinator.releaseLock).toHaveBeenCalledWith('cache_write:lock-1');
    });

    test('set returns false when lock acquisition fails', async () => {
        instanceCoordinator.acquireLock.mockResolvedValue(false);

        const result = await cacheInstance.set('locked', 'value', { lockKey: 'lock-2' });

        expect(result).toBe(false);
        expect(cache.set).not.toHaveBeenCalled();
    });

    test('get returns local value when available', async () => {
        localCache.get.mockReturnValue('cached');

        const result = await cacheInstance.get('foo');

        expect(result).toBe('cached');
        expect(cache.get).not.toHaveBeenCalled();
    });

    test('get falls back to distributed cache and updates local cache', async () => {
        localCache.get.mockReturnValue(undefined);
        cache.get.mockResolvedValue('remote-value');

        const result = await cacheInstance.get('bar');

        expect(result).toBe('remote-value');
        expect(cache.get).toHaveBeenCalledWith('consistent:bar');
        expect(localCache.set).toHaveBeenCalledWith('consistent:bar', 'remote-value', 60);
    });

    test('delete removes value from both caches', async () => {
        const result = await cacheInstance.delete('item');

        expect(result).toBe(true);
        expect(cache.delete).toHaveBeenCalledWith('consistent:item');
        expect(localCache.del).toHaveBeenCalledWith('consistent:item');
    });

    test('delete honors lock option', async () => {
        await cacheInstance.delete('item', { lockKey: 'del-lock' });

        expect(instanceCoordinator.acquireLock).toHaveBeenCalledWith('cache_delete:del-lock', 30);
        expect(instanceCoordinator.releaseLock).toHaveBeenCalledWith('cache_delete:del-lock');
    });

    test('batch obtains a lock and executes operations', async () => {
        const operations = [
            { type: 'set', key: 'one', value: 'v1' },
            { type: 'delete', key: 'two' }
        ];

        const result = await cacheInstance.batch(operations);

        expect(result).toBe(true);
        expect(instanceCoordinator.acquireLock).toHaveBeenCalledWith(expect.stringContaining('cache_batch'), 60);
        expect(cache.set).toHaveBeenCalledWith('consistent:one', 'v1', 3600);
        expect(cache.delete).toHaveBeenCalledWith('consistent:two');
        expect(instanceCoordinator.releaseLock).toHaveBeenCalled();
    });

    test('handleSyncEvent invalidates the exact local key a peer wrote (no double-prefix)', async () => {
        // 关键回归:_broadcastChange 发出的 event.key 已是完整前缀键('consistent:foo'),
        // 与 set()/get() 写读本地缓存用的键一致。handleSyncEvent 必须原样 del,不能再加前缀,
        // 否则删的是从不存在的 'consistent:consistent:foo',跨实例失效彻底失灵。
        await cacheInstance.handleSyncEvent({ source: 'peer', action: 'set', key: 'consistent:foo' });
        expect(localCache.del).toHaveBeenCalledWith('consistent:foo');
        expect(localCache.set).not.toHaveBeenCalled();

        localCache.del.mockClear();
        await cacheInstance.handleSyncEvent({ source: 'peer', action: 'delete', key: 'consistent:foo' });
        expect(localCache.del).toHaveBeenCalledWith('consistent:foo');
    });

    test('handleSyncEvent ignores own events', async () => {
        instanceCoordinator.getInstanceId.mockReturnValue('self');
        await cacheInstance.handleSyncEvent({ source: 'self', action: 'set', key: 'consistent:ignored' });
        expect(localCache.del).not.toHaveBeenCalled();
        expect(localCache.set).not.toHaveBeenCalled();
    });

    test('init subscribes to the cache-invalidate pub/sub channel', async () => {
        await cacheInstance.init();
        expect(broadcaster.subscribe).toHaveBeenCalledWith(CHANNELS.cacheInvalidate, expect.any(Function));
    });

    test('init 幂等:重复调用(如热重载)只订阅一次,不叠加处理器', async () => {
        await cacheInstance.init();
        await cacheInstance.init();
        await cacheInstance.init();
        expect(broadcaster.subscribe).toHaveBeenCalledTimes(1);
    });

    test('restoreConsistency reapplies logs and clears local cache', async () => {
        const logs = [
            { type: 'set', key: 'consistent:set-key', value: 'value' },
            { type: 'delete', key: 'consistent:delete-key', value: null }
        ];
        vi.spyOn(cacheInstance, '_getChangeLogs').mockResolvedValue(logs);

        const result = await cacheInstance.restoreConsistency('user');

        expect(result).toBe(true);
        expect(cache.set).toHaveBeenCalledWith('consistent:set-key', 'value', 3600);
        expect(cache.delete).toHaveBeenCalledWith('consistent:delete-key');
        expect(localCache.clear).toHaveBeenCalled();
    });

    test('getStats reports local cache size and sync map size', async () => {
        localCache.size.mockReturnValue(5);
        cacheInstance.syncInProgress.set('job', {});
        instanceCoordinator.getInstanceId.mockReturnValue('node-1');

        const stats = await cacheInstance.getStats();

        expect(stats).toMatchObject({
            prefix: 'consistent:',
            localCacheSize: 5,
            syncInProgress: 1,
            instanceId: 'node-1'
        });
    });

    test('clearLocalCache flushes local cache', () => {
        cacheInstance.clearLocalCache();
        expect(localCache.clear).toHaveBeenCalled();
    });
});
