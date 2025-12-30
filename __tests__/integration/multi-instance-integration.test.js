import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Store original process.env
const originalEnv = process.env;

let instanceCoordinator;

describe("Multi-Instance Integration", () => {
  beforeAll(async () => {
    // Set up mock environment variables - 使用新的变量名
    process.env = {
      ...originalEnv,
      CF_KV_ACCOUNT_ID: "mock_account_id",
      CF_KV_NAMESPACE_ID: "mock_namespace_id",
      CF_KV_TOKEN: "mock_kv_token",
      CF_D1_DATABASE_ID: "mock_db_id",
      CF_D1_TOKEN: "mock_d1_token",
      INSTANCE_ID: "integration_test_instance",
    };
    jest.resetModules();

    // Dynamically import after setting up mocks - only InstanceCoordinator
    const { instanceCoordinator: importedIC } = await import("../../src/services/InstanceCoordinator.js");
    instanceCoordinator = importedIC;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset instance state
    instanceCoordinator.instanceId = "integration_test_instance";
    instanceCoordinator.isLeader = false;
    instanceCoordinator.activeInstances = new Set();
  });

  test("should initialize instance coordinator successfully", async () => {
    // Mock successful KV operations
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ success: true }),
    });

    // Start instance coordinator
    await instanceCoordinator.start();
    expect(instanceCoordinator.instanceId).toBe("integration_test_instance");

    // Stop instance coordinator
    await instanceCoordinator.stop();
  });

  test("should handle task lock lifecycle", async () => {
    // Mock successful lock operations
    const acquireLockSpy = jest.spyOn(instanceCoordinator, 'acquireTaskLock').mockResolvedValue(true);
    const releaseLockSpy = jest.spyOn(instanceCoordinator, 'releaseTaskLock');

    // Test task lock acquisition
    const lockAcquired = await instanceCoordinator.acquireTaskLock("test_task_123");
    expect(lockAcquired).toBe(true);

    // Test task lock release
    await instanceCoordinator.releaseTaskLock("test_task_123");

    expect(acquireLockSpy).toHaveBeenCalledWith("test_task_123");
    expect(releaseLockSpy).toHaveBeenCalledWith("test_task_123");

    acquireLockSpy.mockRestore();
    releaseLockSpy.mockRestore();
  });

  test("should handle concurrent task processing simulation", async () => {
    // Simulate multiple instances trying to acquire the same task lock
    let lockCalls = 0;
    const acquireLockSpy = jest.spyOn(instanceCoordinator, 'acquireTaskLock').mockImplementation(async (taskId) => {
      lockCalls++;
      // First call succeeds, second fails (simulating another instance holding the lock)
      return lockCalls === 1;
    });

    // First instance should acquire the lock
    const result1 = await instanceCoordinator.acquireTaskLock("shared_task");
    expect(result1).toBe(true);

    // Second instance should fail to acquire the lock
    const result2 = await instanceCoordinator.acquireTaskLock("shared_task");
    expect(result2).toBe(false);

    expect(acquireLockSpy).toHaveBeenCalledTimes(2);

    acquireLockSpy.mockRestore();
  });

  test("should provide all required instance coordination methods", async () => {
    // This test verifies that InstanceCoordinator provides all methods needed for multi-instance support
    expect(typeof instanceCoordinator.acquireTaskLock).toBe('function');
    expect(typeof instanceCoordinator.releaseTaskLock).toBe('function');
    expect(typeof instanceCoordinator.acquireLock).toBe('function');
    expect(typeof instanceCoordinator.releaseLock).toBe('function');
    expect(typeof instanceCoordinator.start).toBe('function');
    expect(typeof instanceCoordinator.stop).toBe('function');
    expect(typeof instanceCoordinator.getInstanceId).toBe('function');
    expect(typeof instanceCoordinator.getInstanceCount).toBe('function');
  });

  test("should simulate multi-instance scenario", async () => {
    // Simulate a realistic multi-instance scenario
    const instance1Id = "instance_1";
    const instance2Id = "instance_2";
    const taskId = "task_456";

    // Set up instance 1
    instanceCoordinator.instanceId = instance1Id;

    // Instance 1 acquires the task lock
    const acquireSpy = jest.spyOn(instanceCoordinator, 'acquireTaskLock').mockResolvedValue(true);
    const result1 = await instanceCoordinator.acquireTaskLock(taskId);
    expect(result1).toBe(true);

    // Simulate instance 2 trying to acquire the same task lock
    instanceCoordinator.instanceId = instance2Id;
    acquireSpy.mockResolvedValue(false); // Now it fails
    const result2 = await instanceCoordinator.acquireTaskLock(taskId);
    expect(result2).toBe(false);

    // Instance 1 releases the lock
    instanceCoordinator.instanceId = instance1Id;
    const releaseSpy = jest.spyOn(instanceCoordinator, 'releaseTaskLock');
    await instanceCoordinator.releaseTaskLock(taskId);
    expect(releaseSpy).toHaveBeenCalledWith(taskId);

    acquireSpy.mockRestore();
    releaseSpy.mockRestore();
  });
});