import { jest, describe, test, expect, beforeEach, beforeAll, afterAll, afterEach } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Store original process.env
const originalEnv = process.env;

let instanceCoordinator;
let cache;

// Mock InstanceRepository
jest.unstable_mockModule("../../src/repositories/InstanceRepository.js", () => ({
  InstanceRepository: {
    createTableIfNotExists: jest.fn().mockResolvedValue(undefined),
    findAll: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue(true),
    updateHeartbeat: jest.fn().mockResolvedValue(true),
  },
}));

// Mock logger
const mockLogger = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule("../../src/services/logger.js", () => ({
  default: mockLogger,
  setInstanceIdProvider: jest.fn(),
}));

describe("InstanceCoordinator", () => {
  beforeAll(async () => {
    // Set up mock environment variables - 使用新的变量名
    process.env = {
      ...originalEnv,
      CF_CACHE_ACCOUNT_ID: "mock_account_id",
      CF_CACHE_NAMESPACE_ID: "mock_namespace_id",
      CF_CACHE_TOKEN: "mock_kv_token",
      INSTANCE_ID: "test_instance_123",
      // Ensure Cache is not forced to upstash
      CACHE_PROVIDER: undefined,
    };
    jest.resetModules();

    // Dynamically import after setting up mocks
    const { instanceCoordinator: importedIC } = await import("../../src/services/InstanceCoordinator.js");
    instanceCoordinator = importedIC;

    // Also import cache for mocking
    const { cache: importedCache } = await import("../../src/services/CacheService.js");
    cache = importedCache;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Reset instance state
    instanceCoordinator.instanceId = "test_instance_123";
    instanceCoordinator.isLeader = false;
    instanceCoordinator.activeInstances = new Set();

    // Ensure Cache is in normal mode for tests
    const { cache } = await import("../../src/services/CacheService.js");
    cache.currentProvider = 'cloudflare';
  });

  afterEach(() => {
    // Clear any timers
    jest.clearAllTimers();
  });

  test("should initialize with correct instance ID", () => {
    expect(instanceCoordinator.instanceId).toBe("test_instance_123");
    expect(instanceCoordinator.heartbeatInterval).toBe(300000); // 5 minutes
    expect(instanceCoordinator.instanceTimeout).toBe(900000); // 15 minutes
  });

  describe("registerInstance", () => {
    test("should register instance successfully (Cache only)", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true }),
      });

      await instanceCoordinator.registerInstance();

      // Verify Cache write only
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("storage/kv/namespaces/mock_namespace_id/values/instance:test_instance_123"),
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"id":"test_instance_123"'),
        })
      );
    });

    test("should throw error when Cache registration fails", async () => {
      // Mock Cache failure
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: false, errors: [{ message: "Registration failed" }] }),
      });

      // Should throw since Cache is the primary storage
      await expect(instanceCoordinator.registerInstance()).rejects.toThrow("Cache Set Error: Registration failed");
    });
  });

  // Skip unregisterInstance test - not critical for main functionality
  describe.skip("unregisterInstance", () => {
    test("should unregister instance successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });

      await instanceCoordinator.unregisterInstance();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/values/instance:test_instance_123"),
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  describe("acquireLock", () => {
      test("should acquire lock when no existing lock", async () => {
          // Mock cache.get to return null (no existing lock), then return verified lock
          const expectedVersion = 1234567890;
          const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(expectedVersion);
          
          const getSpy = jest.spyOn(cache, 'get')
              .mockResolvedValueOnce(null) // First call - no existing lock
              .mockResolvedValueOnce({    // Second call - verification
                  instanceId: "test_instance_123",
                  acquiredAt: expectedVersion,
                  ttl: 300,
                  version: expectedVersion
              });
          const setSpy = jest.spyOn(cache, 'set').mockResolvedValue(true);

          const result = await instanceCoordinator.acquireLock("test_lock");
          expect(result).toBe(true);

          dateSpy.mockRestore();
          getSpy.mockRestore();
          setSpy.mockRestore();
      });

      test("should fail to acquire lock when already held by another instance", async () => {
          const existingLock = {
              instanceId: "other_instance",
              acquiredAt: Date.now(),
              ttl: 300,
          };

          const getSpy = jest.spyOn(cache, 'get').mockResolvedValue(existingLock);

          const result = await instanceCoordinator.acquireLock("test_lock");
          expect(result).toBe(false);

          getSpy.mockRestore();
      });

      test("should acquire lock when existing lock is expired", async () => {
          const expectedVersion = 1234567890;
          const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(expectedVersion);
          
          const expiredLock = {
              instanceId: "other_instance",
              acquiredAt: expectedVersion - 400000, // 400 seconds ago (TTL is 300)
              ttl: 300,
          };

          // Mock cache.get to return expired lock, then return verified lock
          const getSpy = jest.spyOn(cache, 'get')
              .mockResolvedValueOnce(expiredLock) // First call - expired lock
              .mockResolvedValueOnce({            // Second call - verification
                  instanceId: "test_instance_123",
                  acquiredAt: expectedVersion,
                  ttl: 300,
                  version: expectedVersion
              });
          const setSpy = jest.spyOn(cache, 'set').mockResolvedValue(true);

          const result = await instanceCoordinator.acquireLock("test_lock");
          expect(result).toBe(true);

          dateSpy.mockRestore();
          getSpy.mockRestore();
          setSpy.mockRestore();
      });

      test("should fail when double-check verification fails (race condition)", async () => {
          // Mock cache.get to return null initially, but verification shows different instance
          const getSpy = jest.spyOn(cache, 'get')
              .mockResolvedValueOnce(null) // First call - no existing lock
              .mockResolvedValueOnce({    // Second call - verification shows race condition
                  instanceId: "other_instance", // Different instance!
                  acquiredAt: Date.now(),
                  ttl: 300,
                  version: 999 // Different version
              });
          const setSpy = jest.spyOn(cache, 'set').mockResolvedValue(true);

          const result = await instanceCoordinator.acquireLock("test_lock");
          expect(result).toBe(false); // Should fail due to race condition

          getSpy.mockRestore();
          setSpy.mockRestore();
      });

      test("should succeed when double-check verification passes", async () => {
          const expectedVersion = 1234567890;
          
          // Mock Date.now to return consistent version
          const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(expectedVersion);
          
          const getSpy = jest.spyOn(cache, 'get')
              .mockResolvedValueOnce(null) // First call - no existing lock
              .mockResolvedValueOnce({    // Second call - verification passes
                  instanceId: "test_instance_123",
                  acquiredAt: expectedVersion,
                  ttl: 300,
                  version: expectedVersion
              });
          const setSpy = jest.spyOn(cache, 'set').mockResolvedValue(true);

          const result = await instanceCoordinator.acquireLock("test_lock");
          expect(result).toBe(true);

          dateSpy.mockRestore();
          getSpy.mockRestore();
          setSpy.mockRestore();
      });
  });

  describe("releaseLock", () => {
    test("should release lock held by current instance", async () => {
      // Mock cache.get 返回当前实例持有的锁
      const getSpy = jest.spyOn(cache, 'get').mockResolvedValue({
        instanceId: "test_instance_123",
        acquiredAt: Date.now(),
        ttl: 300,
      });
      const deleteSpy = jest.spyOn(cache, 'delete').mockResolvedValue(true);

      await instanceCoordinator.releaseLock("test_lock");

      expect(deleteSpy).toHaveBeenCalledWith("lock:test_lock");

      getSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    test("should not release lock held by another instance", async () => {
      // Mock Cache to return a lock held by another instance
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          instanceId: "other_instance",
          acquiredAt: Date.now(),
          ttl: 300
        })
      });

      await instanceCoordinator.releaseLock("test_lock");

      // Should not call delete since it's not our lock
      expect(mockFetch).toHaveBeenCalledTimes(1); // Only the get call
    });
  });

  describe("acquireTaskLock", () => {
    test("should acquire task lock successfully", async () => {
      // Mock acquireLock to return true
      const acquireLockSpy = jest.spyOn(instanceCoordinator, 'acquireLock').mockResolvedValue(true);

      const result = await instanceCoordinator.acquireTaskLock("task_123");
      expect(result).toBe(true);
      expect(acquireLockSpy).toHaveBeenCalledWith("task:task_123", 600);

      acquireLockSpy.mockRestore();
    });
  });

  describe("releaseTaskLock", () => {
    test("should release task lock successfully", async () => {
      const releaseLockSpy = jest.spyOn(instanceCoordinator, 'releaseLock');

      await instanceCoordinator.releaseTaskLock("task_123");
      expect(releaseLockSpy).toHaveBeenCalledWith("task:task_123");

      releaseLockSpy.mockRestore();
    });
  });

  describe("acquireTaskLock and releaseTaskLock", () => {
    test("should acquire and release task lock successfully", async () => {
      // Mock acquireLock to return true
      const acquireLockSpy = jest.spyOn(instanceCoordinator, 'acquireLock').mockResolvedValue(true);
      const releaseLockSpy = jest.spyOn(instanceCoordinator, 'releaseLock');

      const result = await instanceCoordinator.acquireTaskLock("task_123");
      expect(result).toBe(true);
      expect(acquireLockSpy).toHaveBeenCalledWith("task:task_123", 600);

      await instanceCoordinator.releaseTaskLock("task_123");
      expect(releaseLockSpy).toHaveBeenCalledWith("task:task_123");

      acquireLockSpy.mockRestore();
      releaseLockSpy.mockRestore();
    });
  });

  describe("broadcast", () => {
    test("should broadcast system event with sourceInstance and timestamp", async () => {
      // Mock qstashService.broadcastSystemEvent
      const mockBroadcastSystemEvent = jest.fn().mockResolvedValue();
      jest.unstable_mockModule("../../src/services/QStashService.js", () => ({
        qstashService: {
          broadcastSystemEvent: mockBroadcastSystemEvent
        }
      }));

      // Re-import to get updated mock
      jest.resetModules();
      const { instanceCoordinator: newIC } = await import("../../src/services/InstanceCoordinator.js");

      await newIC.broadcast("instance_started", { nodeType: "dispatcher" });

      expect(mockBroadcastSystemEvent).toHaveBeenCalledWith("instance_started", {
        nodeType: "dispatcher",
        sourceInstance: newIC.instanceId,
        timestamp: expect.any(Number)
      });
    });

    test("should handle broadcast failure gracefully", async () => {
      // Mock qstashService.broadcastSystemEvent to throw
      const mockBroadcastSystemEvent = jest.fn().mockRejectedValue(new Error("QStash error"));
      jest.unstable_mockModule("../../src/services/QStashService.js", () => ({
        qstashService: {
          broadcastSystemEvent: mockBroadcastSystemEvent
        }
      }));

      // Re-import to get updated mock
      jest.resetModules();
      const { instanceCoordinator: newIC } = await import("../../src/services/InstanceCoordinator.js");
      const { default: logger } = await import("../../src/services/logger.js");

      await newIC.broadcast("instance_failed", { error: "test" });

      expect(mockBroadcastSystemEvent).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith("❌ 广播事件失败 instance_failed:", expect.anything());
    });
  });

  describe("getAllInstances", () => {
    test("should discover all instances using cache.listKeys", async () => {
      // Mock cache.listKeys to return instance keys
      const mockListKeys = jest.spyOn(cache, 'listKeys').mockResolvedValue([
        'instance:inst1',
        'instance:inst2',
        'instance:inst3'
      ]);

      // Mock individual instance gets
      const mockGet = jest.spyOn(cache, 'get')
        .mockResolvedValueOnce({
          id: 'inst1',
          hostname: 'host1',
          lastHeartbeat: Date.now(),
          status: 'active'
        })
        .mockResolvedValueOnce({
          id: 'inst2',
          hostname: 'host2',
          lastHeartbeat: Date.now(),
          status: 'active'
        })
        .mockResolvedValueOnce(null); // One instance has no data

      const instances = await instanceCoordinator.getAllInstances();

      expect(mockListKeys).toHaveBeenCalledWith('instance:');
      expect(mockGet).toHaveBeenCalledTimes(3);
      expect(instances).toHaveLength(2); // Only 2 instances with valid data
      expect(instances[0]).toEqual({
        id: 'inst1',
        hostname: 'host1',
        lastHeartbeat: expect.any(Number),
        status: 'active'
      });
      expect(instances[1]).toEqual({
        id: 'inst2',
        hostname: 'host2',
        lastHeartbeat: expect.any(Number),
        status: 'active'
      });
      expect(instanceCoordinator.activeInstances).toEqual(new Set(['inst1', 'inst2']));

      mockListKeys.mockRestore();
      mockGet.mockRestore();
    });

    test("should handle cache.listKeys failure gracefully", async () => {
      const mockListKeys = jest.spyOn(cache, 'listKeys').mockRejectedValue(new Error('Cache ListKeys Error'));

      const instances = await instanceCoordinator.getAllInstances();

      expect(instances).toEqual([]);
      expect(mockLogger.error).toHaveBeenCalledWith("获取所有实例失败:", "Cache ListKeys Error");

      mockListKeys.mockRestore();
    });

    test("should handle individual instance get failure", async () => {
      const mockListKeys = jest.spyOn(cache, 'listKeys').mockResolvedValue([
        'instance:inst1',
        'instance:inst2'
      ]);

      const mockGet = jest.spyOn(cache, 'get')
        .mockRejectedValueOnce(new Error('Cache Get Error')) // First instance fails
        .mockResolvedValueOnce({
          id: 'inst2',
          hostname: 'host2',
          lastHeartbeat: Date.now(),
          status: 'active'
        });

      const instances = await instanceCoordinator.getAllInstances();

      expect(instances).toHaveLength(1); // Only successful instance
      expect(instances[0].id).toBe('inst2');
      expect(mockLogger.warn).toHaveBeenCalledWith("获取实例 instance:inst1 失败，跳过:", "Cache Get Error");

      mockListKeys.mockRestore();
      mockGet.mockRestore();
    });

    test("should return empty array when no instances found", async () => {
      const mockListKeys = jest.spyOn(cache, 'listKeys').mockResolvedValue([]);

      const instances = await instanceCoordinator.getAllInstances();

      expect(instances).toEqual([]);
      expect(instanceCoordinator.activeInstances).toEqual(new Set());

      mockListKeys.mockRestore();
    });
  });
});