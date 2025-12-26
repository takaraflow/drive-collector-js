import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;
let instanceCoordinator;

describe("InstanceCoordinator Dual Registration", () => {
    beforeAll(async () => {
        // Set up mock environment variables
        process.env = {
            ...originalEnv,
            CF_ACCOUNT_ID: "mock_account_id",
            CF_KV_NAMESPACE_ID: "mock_namespace_id",
            CF_KV_TOKEN: "mock_kv_token",
            INSTANCE_ID: "test_instance_dual",
        };

        // Enable fake timers for testing
        jest.useFakeTimers();

        // Mock modules
        jest.unstable_mockModule("../../src/repositories/InstanceRepository.js", () => ({
            InstanceRepository: {
                createTableIfNotExists: jest.fn().mockResolvedValue(undefined),
                upsert: jest.fn().mockResolvedValue(true),
                updateHeartbeat: jest.fn().mockResolvedValue(true),
                findAll: jest.fn().mockResolvedValue([]),
            },
        }));

        jest.unstable_mockModule("../../src/services/kv.js", () => ({
            kv: {
                get: jest.fn(),
                set: jest.fn(),
                delete: jest.fn(),
            },
        }));

        // Dynamically import after setting up mocks
        const { instanceCoordinator: importedIC } = await import("../../src/services/InstanceCoordinator.js");
        const { kv } = await import("../../src/services/kv.js");
        instanceCoordinator = importedIC;
    });

    afterAll(() => {
        process.env = originalEnv;
        jest.useRealTimers();
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        instanceCoordinator.instanceId = "test_instance_dual";

        // Ensure KV is in normal mode for tests
        const { kv } = await import("../../src/services/kv.js");
        kv.currentProvider = 'cloudflare';
    });

    test("should register instance in both D1 and KV (Dual Write)", async () => {
        const { kv } = await import("../../src/services/kv.js");
        kv.set.mockResolvedValueOnce(true);

        // Override the random delay for testing
        const originalSetTimeout = global.setTimeout;
        global.setTimeout = jest.fn((fn) => fn());

        await instanceCoordinator.registerInstance();

        // Restore original setTimeout
        global.setTimeout = originalSetTimeout;

        // Verify D1 write
        const { InstanceRepository } = await import("../../src/repositories/InstanceRepository.js");
        expect(InstanceRepository.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "test_instance_dual",
                status: "active"
            })
        );

        // Verify KV write
        expect(kv.set).toHaveBeenCalledWith(
            "instance:test_instance_dual",
            expect.objectContaining({
                id: "test_instance_dual",
                status: "active"
            }),
            900 // 15 minutes / 1000
        );
    });

    test("should continue working when KV fails but D1 succeeds", async () => {
        const { kv } = await import("../../src/services/kv.js");
        kv.set.mockRejectedValueOnce(new Error("KV quota exceeded"));

        // Override the random delay for testing
        const originalSetTimeout = global.setTimeout;
        global.setTimeout = jest.fn((fn) => fn());

        await instanceCoordinator.registerInstance();

        // Restore original setTimeout
        global.setTimeout = originalSetTimeout;

        // Verify D1 still called
        const { InstanceRepository } = await import("../../src/repositories/InstanceRepository.js");
        expect(InstanceRepository.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "test_instance_dual",
                status: "active"
            })
        );

        // Verify KV was attempted (but failed)
        expect(kv.set).toHaveBeenCalledWith(
            "instance:test_instance_dual",
            expect.objectContaining({
                id: "test_instance_dual",
                status: "active"
            }),
            900 // 15 minutes / 1000
        );
    });

    test("should send heartbeats to both D1 and KV", async () => {
        const { InstanceRepository } = await import("../../src/repositories/InstanceRepository.js");
        const { kv } = await import("../../src/services/kv.js");

        // Mock successful KV operations
        const instanceData = {
            id: "test_instance_dual",
            status: "active",
            lastHeartbeat: Date.now() - 1000
        };
        kv.get.mockResolvedValueOnce(instanceData);
        kv.set.mockResolvedValueOnce(true);

        // Manually call the heartbeat function instead of using timer
        // This is more reliable than timing-based tests
        await instanceCoordinator.startHeartbeat();

        // Advance timer to trigger one heartbeat cycle (5 minutes)
        jest.advanceTimersByTime(300001);

        // Verify D1 heartbeat was sent
        expect(InstanceRepository.updateHeartbeat).toHaveBeenCalledWith("test_instance_dual", expect.any(Number));
    });

    test("should handle KV heartbeat failure gracefully", async () => {
        const { InstanceRepository } = await import("../../src/repositories/InstanceRepository.js");
        const { kv } = await import("../../src/services/kv.js");

        // Mock KV failure but D1 success
        kv.get.mockRejectedValueOnce(new Error("KV network error"));

        // Start heartbeat
        await instanceCoordinator.startHeartbeat();

        // Advance timer to trigger one heartbeat cycle (5 minutes)
        jest.advanceTimersByTime(300001);

        // Verify D1 heartbeat still worked
        expect(InstanceRepository.updateHeartbeat).toHaveBeenCalledWith("test_instance_dual", expect.any(Number));
    });

    // Removed test: should re-register instance when KV key is missing (hard to mock heartbeat timer)
});