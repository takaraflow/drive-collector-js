import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Create a mock time provider
const fixedTime = 1700000000000;
const mockTimeProvider = {
    now: () => fixedTime,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval
};

const importInstanceCoordinator = async () => {
    const module = await import("../../src/services/InstanceCoordinator.js");
    return module.instanceCoordinator ?? module.default;
};

describe("Core InstanceCoordinator Tests", () => {
    let instanceCoordinator;
    let mockCache;
    let mockLogger;

    beforeEach(async () => {
        jest.resetModules();
        jest.clearAllMocks();
        jest.useFakeTimers();

        // Mock time provider
        await jest.unstable_mockModule('../../src/utils/timeProvider.js', () => ({
            getTime: mockTimeProvider.now,
            timers: mockTimeProvider
        }));

        // Mock environment
        await jest.unstable_mockModule('../../src/config/env.js', () => ({
            getEnv: () => ({ NODE_ENV: 'test' }),
            NODE_ENV: 'test'
        }));

        // Mock logger (already done by global setup)
        mockLogger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            withModule: jest.fn().mockReturnThis(),
            withContext: jest.fn().mockReturnThis()
        };

        // Mock CacheService
        mockCache = {
            initialize: jest.fn().mockResolvedValue(undefined),
            get: jest.fn(),
            set: jest.fn(),
            delete: jest.fn(),
            listKeys: jest.fn(),
            getCurrentProvider: jest.fn().mockReturnValue("cloudflare"),
            _startHeartbeat: jest.fn()
        };

        await jest.unstable_mockModule("../../src/services/logger.js", () => ({
            default: mockLogger,
            logger: mockLogger,
            setInstanceIdProvider: jest.fn()
        }));

        await jest.unstable_mockModule("../../src/services/CacheService.js", () => ({
            cache: mockCache
        }));

        await jest.unstable_mockModule("../../src/repositories/InstanceRepository.js", () => ({
            InstanceRepository: {
                createTableIfNotExists: jest.fn().mockResolvedValue(undefined),
                findAll: jest.fn().mockResolvedValue([]),
                upsert: jest.fn().mockResolvedValue(true),
                updateHeartbeat: jest.fn().mockResolvedValue(true)
            }
        }));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test("should initialize correctly", async () => {
        const instanceCoordinator = await importInstanceCoordinator();
        
        expect(instanceCoordinator).toBeDefined();
        expect(instanceCoordinator.getInstanceId()).toEqual(expect.any(String));
    });

    test("should register instance", async () => {
        const instanceCoordinator = await importInstanceCoordinator();
        instanceCoordinator.instanceId = 'test-instance';

        await instanceCoordinator.registerInstance();

        expect(mockCache.set).toHaveBeenCalledWith(
            "instance:test-instance",
            expect.objectContaining({
                id: "test-instance",
                status: "active"
            }),
            instanceCoordinator.instanceTimeout / 1000
        );
    });

    test("should refresh heartbeat data", async () => {
        const instanceCoordinator = await importInstanceCoordinator();
        instanceCoordinator.instanceId = 'heartbeat-instance';

        const existingInstance = {
            id: 'heartbeat-instance',
            lastHeartbeat: fixedTime - 1000,
            status: 'active'
        };

        mockCache.get.mockResolvedValue(existingInstance);
        mockCache.set.mockResolvedValue(true);
        jest.setSystemTime(fixedTime);

        await instanceCoordinator._sendHeartbeat();

        expect(mockCache.set).toHaveBeenCalledWith(
            `instance:${instanceCoordinator.instanceId}`,
            expect.objectContaining({
                status: 'active',
                lastHeartbeat: expect.any(Number)
            }),
            instanceCoordinator.instanceTimeout / 1000
        );
    });

    test("should acquire lock successfully", async () => {
        const instanceCoordinator = await importInstanceCoordinator();
        instanceCoordinator.instanceId = 'lock-instance';
        const lockKey = 'test-lock';

        mockCache.get
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                instanceId: instanceCoordinator.instanceId,
                acquiredAt: fixedTime,
                ttl: 60
            });
        mockCache.set.mockResolvedValue(true);

        const result = await instanceCoordinator.acquireLock(lockKey, 60, { maxAttempts: 1 });

        expect(result).toBe(true);
        expect(mockCache.set).toHaveBeenCalledWith(
            `lock:${lockKey}`,
            expect.objectContaining({ instanceId: instanceCoordinator.instanceId }),
            60,
            expect.objectContaining({ skipCache: true })
        );
    });

    test("should fail to acquire existing lock", async () => {
        const instanceCoordinator = await importInstanceCoordinator();
        const lockKey = 'existing-lock';

        mockCache.get
            .mockResolvedValueOnce({
                instanceId: 'other-instance',
                acquiredAt: fixedTime,
                ttl: 60
            })
            .mockResolvedValueOnce({
                instanceId: 'other-instance',
                acquiredAt: fixedTime,
                ttl: 60
            });
        mockCache.set.mockResolvedValue(true);

        const result = await instanceCoordinator.acquireLock(lockKey, 60, { maxAttempts: 1 });

        expect(result).toBe(false);
    });

    test("should release lock", async () => {
        const instanceCoordinator = await importInstanceCoordinator();
        instanceCoordinator.instanceId = 'lock-instance';
        const lockKey = 'test-lock';

        mockCache.get.mockResolvedValue({ instanceId: 'lock-instance' });
        await instanceCoordinator.releaseLock(lockKey);

        expect(mockCache.delete).toHaveBeenCalledWith(`lock:${lockKey}`);
    });

    test("should verify lock ownership", async () => {
        const instanceCoordinator = await importInstanceCoordinator();
        const lockKey = 'owner-lock';

        mockCache.get.mockResolvedValue({ instanceId: instanceCoordinator.instanceId });
        const result = await instanceCoordinator.hasLock(lockKey);

        expect(result).toBe(true);
    });

    test("should list active instances", async () => {
        const instanceCoordinator = await importInstanceCoordinator();
        const instances = [
            { id: 'inst1', lastHeartbeat: fixedTime - 1000 },
            { id: 'inst2', lastHeartbeat: fixedTime - 2000 }
        ];

        instanceCoordinator.getAllInstances = jest.fn().mockResolvedValue(instances);
        jest.setSystemTime(fixedTime);

        const result = await instanceCoordinator.getActiveInstances();

        expect(result).toHaveLength(2);
        expect(instanceCoordinator.activeInstances.size).toBe(2);
    });

    test("should unregister instance", async () => {
        const instanceCoordinator = await importInstanceCoordinator();
        instanceCoordinator.instanceId = 'cleanup-instance';

        await instanceCoordinator.unregisterInstance();

        expect(mockCache.delete).toHaveBeenCalledWith(`instance:${instanceCoordinator.instanceId}`);
    });
});
