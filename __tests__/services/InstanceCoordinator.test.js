import { jest, describe, test, expect, beforeEach, beforeAll, afterAll, afterEach } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Store original process.env
const originalEnv = process.env;

let instanceCoordinator;
let kv;

// Mock InstanceRepository
jest.unstable_mockModule("../../src/repositories/InstanceRepository.js", () => ({
  InstanceRepository: {
    createTableIfNotExists: jest.fn().mockResolvedValue(undefined),
    findAll: jest.fn().mockResolvedValue([]),
    upsert: jest.fn().mockResolvedValue(true),
  },
}));

describe("InstanceCoordinator", () => {
  beforeAll(async () => {
    // Set up mock environment variables
    process.env = {
      ...originalEnv,
      CF_ACCOUNT_ID: "mock_account_id",
      CF_KV_NAMESPACE_ID: "mock_namespace_id",
      CF_KV_TOKEN: "mock_kv_token",
      INSTANCE_ID: "test_instance_123",
    };
    jest.resetModules();

    // Dynamically import after setting up mocks
    const { instanceCoordinator: importedIC } = await import("../../src/services/InstanceCoordinator.js");
    instanceCoordinator = importedIC;

    // Also import kv for mocking
    const { kv: importedKV } = await import("../../src/services/kv.js");
    kv = importedKV;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset instance state
    instanceCoordinator.instanceId = "test_instance_123";
    instanceCoordinator.isLeader = false;
    instanceCoordinator.activeInstances = new Set();
  });

  afterEach(() => {
    // Clear any timers
    jest.clearAllTimers();
  });

  test("should initialize with correct instance ID", () => {
    expect(instanceCoordinator.instanceId).toBe("test_instance_123");
    expect(instanceCoordinator.heartbeatInterval).toBe(30000);
    expect(instanceCoordinator.instanceTimeout).toBe(120000);
  });

  describe("registerInstance", () => {
    test("should register instance successfully", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true }),
      });

      await instanceCoordinator.registerInstance();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("storage/kv/namespaces/mock_namespace_id/values/instance:test_instance_123"),
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"id":"test_instance_123"'),
        })
      );
    });

    test("should handle registration failure gracefully", async () => {
      // Mock KV failure
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({ success: false, errors: [{ message: "Registration failed" }] }),
      });

      // Should not throw, but log warning and use DB fallback
      await expect(instanceCoordinator.registerInstance()).resolves.not.toThrow();

      // Verify DB fallback was called
      const { InstanceRepository } = await import("../../src/repositories/InstanceRepository.js");
      expect(InstanceRepository.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "test_instance_123",
          status: "active"
        })
      );
    });
  });

  describe("unregisterInstance", () => {
    test("should unregister instance successfully", async () => {
      mockFetch.mockResolvedValueOnce({
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
      // Mock kv.get to return null (no existing lock)
      const getSpy = jest.spyOn(kv, 'get').mockResolvedValue(null);
      const setSpy = jest.spyOn(kv, 'set').mockResolvedValue(true);

      const result = await instanceCoordinator.acquireLock("test_lock");
      expect(result).toBe(true);

      getSpy.mockRestore();
      setSpy.mockRestore();
    });

    test("should fail to acquire lock when already held by another instance", async () => {
      const existingLock = {
        instanceId: "other_instance",
        acquiredAt: Date.now(),
        ttl: 300,
      };

      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve(existingLock),
      });

      const result = await instanceCoordinator.acquireLock("test_lock");
      expect(result).toBe(false);
    });

    test("should acquire lock when existing lock is expired", async () => {
      const expiredLock = {
        instanceId: "other_instance",
        acquiredAt: Date.now() - 400000, // 400 seconds ago (TTL is 300)
        ttl: 300,
      };

      // Mock kv.get to return expired lock
      const getSpy = jest.spyOn(kv, 'get').mockResolvedValue(expiredLock);
      const setSpy = jest.spyOn(kv, 'set').mockResolvedValue(true);

      const result = await instanceCoordinator.acquireLock("test_lock");
      expect(result).toBe(true);

      getSpy.mockRestore();
      setSpy.mockRestore();
    });
  });

  describe("releaseLock", () => {
    test("should release lock held by current instance", async () => {
      // Mock kv.get to return lock held by current instance
      const getSpy = jest.spyOn(kv, 'get').mockResolvedValue({
        instanceId: "test_instance_123",
        acquiredAt: Date.now(),
        ttl: 300,
      });
      const deleteSpy = jest.spyOn(kv, 'delete').mockResolvedValue(true);

      await instanceCoordinator.releaseLock("test_lock");

      expect(deleteSpy).toHaveBeenCalledWith("lock:test_lock");

      getSpy.mockRestore();
      deleteSpy.mockRestore();
    });

    test("should not release lock held by another instance", async () => {
      mockFetch.mockResolvedValueOnce({
        json: () => Promise.resolve({
          instanceId: "other_instance",
          acquiredAt: Date.now(),
          ttl: 300,
        }),
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
});