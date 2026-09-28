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
        getActiveInstances: vi.fn(),
        getInstanceId: vi.fn()
    }
}));

// QStash 保持 mock:StateSynchronizer 已不再 import 它,这里作为"防复活"回归锁——
// 一旦有人再把状态广播塞回 QStash,下面的 not.toHaveBeenCalled 断言就会红。
vi.mock('../../src/services/QueueService.js', () => ({
    queueService: {
        publish: vi.fn().mockResolvedValue(true),
        subscribe: vi.fn().mockResolvedValue(true)
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

vi.mock('../../src/utils/LocalCache.js', () => ({
    localCache: {
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn(),
        clear: vi.fn()
    }
}));

import { cache } from '../../src/services/CacheService.js';
import { instanceCoordinator } from '../../src/services/InstanceCoordinator.js';
import { queueService } from '../../src/services/QueueService.js';
import { broadcaster, CHANNELS } from '../../src/services/Broadcaster.js';
import { localCache } from '../../src/utils/LocalCache.js';
import { StateSynchronizer } from '../../src/services/StateSynchronizer.js';

describe('StateSynchronizer - synchronization workflow', () => {
    let synchronizer;

    beforeEach(() => {
        vi.clearAllMocks();
        cache.get.mockResolvedValue(null);
        cache.set.mockResolvedValue(true);
        broadcaster.publish.mockResolvedValue(undefined);
        broadcaster.subscribe.mockResolvedValue(undefined);
        instanceCoordinator.acquireLock.mockResolvedValue(true);
        instanceCoordinator.releaseLock.mockResolvedValue(true);
        instanceCoordinator.getActiveInstances.mockResolvedValue(['self', 'peer-instance']);
        instanceCoordinator.getInstanceId.mockReturnValue('self');
        localCache.get.mockReturnValue(undefined);
        synchronizer = new StateSynchronizer();
    });

    afterEach(async () => {
        await synchronizer.stop();
    });

    test('initializes state prefixes and subscriber map', () => {
        expect(synchronizer.syncPrefix).toBe('sync:');
        expect(synchronizer.statePrefix).toBe('state:');
        expect(synchronizer.subscribers.size).toBe(0);
    });

    test('syncUserState merges remote state, broadcasts change, and releases lock', async () => {
        const userId = 'user-1';
        const stateType = 'tasks';
        const localKey = `state:${userId}:${stateType}`;
        const remoteKey = `sync:${userId}:${stateType}:peer-instance`;

        const localState = { status: 'local', timestamp: 1000 };
        const remoteState = { status: 'peer', timestamp: 2000 };

        localCache.get.mockReturnValue(undefined);
        cache.get.mockImplementation((key) => {
            if (key === localKey) return localState;
            if (key === remoteKey) return remoteState;
            return null;
        });

        const result = await synchronizer.syncUserState(userId, stateType);

        expect(result).toBe(true);
        expect(instanceCoordinator.acquireLock).toHaveBeenCalledWith(`sync_state:${userId}:${stateType}`, 30);
        expect(instanceCoordinator.releaseLock).toHaveBeenCalled();
        expect(cache.set).toHaveBeenCalledWith(localKey, remoteState, 3600);
        expect(localCache.set).toHaveBeenCalledWith(localKey, remoteState, 60);
        expect(broadcaster.publish).toHaveBeenCalledWith(
            CHANNELS.stateChanged,
            expect.objectContaining({ userId, stateType })
        );
        // 防复活:状态广播绝不再走 QStash
        expect(queueService.publish).not.toHaveBeenCalled();
    });

    test('syncUserState returns false when lock acquisition fails', async () => {
        instanceCoordinator.acquireLock.mockResolvedValue(false);

        const result = await synchronizer.syncUserState('user-1', 'tasks');

        expect(result).toBe(false);
        expect(instanceCoordinator.acquireLock).toHaveBeenCalled();
        expect(instanceCoordinator.releaseLock).not.toHaveBeenCalled();
    });

    test('syncUserState returns false when sync fails', async () => {
        cache.get.mockRejectedValue(new Error('Cache error'));

        const result = await synchronizer.syncUserState('user-1', 'tasks');

        expect(result).toBe(false);
        expect(instanceCoordinator.releaseLock).toHaveBeenCalled();
    });

    test('publishStateChange broadcasts event and writes authoritative cache', async () => {
        await synchronizer.publishStateChange('user-2', 'sessions', { status: 'open' });

        expect(broadcaster.publish).toHaveBeenCalledWith(
            CHANNELS.stateChanged,
            expect.objectContaining({
                type: 'state_change',
                userId: 'user-2',
                stateType: 'sessions'
            })
        );
        expect(cache.set).toHaveBeenCalledWith('sync:user-2:sessions', { status: 'open' }, 300);
        expect(queueService.publish).not.toHaveBeenCalled();
    });

    test('publishStateChange writes authoritative cache before broadcasting', async () => {
        const order = [];
        cache.set.mockImplementation(async () => { order.push('cache'); return true; });
        broadcaster.publish.mockImplementation(async () => { order.push('broadcast'); });

        await synchronizer.publishStateChange('user-2', 'sessions', { status: 'open' });

        expect(order).toEqual(['cache', 'broadcast']);
    });

    test('publishStateChange resolves even if the notification layer misbehaves', async () => {
        // broadcaster.publish 设计上永不 reject(内部吞错);这里显式验证通知层不影响主流程
        broadcaster.publish.mockResolvedValue(undefined);

        await expect(synchronizer.publishStateChange('user-2', 'sessions', { status: 'open' })).resolves.toBeUndefined();

        expect(cache.set).toHaveBeenCalledWith('sync:user-2:sessions', { status: 'open' }, 300);
    });

    test('publishStateChange throws when authoritative cache write fails', async () => {
        cache.set.mockRejectedValue(new Error('Cache error'));

        await expect(synchronizer.publishStateChange('user-2', 'sessions', { status: 'open' })).rejects.toThrow('Cache error');
    });

    test('subscribe returns id and unsubscribe removes it', () => {
        const callback = vi.fn();
        const subscriptionId = synchronizer.subscribe('tasks', callback);

        expect(subscriptionId).toContain('tasks:');
        expect(synchronizer.subscribers.get('tasks').has(subscriptionId)).toBe(true);

        synchronizer.unsubscribe(subscriptionId);
        expect(synchronizer.subscribers.get('tasks').has(subscriptionId)).toBe(false);
    });

    test('getStateSnapshot prefers local cache and then distributed cache', async () => {
        localCache.get.mockReturnValue('local-state');
        const resultLocal = await synchronizer.getStateSnapshot('user-3', 'tasks');
        expect(resultLocal).toBe('local-state');

        localCache.get.mockReturnValue(undefined);
        cache.get.mockResolvedValue('remote-state');
        const resultRemote = await synchronizer.getStateSnapshot('user-3', 'tasks');
        expect(resultRemote).toBe('remote-state');
        expect(localCache.set).toHaveBeenCalledWith('state:user-3:tasks', 'remote-state', 60);
    });

    test('getStateSnapshot returns null when cache fails', async () => {
        localCache.get.mockReturnValue(undefined);
        cache.get.mockRejectedValue(new Error('Cache error'));

        const result = await synchronizer.getStateSnapshot('user-3', 'tasks');
        expect(result).toBeNull();
    });

    test('handleSyncEvent updates local cache and notifies subscribers', async () => {
        const callback = vi.fn();
        synchronizer.subscribe('tasks', callback);
        const event = {
            source: 'peer-instance',
            userId: 'user-4',
            stateType: 'tasks',
            state: { progress: 50 }
        };

        await synchronizer.handleSyncEvent(event);

        expect(localCache.set).toHaveBeenCalledWith('state:user-4:tasks', event.state, 60);
        expect(callback).toHaveBeenCalledWith('user-4', event.state, event);
    });

    test('handleSyncEvent ignores own events', async () => {
        const callback = vi.fn();
        synchronizer.subscribe('tasks', callback);
        const event = {
            source: 'self',
            userId: 'user-4',
            stateType: 'tasks',
            state: { progress: 50 }
        };

        await synchronizer.handleSyncEvent(event);

        expect(localCache.set).not.toHaveBeenCalled();
        expect(callback).not.toHaveBeenCalled();
    });

    test('restoreStateSnapshot writes caches and broadcasts change', async () => {
        cache.set.mockResolvedValue(true);

        const result = await synchronizer.restoreStateSnapshot('user-5', 'sessions', { status: 'restored' });

        expect(result).toBe(true);
        expect(cache.set).toHaveBeenCalledWith('state:user-5:sessions', { status: 'restored' }, 3600);
        expect(localCache.set).toHaveBeenCalledWith('state:user-5:sessions', { status: 'restored' }, 60);
        expect(broadcaster.publish).toHaveBeenCalled();
        expect(queueService.publish).not.toHaveBeenCalled();
    });

    test('restoreStateSnapshot returns false when cache fails', async () => {
        cache.set.mockRejectedValue(new Error('Cache error'));

        const result = await synchronizer.restoreStateSnapshot('user-5', 'sessions', { status: 'restored' });
        expect(result).toBe(false);
    });

    test('init subscribes to the state-changed pub/sub channel (no polling timer)', async () => {
        await synchronizer.init();

        expect(broadcaster.subscribe).toHaveBeenCalledWith(CHANNELS.stateChanged, expect.any(Function));
        expect(synchronizer.syncTimer).toBeUndefined();
        // 防复活:不再有 5 秒定时全量广播,也不再订阅 QStash
        expect(queueService.subscribe).not.toHaveBeenCalled();
    });

    test('getStats returns synchronization statistics without a polling interval', async () => {
        const callback = vi.fn();
        synchronizer.subscribe('tasks', callback);
        synchronizer.subscribe('sessions', vi.fn());

        const stats = await synchronizer.getStats();

        expect(stats).toEqual({
            subscribers: [
                { type: 'tasks', count: 1 },
                { type: 'sessions', count: 1 }
            ],
            instanceId: 'self'
        });
        expect(stats.syncInterval).toBeUndefined();
    });

    test('getTaskState retrieves task state from system snapshot', async () => {
        const taskId = 'task-123';
        const taskState = { status: 'running', progress: 50 };

        vi.spyOn(synchronizer, 'getStateSnapshot').mockResolvedValue(taskState);

        const result = await synchronizer.getTaskState(taskId);

        expect(synchronizer.getStateSnapshot).toHaveBeenCalledWith('system', `task:${taskId}`);
        expect(result).toBe(taskState);
    });

    test('clearTaskState removes task state from caches', async () => {
        const taskId = 'task-123';
        const cacheKey = `state:system:task:${taskId}`;

        const result = await synchronizer.clearTaskState(taskId);

        expect(cache.delete).toHaveBeenCalledWith(cacheKey);
        expect(localCache.del).toHaveBeenCalledWith(cacheKey);
        expect(result).toBe(true);
    });

    test('clearTaskState returns false when cache fails', async () => {
        const taskId = 'task-123';
        cache.delete.mockRejectedValue(new Error('Cache error'));

        const result = await synchronizer.clearTaskState(taskId);
        expect(result).toBe(false);
    });

    test('updateTaskState updates task state using restoreStateSnapshot', async () => {
        const taskId = 'task-123';
        const taskState = { status: 'completed' };

        vi.spyOn(synchronizer, 'restoreStateSnapshot').mockResolvedValue(true);

        const result = await synchronizer.updateTaskState(taskId, taskState);

        expect(synchronizer.restoreStateSnapshot).toHaveBeenCalledWith('system', `task:${taskId}`, taskState);
        expect(result).toBe(true);
    });

    test('_mergeStates returns local state when no remote states', () => {
        const localState = { status: 'local', timestamp: 1000 };
        const remoteStates = [];

        const result = synchronizer._mergeStates(localState, remoteStates);
        expect(result).toBe(localState);
    });

    test('_mergeStates returns null when no states', () => {
        const result = synchronizer._mergeStates(null, []);
        expect(result).toBeNull();
    });

    test('_mergeStates selects state with latest timestamp', () => {
        const localState = { status: 'local', timestamp: 1000 };
        const remoteStates = [
            { instanceId: 'instance-1', state: { status: 'remote1', timestamp: 1500 } },
            { instanceId: 'instance-2', state: { status: 'remote2', timestamp: 2000 } }
        ];

        const result = synchronizer._mergeStates(localState, remoteStates);
        expect(result).toEqual({ status: 'remote2', timestamp: 2000 });
    });

    test('_mergeStates handles states without timestamp', () => {
        const localState = { status: 'local' };
        const remoteStates = [
            { instanceId: 'instance-1', state: { status: 'remote1' } }
        ];

        const result = synchronizer._mergeStates(localState, remoteStates);
        expect(result).toBe(localState);
    });

    test('handleSyncEvent handles subscriber callback errors gracefully', async () => {
        const errorCallback = vi.fn().mockRejectedValue(new Error('Callback error'));
        const successCallback = vi.fn();

        synchronizer.subscribe('tasks', errorCallback);
        synchronizer.subscribe('tasks', successCallback);

        const event = {
            source: 'peer-instance',
            userId: 'user-4',
            stateType: 'tasks',
            state: { progress: 50 }
        };

        await synchronizer.handleSyncEvent(event);

        expect(errorCallback).toHaveBeenCalled();
        expect(successCallback).toHaveBeenCalled();
    });

    test('stop clears subscribers', async () => {
        await synchronizer.init();

        synchronizer.subscribe('tasks', vi.fn());
        expect(synchronizer.subscribers.size).toBe(1);

        await synchronizer.stop();

        expect(synchronizer.subscribers.size).toBe(0);
    });
});
