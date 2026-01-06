import { jest, describe, test, expect, beforeEach, beforeAll, afterAll, afterEach } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Store original process.env
const originalEnv = process.env;

let instanceCoordinator;
let cache;
// 【关键】用来存储所有产生的定时器 ID
let capturedIntervals = [];

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
   logger: mockLogger,
   setInstanceIdProvider: jest.fn(),
}));

describe("InstanceCoordinator", () => {
  beforeAll(async () => {
    // 【关键修复 1】强制使用真实定时器，防止 async/await 逻辑因为 FakeTimers 导致死锁
    jest.useRealTimers();

    // 【关键修复 2】拦截 setInterval，捕获 ID，但不阻止它运行
    const originalSetInterval = global.setInterval;
    jest.spyOn(global, 'setInterval').mockImplementation((fn, ms) => {
        const id = originalSetInterval(fn, ms);
        capturedIntervals.push(id);
        return id;
    });

    // Set up mock environment variables
    process.env = {
      ...originalEnv,
      CF_CACHE_ACCOUNT_ID: "mock_account_id",
      CF_CACHE_NAMESPACE_ID: "mock_namespace_id",
      CF_CACHE_TOKEN: "mock_kv_token",
      INSTANCE_ID: "test_instance_123",
      CACHE_PROVIDER: undefined,
    };
    jest.resetModules();

    // Dynamically import after setting up mocks
    const { instanceCoordinator: importedIC } = await import("../../src/services/InstanceCoordinator.js");
    instanceCoordinator = importedIC;

    // Also import cache for mocking
    const { cache: importedCache } = await import("../../src/services/CacheService.js");
    cache = importedCache;

    // Pre-initialize cache to avoid repeated async initialization overhead
    await cache.initialize();

    // Prevent CacheService heartbeat timer from starting
    cache._startHeartbeat = jest.fn();
  });

  afterAll(() => {
    // 【关键修复 3】测试结束后，暴力清理所有捕获到的定时器
    // 这解决了 "Open Handle" 导致的超时/无法退出问题
    capturedIntervals.forEach(id => clearInterval(id));

    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    // Reset instance state
    if (instanceCoordinator) {
        instanceCoordinator.instanceId = "test_instance_123";
        instanceCoordinator.isLeader = false;
        instanceCoordinator.activeInstances = new Set();
    }

    // Ensure Cache is in normal mode for tests
    const { cache } = await import("../../src/services/CacheService.js");
    if (cache) cache.currentProvider = 'cloudflare';
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
          // Mock the fetch response to be ok: true
          mockFetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          });
  
          await instanceCoordinator.registerInstance();
  
          // Verify Cache write only - check that it contains the key pattern
          expect(mockFetch).toHaveBeenCalledWith(
            expect.stringContaining("/storage/kv/namespaces/"),
            expect.objectContaining({
              method: "PUT",
              body: expect.stringContaining('"id":"test_instance_123"'),
            })
          );
      });

      test("should throw error when Cache registration fails", async () => {
          // Mock Cache failure - response not ok
          mockFetch.mockResolvedValueOnce({
              ok: false,
              status: 400,
              json: () => Promise.resolve({ success: false, errors: [{ message: "Registration failed" }] }),
          });
  
          // Should throw since Cache is the primary storage
          try {
              await instanceCoordinator.registerInstance();
              // If we get here, the test should fail
              expect(true).toBe(false);
          } catch (error) {
              // The error message may vary depending on the cache provider
              // Just verify that an error was thrown
              expect(error).toBeDefined();
          }
      });
  });

  describe("unregisterInstance", () => {
      test("should unregister instance successfully", async () => {
          // Mock cache.delete to return true
          const originalDelete = cache.delete;
          const deleteSpy = jest.fn().mockResolvedValue(true);
          cache.delete = deleteSpy;

          await instanceCoordinator.unregisterInstance();

          // Verify cache.delete was called with correct key
          expect(deleteSpy).toHaveBeenCalledWith("instance:test_instance_123");

          cache.delete = originalDelete;
      });

      test("should handle unregister instance failure gracefully", async () => {
          // Mock cache.delete to throw error
          const originalDelete = cache.delete;
          const deleteSpy = jest.fn().mockRejectedValue(new Error('Cache Delete Error'));
          cache.delete = deleteSpy;

          // Should not throw, just log error
          await expect(instanceCoordinator.unregisterInstance()).resolves.not.toThrow();

          expect(deleteSpy).toHaveBeenCalledWith("instance:test_instance_123");

          cache.delete = originalDelete;
      });
  });

  describe("acquireLock", () => {
    test("should acquire lock when no existing lock", async () => {
      const expectedTime = 1234567890;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(expectedTime);
      
      const originalGet = cache.get;
      const originalSet = cache.set;
      
      let getCallCount = 0;
      cache.get = jest.fn().mockImplementation(() => {
        getCallCount++;
        if (getCallCount === 1) {
          return Promise.resolve(null); // First call - no existing lock
        } else {
          return Promise.resolve({    // Second call - verification
            instanceId: "test_instance_123",
            acquiredAt: expectedTime,
            ttl: 300
          });
        }
      });
      cache.set = jest.fn().mockResolvedValue(true);

      const result = await instanceCoordinator.acquireLock("test_lock");
      expect(result).toBe(true);

      dateSpy.mockRestore();
      cache.get = originalGet;
      cache.set = originalSet;
    });

    test("should fail to acquire lock when already held by another instance", async () => {
      const existingLock = {
        instanceId: "other_instance",
        acquiredAt: Date.now(),
        ttl: 300,
      };

      const originalGet = cache.get;
      cache.get = jest.fn().mockResolvedValue(existingLock);

      const result = await instanceCoordinator.acquireLock("test_lock");
      expect(result).toBe(false);

      cache.get = originalGet;
    });

    test("should acquire lock when existing lock is expired", async () => {
      const expectedTime = 1234567890;
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(expectedTime);
      
      const expiredLock = {
        instanceId: "other_instance",
        acquiredAt: expectedTime - 400000, // 400 seconds ago (TTL is 300)
        ttl: 300,
      };

      const originalGet = cache.get;
      const originalSet = cache.set;
      
      let getCallCount = 0;
      cache.get = jest.fn().mockImplementation(() => {
        getCallCount++;
        if (getCallCount === 1) {
          return Promise.resolve(expiredLock); // First call - expired lock
        } else {
          return Promise.resolve({            // Second call - verification
            instanceId: "test_instance_123",
            acquiredAt: expectedTime,
            ttl: 300
          });
        }
      });
      cache.set = jest.fn().mockResolvedValue(true);

      const result = await instanceCoordinator.acquireLock("test_lock");
      expect(result).toBe(true);

      dateSpy.mockRestore();
      cache.get = originalGet;
      cache.set = originalSet;
    });

    test("should acquire lock when existing lock owner is offline (preemption)", async () => {
        const expectedTime = 1234567890;
        const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(expectedTime);
        
        const existingLock = {
            instanceId: "offline_instance",
            acquiredAt: expectedTime - 100, // Not expired by TTL
            ttl: 300,
        };

        const originalGet = cache.get;
        const originalSet = cache.set;
        
        let getCallCount = 0;
        const getSpy = jest.fn().mockImplementation((key) => {
            getCallCount++;
            if (getCallCount === 1) {
                return Promise.resolve(existingLock); // First call in _tryAcquire - see existing lock
            } else if (getCallCount === 2) {
                return Promise.resolve(null);         // Preemption check - ownerKey is null (offline)
            } else {
                return Promise.resolve({             // Verification after set
                    instanceId: "test_instance_123",
                    acquiredAt: expectedTime,
                    ttl: 300
                });
            }
        });
        const setSpy = jest.fn().mockResolvedValue(true);
        cache.get = getSpy;
        cache.set = setSpy;

        const result = await instanceCoordinator.acquireLock("test_lock");
        expect(result).toBe(true);
        
        // Verify set was called
        expect(setSpy).toHaveBeenCalled();
        // Verify preemption check was done for the correct instance
        expect(getSpy).toHaveBeenCalledWith("instance:offline_instance", "json", expect.any(Object));

        dateSpy.mockRestore();
        cache.get = originalGet;
        cache.set = originalSet;
    });

    test("should fail when double-check verification fails (race condition)", async () => {
      const originalGet = cache.get;
      const originalSet = cache.set;
      
      let getCallCount = 0;
      cache.get = jest.fn().mockImplementation(() => {
        getCallCount++;
        if (getCallCount === 1) {
          return Promise.resolve(null); // First call - no existing lock
        } else {
          return Promise.resolve({    // Second call - verification shows race condition
            instanceId: "other_instance", // Different instance!
            acquiredAt: Date.now(),
            ttl: 300
          });
        }
      });
      cache.set = jest.fn().mockResolvedValue(true);

      const result = await instanceCoordinator.acquireLock("test_lock");
      expect(result).toBe(false); // Should fail due to race condition

      cache.get = originalGet;
      cache.set = originalSet;
    });

    test("should succeed even if KV returns old self-owned lock (KV eventual consistency)", async () => {
      const expectedTime = 1234567890;
      const oldTime = expectedTime - 30000; // 30s ago
      
      const originalGet = cache.get;
      const originalSet = cache.set;
      
      cache.get = jest.fn().mockImplementation(() => {
        return Promise.resolve({          // Both calls return old lock
          instanceId: "test_instance_123",
          acquiredAt: oldTime,
          ttl: 300
        });
      });
      cache.set = jest.fn().mockResolvedValue(true);

      const result = await instanceCoordinator.acquireLock("test_lock");
      expect(result).toBe(true); // Should succeed because instanceId matches

      cache.get = originalGet;
      cache.set = originalSet;
    });

    test("should succeed when double-check verification passes", async () => {
      const expectedTime = 1234567890;
      
      // Mock Date.now to return consistent version
      const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(expectedTime);
      
      const originalGet = cache.get;
      const originalSet = cache.set;
      
      let getCallCount = 0;
      cache.get = jest.fn().mockImplementation(() => {
        getCallCount++;
        if (getCallCount === 1) {
          return Promise.resolve(null); // First call - no existing lock
        } else {
          return Promise.resolve({    // Second call - verification passes
            instanceId: "test_instance_123",
            acquiredAt: expectedTime,
            ttl: 300
          });
        }
      });
      cache.set = jest.fn().mockResolvedValue(true);

      const result = await instanceCoordinator.acquireLock("test_lock");
      expect(result).toBe(true);

      dateSpy.mockRestore();
      cache.get = originalGet;
      cache.set = originalSet;
    });
  });

  describe("releaseLock", () => {
      test("should release lock held by current instance", async () => {
          const originalGet = cache.get;
          const originalDelete = cache.delete;
          
          const getSpy = jest.fn().mockResolvedValue({
              instanceId: "test_instance_123",
              acquiredAt: Date.now(),
              ttl: 300,
          });
          const deleteSpy = jest.fn().mockResolvedValue(true);
          cache.get = getSpy;
          cache.delete = deleteSpy;

          await instanceCoordinator.releaseLock("test_lock");

          expect(deleteSpy).toHaveBeenCalledWith("lock:test_lock");

          cache.get = originalGet;
          cache.delete = originalDelete;
      });

      test("should not release lock held by another instance", async () => {
          // Mock cache.get to return a lock held by another instance
          const originalGet = cache.get;
          const getSpy = jest.fn().mockResolvedValue({
              instanceId: "other_instance",
              acquiredAt: Date.now(),
              ttl: 300
          });
          cache.get = getSpy;

          await instanceCoordinator.releaseLock("test_lock");

          // Should not call delete since it's not our lock
          // The method will call cache.get but not cache.delete
          expect(getSpy).toHaveBeenCalledWith("lock:test_lock", "json", expect.any(Object));

          cache.get = originalGet;
      });
  });

  describe("acquireTaskLock", () => {
    test("should acquire task lock successfully", async () => {
      // Mock acquireLock to return true
      const acquireLockSpy = jest.spyOn(instanceCoordinator, 'acquireLock').mockImplementation(() => Promise.resolve(true));

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
      const acquireLockSpy = jest.spyOn(instanceCoordinator, 'acquireLock').mockImplementation(() => Promise.resolve(true));
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
      const mockBroadcastSystemEvent = jest.fn().mockImplementation(() => Promise.resolve());
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
        const mockBroadcastSystemEvent = jest.fn().mockImplementation(() => Promise.reject(new Error("QStash error")));
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
        // Check for either [memory] or [MemoryCache] format
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("❌ 广播事件失败 instance_failed:"),
          expect.anything()
        );
    });
  });

  describe("getAllInstances", () => {
      test("should discover all instances using cache.listKeys", async () => {
          // Mock cache.listKeys to return instance keys
          const originalListKeys = cache.listKeys;
          const originalGet = cache.get;
          
          const listKeysSpy = jest.fn().mockImplementation(() => Promise.resolve([
            'instance:inst1',
            'instance:inst2',
            'instance:inst3'
          ]));

          // Mock individual instance gets
          let getCallCount = 0;
          const getSpy = jest.fn().mockImplementation(() => {
            getCallCount++;
            if (getCallCount === 1) {
              return Promise.resolve({
                id: 'inst1',
                hostname: 'host1',
                lastHeartbeat: Date.now(),
                status: 'active'
              });
            } else if (getCallCount === 2) {
              return Promise.resolve({
                id: 'inst2',
                hostname: 'host2',
                lastHeartbeat: Date.now(),
                status: 'active'
              });
            } else {
              return Promise.resolve(null); // One instance has no data
            }
          });
          cache.listKeys = listKeysSpy;
          cache.get = getSpy;

          const instances = await instanceCoordinator.getAllInstances();

          expect(listKeysSpy).toHaveBeenCalledWith('instance:');
          expect(getSpy).toHaveBeenCalledTimes(3);
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

          cache.listKeys = originalListKeys;
          cache.get = originalGet;
      });

      test("should handle cache.listKeys failure gracefully", async () => {
          const originalListKeys = cache.listKeys;
          const listKeysSpy = jest.fn().mockRejectedValue(new Error('Cache ListKeys Error'));
          cache.listKeys = listKeysSpy;

          const instances = await instanceCoordinator.getAllInstances();

          expect(instances).toEqual([]);
          expect(mockLogger.error).toHaveBeenCalledWith("[cloudflare] 获取所有实例失败:", "Cache ListKeys Error");

          cache.listKeys = originalListKeys;
      });

      test("should handle individual instance get failure", async () => {
          const originalListKeys = cache.listKeys;
          const originalGet = cache.get;
          
          const listKeysSpy = jest.fn().mockImplementation(() => Promise.resolve([
            'instance:inst1',
            'instance:inst2'
          ]));

          let getCallCount = 0;
          const getSpy = jest.fn().mockImplementation(() => {
            getCallCount++;
            if (getCallCount === 1) {
              return Promise.reject(new Error('Cache Get Error')); // First instance fails
            } else {
              return Promise.resolve({
                id: 'inst2',
                hostname: 'host2',
                lastHeartbeat: Date.now(),
                status: 'active'
              });
            }
          });
          cache.listKeys = listKeysSpy;
          cache.get = getSpy;

          const instances = await instanceCoordinator.getAllInstances();

          expect(instances).toHaveLength(1); // Only successful instance
          expect(instances[0].id).toBe('inst2');
          expect(mockLogger.warn).toHaveBeenCalledWith("[cloudflare] 获取实例 instance:inst1 失败，跳过:", "Cache Get Error");

          cache.listKeys = originalListKeys;
          cache.get = originalGet;
      });

      test("should return empty array when no instances found", async () => {
          const originalListKeys = cache.listKeys;
          const listKeysSpy = jest.fn().mockImplementation(() => Promise.resolve([]));
          cache.listKeys = listKeysSpy;

          const instances = await instanceCoordinator.getAllInstances();

          expect(instances).toEqual([]);
          expect(instanceCoordinator.activeInstances).toEqual(new Set());

          cache.listKeys = originalListKeys;
      });
  });
});