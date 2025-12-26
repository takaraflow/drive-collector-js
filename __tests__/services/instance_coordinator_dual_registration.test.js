// Updated test file - V3 - Forced update
import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;
let instanceCoordinator;

describe("InstanceCoordinator Heartbeat (KV Only)", () => {
    beforeAll(async () => {
        // Set up mock environment variables
        process.env = {
            ...originalEnv,
            CF_ACCOUNT_ID: "mock_account_id",
            CF_KV_NAMESPACE_ID: "mock_namespace_id",
            CF_KV_TOKEN: "mock_kv_token",
            INSTANCE_ID: "test_instance_heartbeat",
        };

        // Enable fake timers for testing
        jest.useFakeTimers();

        // Mock modules - we don't need D1 anymore for coordinator
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
        instanceCoordinator = importedIC;
    });

    afterAll(() => {
        process.env = originalEnv;
        jest.useRealTimers();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        instanceCoordinator.instanceId = "test_instance_heartbeat";
        // Stop any existing timer
        if (instanceCoordinator.heartbeatTimer) {
            clearInterval(instanceCoordinator.heartbeatTimer);
            instanceCoordinator.heartbeatTimer = null;
        }
    });

    test("should send heartbeat to KV", async () => {
        const { kv } = await import("../../src/services/kv.js");

        // Mock successful KV operations
        const instanceData = {
            id: "test_instance_heartbeat",
            status: "active",
            lastHeartbeat: Date.now() - 1000
        };
        kv.get.mockResolvedValue(instanceData);
        kv.set.mockResolvedValue(true);

        // Start heartbeat manually
        instanceCoordinator.startHeartbeat();

        // Advance timer
        await jest.advanceTimersByTimeAsync(61000);

        // Verify KV heartbeat was sent
        expect(kv.get).toHaveBeenCalledWith("instance:test_instance_heartbeat");
        expect(kv.set).toHaveBeenCalledWith(
            "instance:test_instance_heartbeat",
            expect.objectContaining({
                id: "test_instance_heartbeat",
                lastHeartbeat: expect.any(Number)
            }),
            180
        );
    });

    test("should re-register if instance data missing in KV", async () => {
        const { kv } = await import("../../src/services/kv.js");

        // Mock instance not found in KV
        kv.get.mockResolvedValue(null);
        kv.set.mockResolvedValue(true);

        // Start heartbeat
        instanceCoordinator.startHeartbeat();

        // Advance timer
        await jest.advanceTimersByTimeAsync(61000);

        // Verify re-registration
        expect(kv.get).toHaveBeenCalledWith("instance:test_instance_heartbeat");
        // Should call registerInstance logic (which does a set)
        expect(kv.set).toHaveBeenCalledWith(
            "instance:test_instance_heartbeat",
            expect.objectContaining({
                id: "test_instance_heartbeat",
                status: "active"
            }),
            180
        );
    });

    test("should handle KV errors gracefully", async () => {
        const { kv } = await import("../../src/services/kv.js");
        const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        // Mock KV error
        kv.get.mockRejectedValue(new Error("KV Network Error"));

        // Start heartbeat
        instanceCoordinator.startHeartbeat();

        // Advance timer
        await jest.advanceTimersByTimeAsync(61000);

        // Should log error but not crash
        // Use English matching to avoid encoding issues with Chinese characters
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("KV Network Error"));
        consoleSpy.mockRestore();
    });
});