import { vi, describe, test, expect, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import { instanceCoordinator } from "../../src/services/InstanceCoordinator.js";
import { cache } from "../../src/services/CacheService.js";
import { InstanceRepository } from "../../src/repositories/InstanceRepository.js";
import logger from "../../src/services/logger/index.js";

// Mock InstanceRepository
vi.mock("../../src/repositories/InstanceRepository.js", () => ({
    InstanceRepository: {
        upsert: vi.fn(),
        findById: vi.fn(),
        findAll: vi.fn(),
        findAllActive: vi.fn(),
        markOffline: vi.fn(),
        deleteExpired: vi.fn(),
    },
}));

// Create a mock time provider
const fixedTime = 1700000000000;

describe("Core InstanceCoordinator Tests", () => {
    let mockCacheGet, mockCacheSet, mockCacheDelete, mockCacheListKeys, mockCacheCompareAndSet, mockSupportsAtomicCompareAndSet, mockCacheDeleteIfEquals;
    let originalCacheMethods = {};
    let originalLoggerMethods = {};

    beforeAll(() => {
        // Save original methods
        ['get', 'set', 'delete', 'listKeys', 'getCurrentProvider', 'compareAndSet', 'supportsAtomicCompareAndSet', 'deleteIfEquals'].forEach(m => {
            originalCacheMethods[m] = cache[m];
        });
        ['info', 'error', 'warn', 'debug', 'withModule', 'withContext'].forEach(m => {
            originalLoggerMethods[m] = logger[m];
        });
    });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(fixedTime);

        // Reset instanceCoordinator state
        instanceCoordinator.instanceId = 'test-instance';
        instanceCoordinator.activeInstances = new Set();
        instanceCoordinator.isLeader = false;
        instanceCoordinator.atomicLockWarningsShown = new Set();
        instanceCoordinator._stopAllTaskLockRenewals();
        if (instanceCoordinator.heartbeatTimer) {
            clearInterval(instanceCoordinator.heartbeatTimer);
            instanceCoordinator.heartbeatTimer = null;
        }
        if (instanceCoordinator.lockRenewalTimer) {
            clearInterval(instanceCoordinator.lockRenewalTimer);
            instanceCoordinator.lockRenewalTimer = null;
        }
        if (instanceCoordinator.heartbeatAdjustTimer) {
            clearInterval(instanceCoordinator.heartbeatAdjustTimer);
            instanceCoordinator.heartbeatAdjustTimer = null;
        }
        if (instanceCoordinator.instanceWatchTimer) {
            clearInterval(instanceCoordinator.instanceWatchTimer);
            instanceCoordinator.instanceWatchTimer = null;
        }

        // Mock cache methods
        mockCacheGet = vi.fn().mockResolvedValue(null);
        mockCacheSet = vi.fn().mockResolvedValue(true);
        mockCacheDelete = vi.fn().mockResolvedValue(true);
        mockCacheListKeys = vi.fn().mockResolvedValue([]);
        mockCacheCompareAndSet = vi.fn().mockResolvedValue(true);
        mockSupportsAtomicCompareAndSet = vi.fn().mockReturnValue(true);
        mockCacheDeleteIfEquals = vi.fn().mockResolvedValue(true);
        
        cache.get = mockCacheGet;
        cache.set = mockCacheSet;
        cache.delete = mockCacheDelete;
        cache.listKeys = mockCacheListKeys;
        cache.getCurrentProvider = vi.fn().mockReturnValue("cloudflare");
        cache.compareAndSet = mockCacheCompareAndSet;
        cache.supportsAtomicCompareAndSet = mockSupportsAtomicCompareAndSet;
        cache.deleteIfEquals = mockCacheDeleteIfEquals;

        // Mock logger methods
        logger.info = vi.fn();
        logger.error = vi.fn();
        logger.warn = vi.fn();
        logger.debug = vi.fn();
        logger.withModule = vi.fn().mockReturnThis();
        logger.withContext = vi.fn().mockReturnThis();

        // Reset Repository Mocks
        vi.mocked(InstanceRepository.upsert).mockResolvedValue(true);
        vi.mocked(InstanceRepository.findById).mockResolvedValue(null);
        vi.mocked(InstanceRepository.findAll).mockResolvedValue([]);
        vi.mocked(InstanceRepository.findAllActive).mockResolvedValue([]);
        vi.mocked(InstanceRepository.markOffline).mockResolvedValue(true);
    });

    afterAll(() => {
        // Restore original methods
        Object.keys(originalCacheMethods).forEach(m => {
            cache[m] = originalCacheMethods[m];
        });
        Object.keys(originalLoggerMethods).forEach(m => {
            logger[m] = originalLoggerMethods[m];
        });
    });

    afterEach(() => {
        instanceCoordinator._stopAllTaskLockRenewals();
        vi.useRealTimers();
    });

    test("should initialize correctly", async () => {
        expect(instanceCoordinator).toBeDefined();
        expect(instanceCoordinator.getInstanceId()).toEqual(expect.any(String));
    });

    test("should register instance", async () => {
        instanceCoordinator.instanceId = 'test-instance';
        process.env.INSTANCE_PUBLIC_URL = 'https://worker.example.com/';
        process.env.APP_EXTERNAL_URL = 'https://lb.example.com/';

        await instanceCoordinator.registerInstance();

        expect(InstanceRepository.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "test-instance",
                status: "active",
                url: "https://worker.example.com"
            })
        );
    });

    test("should throw when instance registration fails", async () => {
        instanceCoordinator.instanceId = 'broken-instance';
        vi.mocked(InstanceRepository.upsert).mockRejectedValueOnce(new Error('cache unavailable'));

        await expect(instanceCoordinator.registerInstance()).rejects.toThrow('cache unavailable');
    });

    test("should refresh heartbeat data", async () => {
        instanceCoordinator.instanceId = 'heartbeat-instance';

        const existingInstance = {
            id: 'heartbeat-instance',
            lastHeartbeat: fixedTime - 1000,
            status: 'active'
        };

        vi.mocked(InstanceRepository.findById).mockResolvedValue(existingInstance);

        await instanceCoordinator._sendHeartbeat();

        expect(InstanceRepository.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'heartbeat-instance',
                lastHeartbeat: fixedTime
            })
        );
    });

    test("should acquire lock successfully", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        const lockKey = 'test-lock';

        mockCacheGet.mockResolvedValueOnce(null);
        mockCacheCompareAndSet.mockResolvedValueOnce(true);

        const result = await instanceCoordinator.acquireLock(lockKey, 60, { maxAttempts: 1 });

        expect(result).toBe(true);
        expect(mockCacheCompareAndSet).toHaveBeenCalledWith(
            `lock:${lockKey}`,
            expect.objectContaining({
                instanceId: instanceCoordinator.instanceId,
                leaseId: expect.stringContaining(`${instanceCoordinator.instanceId}:`)
            }),
            expect.objectContaining({ ifNotExists: true, ttl: 60 })
        );
    });

    test("should expose the current lock lease only to the lock owner", async () => {
        instanceCoordinator.instanceId = 'owner-instance';
        mockCacheGet.mockResolvedValue({
            instanceId: 'owner-instance',
            leaseId: 'owner-instance:lease-1',
            acquiredAt: fixedTime,
            ttl: 60
        });

        await expect(instanceCoordinator.getLockLease('telegram_client')).resolves.toEqual({
            instanceId: 'owner-instance',
            leaseId: 'owner-instance:lease-1',
            acquiredAt: fixedTime,
            ttl: 60
        });
    });

    test("should preserve lease id while renewing a lock owned by this instance", async () => {
        instanceCoordinator.instanceId = 'owner-instance';

        const renewed = instanceCoordinator._createLockValue('telegram_client', 90, {
            instanceId: 'owner-instance',
            leaseId: 'owner-instance:lease-1',
            acquiredAt: fixedTime - 1000,
            ttl: 90
        });

        expect(renewed).toMatchObject({
            instanceId: 'owner-instance',
            leaseId: 'owner-instance:lease-1',
            acquiredAt: fixedTime,
            ttl: 90
        });
    });

    test("should mint a new lease id when taking over another owner lock", async () => {
        instanceCoordinator.instanceId = 'owner-instance';

        const lockValue = instanceCoordinator._createLockValue('telegram_client', 90, {
            instanceId: 'other-instance',
            leaseId: 'other-instance:old-lease',
            acquiredAt: fixedTime - 100000,
            ttl: 90
        });

        expect(lockValue).toMatchObject({
            instanceId: 'owner-instance',
            ttl: 90
        });
        expect(lockValue.leaseId).toContain('owner-instance:');
        expect(lockValue.leaseId).not.toBe('other-instance:old-lease');
    });

    test("should fail closed when current provider cannot guarantee atomic CAS", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        mockSupportsAtomicCompareAndSet.mockReturnValue(false);

        const result = await instanceCoordinator.acquireLock('telegram_client', 60, { maxAttempts: 1 });

        expect(result).toBe(false);
        expect(mockCacheGet).not.toHaveBeenCalled();
        expect(mockCacheCompareAndSet).not.toHaveBeenCalled();
    });

    test("should fail closed for message dedup locks without atomic CAS", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        mockSupportsAtomicCompareAndSet.mockReturnValue(false);

        const result = await instanceCoordinator.acquireLock('msg_lock:102', 60, { maxAttempts: 1 });

        expect(result).toBe(false);
        expect(mockCacheGet).not.toHaveBeenCalled();
        expect(mockCacheSet).not.toHaveBeenCalled();
        expect(mockCacheCompareAndSet).not.toHaveBeenCalled();
    });

    test("should fail closed for task processing locks without atomic CAS", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        mockSupportsAtomicCompareAndSet.mockReturnValue(false);

        const result = await instanceCoordinator.acquireLock('task:123', 60, { maxAttempts: 1 });

        expect(result).toBe(false);
        expect(mockCacheGet).not.toHaveBeenCalled();
        expect(mockCacheSet).not.toHaveBeenCalled();
        expect(mockCacheCompareAndSet).not.toHaveBeenCalled();
    });

    test("should fail closed for stalled recovery locks without atomic CAS", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        mockSupportsAtomicCompareAndSet.mockReturnValue(false);

        const result = await instanceCoordinator.acquireLock('task_recovery:stalled', 120, { maxAttempts: 1 });

        expect(result).toBe(false);
        expect(mockCacheGet).not.toHaveBeenCalled();
        expect(mockCacheSet).not.toHaveBeenCalled();
        expect(mockCacheCompareAndSet).not.toHaveBeenCalled();
    });

    test("should keep best-effort locking for non-critical advisory locks without atomic CAS", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        mockSupportsAtomicCompareAndSet.mockReturnValue(false);
        mockCacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                instanceId: 'lock-instance',
                acquiredAt: fixedTime,
                ttl: 60
            });

        const result = await instanceCoordinator.acquireLock('advisory:maintenance', 60, { maxAttempts: 1 });

        expect(result).toBe(true);
        expect(mockCacheCompareAndSet).not.toHaveBeenCalled();
        expect(mockCacheSet).toHaveBeenCalledWith(
            "lock:advisory:maintenance",
            expect.objectContaining({ instanceId: 'lock-instance' }),
            60,
            expect.objectContaining({ skipCache: true })
        );
    });

    test("should fail to acquire existing lock", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        const lockKey = 'existing-lock';

        mockCacheGet.mockResolvedValue({
            instanceId: 'other-instance',
            acquiredAt: fixedTime,
            ttl: 60
        });

        const result = await instanceCoordinator.acquireLock(lockKey, 60, { maxAttempts: 1 });

        expect(result).toBe(false);
    });

    test("should release lock", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        const lockKey = 'test-lock';
        const lockValue = { instanceId: 'lock-instance' };

        mockCacheGet.mockResolvedValue(lockValue);
        await instanceCoordinator.releaseLock(lockKey);

        expect(mockCacheDeleteIfEquals).toHaveBeenCalledWith(
            `lock:${lockKey}`,
            lockValue,
            expect.objectContaining({ requireAtomic: false })
        );
        expect(mockCacheDelete).not.toHaveBeenCalled();
    });

    test("should not release telegram lock without atomic conditional delete", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        cache.deleteIfEquals = undefined;
        mockCacheGet.mockResolvedValue({ instanceId: 'lock-instance' });

        const released = await instanceCoordinator.releaseLock('telegram_client');

        expect(released).toBe(false);
        expect(mockCacheDelete).not.toHaveBeenCalled();
    });

    test("should not release task lock without atomic conditional delete", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        cache.deleteIfEquals = undefined;
        mockCacheGet.mockResolvedValue({ instanceId: 'lock-instance' });

        const released = await instanceCoordinator.releaseLock('task:123');

        expect(released).toBe(false);
        expect(mockCacheDelete).not.toHaveBeenCalled();
    });

    test("should start renewal for acquired task processing locks", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        mockCacheGet.mockResolvedValueOnce(null);
        mockCacheCompareAndSet.mockResolvedValueOnce(true);
        mockCacheGet.mockResolvedValueOnce({
            instanceId: 'lock-instance',
            leaseId: 'lock-instance:lease-1',
            acquiredAt: fixedTime,
            ttl: 600
        });

        const acquired = await instanceCoordinator.acquireTaskLock('task-1');

        expect(acquired).toBe(true);
        expect(instanceCoordinator.taskLockRenewalTimers.has('task-1')).toBe(true);
        expect(mockCacheCompareAndSet).toHaveBeenCalledWith(
            'lock:task:task-1',
            expect.objectContaining({ instanceId: 'lock-instance' }),
            expect.objectContaining({ ifNotExists: true, ttl: 600 })
        );
    });

    test("should not report task lock acquired when lease cannot be read", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        mockCacheGet
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null);
        mockCacheCompareAndSet.mockResolvedValueOnce(true);

        const acquired = await instanceCoordinator.acquireTaskLock('task-1');

        expect(acquired).toBe(false);
        expect(instanceCoordinator.taskLockRenewalTimers.has('task-1')).toBe(false);
        expect(mockCacheGet).toHaveBeenCalledWith('lock:task:task-1', 'json', { skipCache: true });
    });

    test("should release acquired task lock when lease read fails", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        mockCacheGet
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new Error('cache read failed'))
            .mockResolvedValueOnce({ instanceId: 'lock-instance', leaseId: 'lock-instance:lease-1' });
        mockCacheCompareAndSet.mockResolvedValueOnce(true);
        mockCacheDeleteIfEquals.mockResolvedValueOnce(true);

        await expect(instanceCoordinator.acquireTaskLock('task-1')).rejects.toThrow('cache read failed');

        expect(instanceCoordinator.taskLockRenewalTimers.has('task-1')).toBe(false);
        expect(mockCacheDeleteIfEquals).toHaveBeenCalledWith(
            'lock:task:task-1',
            expect.objectContaining({ instanceId: 'lock-instance' }),
            expect.objectContaining({ requireAtomic: true })
        );
    });

    test("should renew owned task lock with the same lease", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        const currentLock = {
            instanceId: 'lock-instance',
            leaseId: 'lock-instance:lease-1',
            acquiredAt: fixedTime - 1000,
            ttl: 600
        };
        const lease = {
            instanceId: 'lock-instance',
            leaseId: 'lock-instance:lease-1'
        };
        mockCacheGet.mockResolvedValue(currentLock);
        mockCacheCompareAndSet.mockResolvedValue(true);

        const renewed = await instanceCoordinator.renewLock('task:task-1', lease, 600);

        expect(renewed).toBe(true);
        expect(mockCacheCompareAndSet).toHaveBeenCalledWith(
            'lock:task:task-1',
            expect.objectContaining({
                instanceId: 'lock-instance',
                leaseId: 'lock-instance:lease-1',
                acquiredAt: fixedTime,
                ttl: 600
            }),
            expect.objectContaining({ ifEquals: currentLock, ttl: 600 })
        );
    });

    test("should stop task lock renewal before release", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        const timer = setInterval(() => {}, 60000);
        instanceCoordinator.taskLockRenewalTimers.set('task-1', timer);
        mockCacheGet.mockResolvedValue({ instanceId: 'lock-instance', leaseId: 'lock-instance:lease-1' });
        mockCacheDeleteIfEquals.mockResolvedValue(true);

        await instanceCoordinator.releaseTaskLock('task-1');

        expect(instanceCoordinator.taskLockRenewalTimers.has('task-1')).toBe(false);
        expect(mockCacheDeleteIfEquals).toHaveBeenCalledWith(
            'lock:task:task-1',
            expect.objectContaining({ leaseId: 'lock-instance:lease-1' }),
            expect.objectContaining({ requireAtomic: true })
        );
    });

    test("should verify lock ownership", async () => {
        instanceCoordinator.instanceId = 'owner-instance';
        const lockKey = 'owner-lock';

        mockCacheGet.mockResolvedValue({ instanceId: 'owner-instance' });
        const result = await instanceCoordinator.hasLock(lockKey);

        expect(result).toBe(true);
    });

    test("should support quiet lock ownership probes for normal standby checks", async () => {
        instanceCoordinator.instanceId = 'standby-instance';
        const lockKey = 'owner-lock';

        mockCacheGet.mockResolvedValue({ instanceId: 'leader-instance' });
        const result = await instanceCoordinator.hasLock(lockKey, { logContention: false });

        expect(result).toBe(false);
        expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('[Lock]'));
    });

    test("should renew telegram client lock without warning from standby instances", async () => {
        instanceCoordinator.instanceId = 'standby-instance';
        mockCacheGet.mockResolvedValue({ instanceId: 'leader-instance' });

        await instanceCoordinator.startHeartbeat();
        await vi.runOnlyPendingTimersAsync();

        expect(mockCacheGet).toHaveBeenCalledWith("lock:telegram_client", "json", { skipCache: true });
        expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('[Lock] telegram_client is held by'));
        expect(mockCacheSet).not.toHaveBeenCalledWith(
            "lock:telegram_client",
            expect.anything(),
            300,
            expect.objectContaining({ skipCache: true })
        );
        expect(mockCacheCompareAndSet).not.toHaveBeenCalled();
    });

    test("should renew owned telegram client lock through CAS", async () => {
        instanceCoordinator.instanceId = 'leader-instance';
        const currentLock = {
            instanceId: 'leader-instance',
            acquiredAt: fixedTime - 1000,
            ttl: 90
        };
        mockCacheGet.mockResolvedValue(currentLock);
        mockCacheCompareAndSet.mockResolvedValue(true);

        await instanceCoordinator.startHeartbeat();
        await vi.runOnlyPendingTimersAsync();

        expect(mockCacheCompareAndSet).toHaveBeenCalledWith(
            "lock:telegram_client",
            expect.objectContaining({
                instanceId: 'leader-instance',
                acquiredAt: fixedTime
            }),
            expect.objectContaining({ ifEquals: currentLock, ttl: 90 })
        );
    });

    test("should replace existing heartbeat and lock renewal timers when heartbeat restarts", async () => {
        instanceCoordinator.instanceId = 'leader-instance';
        mockCacheGet.mockResolvedValue({
            instanceId: 'leader-instance',
            acquiredAt: fixedTime - 1000,
            ttl: 90
        });

        await instanceCoordinator.startHeartbeat();
        const firstHeartbeatTimer = instanceCoordinator.heartbeatTimer;
        const firstRenewalTimer = instanceCoordinator.lockRenewalTimer;
        await instanceCoordinator.startHeartbeat();

        expect(instanceCoordinator.heartbeatTimer).not.toBe(firstHeartbeatTimer);
        expect(instanceCoordinator.lockRenewalTimer).not.toBe(firstRenewalTimer);
    });

    test("should not preempt a live telegram lock just because owner heartbeat is missing", async () => {
        instanceCoordinator.instanceId = 'standby-instance';
        mockCacheGet.mockResolvedValue({
            instanceId: 'leader-instance',
            acquiredAt: fixedTime,
            ttl: 90
        });

        const acquired = await instanceCoordinator.acquireLock('telegram_client', 90, { maxAttempts: 1 });

        expect(acquired).toBe(false);
        expect(mockCacheCompareAndSet).not.toHaveBeenCalledWith(
            'lock:telegram_client',
            expect.objectContaining({ instanceId: 'standby-instance' }),
            expect.objectContaining({ ifEquals: expect.anything() })
        );
    });

    test("should list active instances", async () => {
        const instances = [
            { id: 'inst1', lastHeartbeat: fixedTime - 1000 },
            { id: 'inst2', lastHeartbeat: fixedTime - 2000 }
        ];

        vi.mocked(InstanceRepository.findAllActive).mockResolvedValue(instances);

        const result = await instanceCoordinator.getActiveInstances();

        expect(result).toHaveLength(2);
        expect(instanceCoordinator.activeInstances.size).toBe(2);
    });

    test("should pass strong consistency option to active instance lookups", async () => {
        vi.mocked(InstanceRepository.findAllActive).mockResolvedValue([]);

        await instanceCoordinator.getActiveInstances({ strong: true });

        expect(InstanceRepository.findAllActive).toHaveBeenCalledWith(
            instanceCoordinator.instanceTimeout,
            { strong: true }
        );
    });

    test("should unregister instance", async () => {
        instanceCoordinator.instanceId = 'cleanup-instance';

        await instanceCoordinator.unregisterInstance();

        expect(InstanceRepository.markOffline).toHaveBeenCalledWith(instanceCoordinator.instanceId);
    });
});
