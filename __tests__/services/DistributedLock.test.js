import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';
import { DistributedLock } from '../../src/services/DistributedLock.js';

const createMockCache = () => ({
    get: vi.fn(),
    compareAndSet: vi.fn(),
    delete: vi.fn(),
    listKeys: vi.fn().mockResolvedValue([])
});

const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
};

describe('DistributedLock - core behaviors', () => {
    let mockCache;
    let lock;

    const instanceId = 'instance-1';
    const taskId = 'task-123';

    beforeEach(() => {
        vi.clearAllMocks();
        mockCache = createMockCache();
        lock = new DistributedLock(mockCache, { logger: mockLogger, heartbeatInterval: 50, renewalThreshold: 20 });
    });

    afterEach(async () => {
        if (lock) {
            await lock.shutdown();
        }
    });

    test('acquire succeeds when cache compareAndSet wins', async () => {
        mockCache.compareAndSet.mockResolvedValue(true);

        const result = await lock.acquire(taskId, instanceId);

        expect(result).toEqual(expect.objectContaining({
            success: true,
            stolen: false,
            version: expect.any(String)
        }));
        expect(mockCache.compareAndSet).toHaveBeenCalledTimes(1);
        expect(mockCache.compareAndSet.mock.calls[0][0]).toBe(`lock:task:${taskId}`);
        expect(lock.locks.has(taskId)).toBe(true);
        const storedLock = lock.locks.get(taskId);
        expect(storedLock?.owner).toBe(instanceId);
        expect(storedLock?.version).toBe(result.version);
    });

    test('acquire returns lock_held when another instance keeps the lock', async () => {
        mockCache.compareAndSet.mockResolvedValue(false);
        mockCache.get.mockResolvedValue({
            instanceId: 'other-instance',
            expiresAt: Date.now() + 100000,
            version: 'existing-version'
        });

        const result = await lock.acquire(taskId, instanceId);

        expect(result).toMatchObject({
            success: false,
            reason: 'lock_held',
            currentOwner: 'other-instance'
        });
        expect(mockCache.compareAndSet).toHaveBeenCalled();
        expect(mockCache.delete).not.toHaveBeenCalled();
    });

    test('acquire steals an expired lock', async () => {
        const existing = {
            instanceId: 'expired-owner',
            expiresAt: Date.now() - 1000,
            version: 'old-version'
        };

        mockCache.compareAndSet
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        mockCache.get.mockResolvedValue(existing);

        const result = await lock.acquire(taskId, instanceId);

        expect(result).toMatchObject({
            success: true,
            stolen: true,
            stolenFrom: existing.instanceId
        });
        expect(mockCache.compareAndSet).toHaveBeenCalledTimes(2);
    });

    test('acquire surfaces cache errors when retries exhausted', async () => {
        mockCache.compareAndSet.mockRejectedValue(new Error('boom'));

        const result = await lock.acquire(taskId, instanceId, { maxRetries: 1 });

        expect(result.success).toBe(false);
        expect(result.reason).toBe('error');
        expect(mockLogger.error).toHaveBeenCalled();
    });

    test('release returns true when current instance owns the lock', async () => {
        mockCache.get.mockResolvedValue({
            instanceId,
            expiresAt: Date.now() + 1000
        });
        mockCache.delete.mockResolvedValue(true);

        const success = await lock.release(taskId, instanceId);

        expect(success).toBe(true);
        expect(mockCache.delete).toHaveBeenCalledWith(`lock:task:${taskId}`);
    });

    test('release returns false when lock belongs to another instance', async () => {
        mockCache.get.mockResolvedValue({
            instanceId: 'other',
            expiresAt: Date.now() + 1000
        });

        const success = await lock.release(taskId, instanceId);

        expect(success).toBe(false);
        expect(mockCache.delete).not.toHaveBeenCalled();
    });

    test('release returns false on cache delete failure', async () => {
        mockCache.get.mockResolvedValue({
            instanceId,
            expiresAt: Date.now() + 1000
        });
        mockCache.delete.mockRejectedValue(new Error('boom'));

        const success = await lock.release(taskId, instanceId);

        expect(success).toBe(false);
        expect(mockLogger.error).toHaveBeenCalled();
    });

    test('forceRelease deletes the lock regardless of owner', async () => {
        mockCache.get.mockResolvedValue({
            instanceId: 'remote',
            expiresAt: Date.now() + 1000
        });
        mockCache.delete.mockResolvedValue(true);

        const success = await lock.forceRelease(taskId, 'admin-instance');

        expect(success).toBe(true);
        expect(mockCache.delete).toHaveBeenCalledWith(`lock:task:${taskId}`);
    });

    test('forceRelease returns false when delete fails', async () => {
        mockCache.get.mockResolvedValue(null);
        mockCache.delete.mockRejectedValue(new Error('boom'));

        const success = await lock.forceRelease(taskId, 'admin-instance');

        expect(success).toBe(false);
        expect(mockLogger.error).toHaveBeenCalled();
    });

    test('getLockStatus reports held locks', async () => {
        const now = Date.now();
        mockCache.get.mockResolvedValue({
            instanceId,
            expiresAt: now + 10000,
            version: 'v1',
            acquiredAt: now - 1000,
            heartbeatCount: 2
        });

        const status = await lock.getLockStatus(taskId);

        expect(status.status).toBe('held');
        expect(status.owner).toBe(instanceId);
        expect(status.remainingMs).toBeGreaterThanOrEqual(0);
    });

    test('getLockStatus reports expired locks', async () => {
        const now = Date.now();
        mockCache.get.mockResolvedValue({
            instanceId,
            expiresAt: now - 1000,
            version: 'v1',
            acquiredAt: now - 5000
        });

        const status = await lock.getLockStatus(taskId);

        expect(status.status).toBe('expired');
        expect(status.remainingMs).toBe(0);
    });

    test('getLockStatus treats invalid expiresAt as expired', async () => {
        mockCache.get.mockResolvedValue({
            instanceId,
            expiresAt: 'not-a-timestamp',
            version: 'v1',
            acquiredAt: Date.now() - 5000
        });

        const status = await lock.getLockStatus(taskId);

        expect(status.status).toBe('expired');
        expect(status.remainingMs).toBe(0);
    });

    test('cleanupExpiredLocks should not throw on missing expiresAt', async () => {
        mockCache.listKeys.mockResolvedValue(['lock:task:bad']);
        mockCache.get.mockResolvedValue({
            instanceId: 'some-instance'
            // expiresAt missing (corrupted/legacy)
        });

        await lock.cleanupExpiredLocks();

        expect(mockCache.delete).toHaveBeenCalledWith('lock:task:bad');
        expect(mockLogger.error).not.toHaveBeenCalledWith(
            'Error cleaning up expired locks',
            expect.anything()
        );
    });

    test('getLockStatus reports released when missing', async () => {
        mockCache.get.mockResolvedValue(null);

        const status = await lock.getLockStatus(taskId);

        expect(status.status).toBe('released');
        expect(status.taskId).toBe(taskId);
    });

    test('getStats aggregates held and expired locks', async () => {
        const base = Date.now();
        mockCache.listKeys.mockResolvedValue(['lock:task:held', 'lock:task:expired']);
        mockCache.get.mockImplementation(async (key) => {
            if (key.endsWith(':held')) {
                return {
                    instanceId,
                    expiresAt: base + 10000
                };
            }
            return {
                instanceId: 'expired-owner',
                expiresAt: base - 1000
            };
        });
        lock.locks.set('local-task', {
            owner: instanceId,
            expiresAt: base + 1000,
            heartbeatId: null,
            version: 'v-local'
        });

        const stats = await lock.getStats();

        expect(stats).toMatchObject({
            total: 2,
            held: 1,
            expired: 1,
            local: 1
        });
        expect(stats.timestamp).toBeGreaterThan(0);
    });
});
