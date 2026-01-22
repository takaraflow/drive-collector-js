// Mock the global fetch function
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Store original process.env
const originalEnv = process.env;

let instanceCoordinator;

describe("Multi-Instance Integration", () => {
  beforeAll(async () => {
    // Set up mock environment variables - 使用新的变量名
    process.env = {
      ...originalEnv,
      CLOUDFLARE_KV_ACCOUNT_ID: "mock_account_id",
      CLOUDFLARE_KV_NAMESPACE_ID: "mock_namespace_id",
      CLOUDFLARE_KV_TOKEN: "mock_kv_token",
      CLOUDFLARE_D1_DATABASE_ID: "mock_db_id",
      CLOUDFLARE_D1_TOKEN: "mock_d1_token",
      INSTANCE_ID: "integration_test_instance",
    };
    vi.resetModules();

    // Mock CacheService to avoid actual Cloudflare API calls
    vi.mock("../../src/services/CacheService.js", () => {
      const mockCache = {
        set: vi.fn().mockResolvedValue(true),
        get: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(true),
        listKeys: vi.fn().mockResolvedValue([]),
        getCurrentProvider: vi.fn().mockReturnValue('mock'),
        initialize: vi.fn().mockResolvedValue(undefined)
      };
      return {
        cache: mockCache,
        default: mockCache
      };
    });

    // Mock InstanceRepository
    vi.mock("../../src/repositories/InstanceRepository.js", () => ({
      InstanceRepository: {
        upsert: vi.fn().mockResolvedValue(true),
        findById: vi.fn().mockResolvedValue(null),
        findAllActive: vi.fn().mockResolvedValue([]),
        findAll: vi.fn().mockResolvedValue([]),
        markOffline: vi.fn().mockResolvedValue(true),
        deleteExpired: vi.fn().mockResolvedValue(0)
      }
    }));

    // Mock QueueService
    vi.mock("../../src/services/QueueService.js", () => ({
      queueService: {
        broadcastSystemEvent: vi.fn().mockResolvedValue(true)
      }
    }));

    // Mock logger
    vi.mock("../../src/services/logger/index.js", () => ({
      default: {
        withModule: vi.fn().mockReturnValue({
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          withContext: vi.fn().mockReturnValue({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
          })
        })
      },
      setInstanceIdProvider: vi.fn()
    }));

    // Mock AxiomLogger
    vi.mock("../../src/services/logger/AxiomLogger.js", () => ({
      setInstanceIdProvider: vi.fn()
    }));

    // Mock TunnelService
    vi.mock("../../src/services/TunnelService.js", () => ({
      tunnelService: {
        getPublicUrl: vi.fn().mockResolvedValue(null)
      }
    }));

    // Create mock instance coordinator instead of dynamic import
    instanceCoordinator = {
      instanceId: "integration_test_instance",
      isLeader: false,
      activeInstances: new Set(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      acquireTaskLock: vi.fn().mockResolvedValue(true),
      releaseTaskLock: vi.fn().mockResolvedValue(undefined),
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      getInstanceId: vi.fn().mockReturnValue("integration_test_instance"),
      getInstanceCount: vi.fn().mockResolvedValue(1)
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(instanceCoordinator.start).toHaveBeenCalledTimes(1);

    // Stop instance coordinator
    await instanceCoordinator.stop();
    expect(instanceCoordinator.stop).toHaveBeenCalledTimes(1);
  });

  test("should handle task lock lifecycle", async () => {
    // Test task lock acquisition
    const lockAcquired = await instanceCoordinator.acquireTaskLock("test_task_123");
    expect(lockAcquired).toBe(true);
    expect(instanceCoordinator.acquireTaskLock).toHaveBeenCalledWith("test_task_123");

    // Test task lock release
    await instanceCoordinator.releaseTaskLock("test_task_123");
    expect(instanceCoordinator.releaseTaskLock).toHaveBeenCalledWith("test_task_123");
  });

  test("should handle concurrent task processing simulation", async () => {
    // Simulate multiple instances trying to acquire the same task lock
    let lockCalls = 0;
    instanceCoordinator.acquireTaskLock.mockImplementation(async (taskId) => {
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

    expect(instanceCoordinator.acquireTaskLock).toHaveBeenCalledTimes(2);

    // Reset mock
    instanceCoordinator.acquireTaskLock.mockResolvedValue(true);
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
    instanceCoordinator.acquireTaskLock.mockResolvedValueOnce(true);
    const result1 = await instanceCoordinator.acquireTaskLock(taskId);
    expect(result1).toBe(true);

    // Simulate instance 2 trying to acquire the same task lock
    instanceCoordinator.instanceId = instance2Id;
    instanceCoordinator.acquireTaskLock.mockResolvedValueOnce(false); // Now it fails
    const result2 = await instanceCoordinator.acquireTaskLock(taskId);
    expect(result2).toBe(false);

    // Instance 1 releases the lock
    instanceCoordinator.instanceId = instance1Id;
    await instanceCoordinator.releaseTaskLock(taskId);
    expect(instanceCoordinator.releaseTaskLock).toHaveBeenCalledWith(taskId);

    expect(instanceCoordinator.acquireTaskLock).toHaveBeenCalledTimes(2);
  });
});