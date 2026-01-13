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

vi.mock('../../src/services/QueueService.js', () => ({
    queueService: {
        publish: vi.fn().mockResolvedValue(true),
        subscribe: vi.fn().mockResolvedValue(true)
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
import { localCache } from '../../src/utils/LocalCache.js';
import { StateSynchronizer } from '../../src/services/StateSynchronizer.js';

describe('StateSynchronizer - synchronization workflow', () => {
    let synchronizer;

    beforeEach(() => {
        vi.clearAllMocks();
        cache.get.mockResolvedValue(null);
        cache.set.mockResolvedValue(true);
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

    test('syncUserState merges remote state, publishes change, and releases lock', async () => {
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
        expect(queueService.publish).toHaveBeenCalledWith('state_sync', expect.objectContaining({ userId, stateType }));
    });

    test('publishStateChange pushes event to queue and cache', async () => {
        await synchronizer.publishStateChange('user-2', 'sessions', { status: 'open' });

        expect(queueService.publish).toHaveBeenCalledWith(
            'state_sync',
            expect.objectContaining({
                type: 'state_change',
                userId: 'user-2',
                stateType: 'sessions'
            })
        );
        expect(cache.set).toHaveBeenCalledWith('sync:user-2:sessions', { status: 'open' }, 300);
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

    test('restoreStateSnapshot writes caches and publishes change', async () => {
        cache.set.mockResolvedValue(true);

        const result = await synchronizer.restoreStateSnapshot('user-5', 'sessions', { status: 'restored' });

        expect(result).toBe(true);
        expect(cache.set).toHaveBeenCalledWith('state:user-5:sessions', { status: 'restored' }, 3600);
        expect(localCache.set).toHaveBeenCalledWith('state:user-5:sessions', { status: 'restored' }, 60);
        expect(queueService.publish).toHaveBeenCalled();
    });

    test('init subscribes to queue and schedules periodic sync', async () => {
        await synchronizer.init();

        expect(queueService.subscribe).toHaveBeenCalledWith('state_sync', expect.any(Function));
        expect(synchronizer.syncTimer).not.toBeNull();
    });
});
