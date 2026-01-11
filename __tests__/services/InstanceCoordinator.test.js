import { instanceCoordinator } from "../../src/services/InstanceCoordinator.js";
import { cache } from "../../src/services/CacheService.js";
import logger from "../../src/services/logger.js";

// Create a mock time provider
const fixedTime = 1700000000000;

describe("Core InstanceCoordinator Tests", () => {
    let mockCacheGet, mockCacheSet, mockCacheDelete, mockCacheListKeys;
    let originalCacheMethods = {};
    let originalLoggerMethods = {};

    beforeAll(() => {
        // Save original methods
        ['get', 'set', 'delete', 'listKeys', 'getCurrentProvider'].forEach(m => {
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
        if (instanceCoordinator.heartbeatTimer) {
            clearInterval(instanceCoordinator.heartbeatTimer);
            instanceCoordinator.heartbeatTimer = null;
        }

        // Mock cache methods
        mockCacheGet = vi.fn().mockResolvedValue(null);
        mockCacheSet = vi.fn().mockResolvedValue(true);
        mockCacheDelete = vi.fn().mockResolvedValue(true);
        mockCacheListKeys = vi.fn().mockResolvedValue([]);
        
        cache.get = mockCacheGet;
        cache.set = mockCacheSet;
        cache.delete = mockCacheDelete;
        cache.listKeys = mockCacheListKeys;
        cache.getCurrentProvider = vi.fn().mockReturnValue("cloudflare");

        // Mock logger methods
        logger.info = vi.fn();
        logger.error = vi.fn();
        logger.warn = vi.fn();
        logger.debug = vi.fn();
        logger.withModule = vi.fn().mockReturnThis();
        logger.withContext = vi.fn().mockReturnThis();
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
        vi.useRealTimers();
    });

    test("should initialize correctly", async () => {
        expect(instanceCoordinator).toBeDefined();
        expect(instanceCoordinator.getInstanceId()).toEqual(expect.any(String));
    });

    test("should register instance", async () => {
        instanceCoordinator.instanceId = 'test-instance';

        await instanceCoordinator.registerInstance();

        expect(mockCacheSet).toHaveBeenCalledWith(
            "instance:test-instance",
            expect.objectContaining({
                id: "test-instance",
                status: "active"
            }),
            instanceCoordinator.instanceTimeout / 1000
        );
    });

    test("should refresh heartbeat data", async () => {
        instanceCoordinator.instanceId = 'heartbeat-instance';

        const existingInstance = {
            id: 'heartbeat-instance',
            lastHeartbeat: fixedTime - 1000,
            status: 'active'
        };

        mockCacheGet.mockResolvedValue(existingInstance);

        await instanceCoordinator._sendHeartbeat();

        expect(mockCacheSet).toHaveBeenCalledWith(
            `instance:${instanceCoordinator.instanceId}`,
            expect.objectContaining({
                status: 'active',
                lastHeartbeat: fixedTime
            }),
            instanceCoordinator.instanceTimeout / 1000
        );
    });

    test("should acquire lock successfully", async () => {
        instanceCoordinator.instanceId = 'lock-instance';
        const lockKey = 'test-lock';

        mockCacheGet
            .mockResolvedValueOnce(null) // First check in _tryAcquire
            .mockResolvedValueOnce({ // Verification check in _tryAcquire
                instanceId: instanceCoordinator.instanceId,
                acquiredAt: fixedTime,
                ttl: 60
            });

        const result = await instanceCoordinator.acquireLock(lockKey, 60, { maxAttempts: 1 });

        expect(result).toBe(true);
        expect(mockCacheSet).toHaveBeenCalledWith(
            `lock:${lockKey}`,
            expect.objectContaining({ instanceId: instanceCoordinator.instanceId }),
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

        mockCacheGet.mockResolvedValue({ instanceId: 'lock-instance' });
        await instanceCoordinator.releaseLock(lockKey);

        expect(mockCacheDelete).toHaveBeenCalledWith(`lock:${lockKey}`);
    });

    test("should verify lock ownership", async () => {
        instanceCoordinator.instanceId = 'owner-instance';
        const lockKey = 'owner-lock';

        mockCacheGet.mockResolvedValue({ instanceId: 'owner-instance' });
        const result = await instanceCoordinator.hasLock(lockKey);

        expect(result).toBe(true);
    });

    test("should list active instances", async () => {
        const instances = [
            { id: 'inst1', lastHeartbeat: fixedTime - 1000 },
            { id: 'inst2', lastHeartbeat: fixedTime - 2000 }
        ];

        // Mock getAllInstances directly on the instance for this test
        const originalGetAllInstances = instanceCoordinator.getAllInstances;
        instanceCoordinator.getAllInstances = vi.fn().mockResolvedValue(instances);

        const result = await instanceCoordinator.getActiveInstances();

        expect(result).toHaveLength(2);
        expect(instanceCoordinator.activeInstances.size).toBe(2);
        
        // Restore
        instanceCoordinator.getAllInstances = originalGetAllInstances;
    });

    test("should unregister instance", async () => {
        instanceCoordinator.instanceId = 'cleanup-instance';

        await instanceCoordinator.unregisterInstance();

        expect(mockCacheDelete).toHaveBeenCalledWith(`instance:${instanceCoordinator.instanceId}`);
    });
});
