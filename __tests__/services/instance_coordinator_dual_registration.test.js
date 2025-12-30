// Updated test file - V3 - Forced update
import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;
let instanceCoordinator;

const mockCache = {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    isFailoverMode: true,
};

describe("InstanceCoordinator Heartbeat (KV Only)", () => {
    beforeAll(async () => {
        // Set up mock environment variables
        process.env = {
            ...originalEnv,
            CF_ACCOUNT_ID: "mock_account_id",
            CF_KV_NAMESPACE_ID: "mock_namespace_id",
            CF_KV_TOKEN: "mock_kv_token",
            INSTANCE_ID: "test_instance_heartbeat",
            HOSTNAME: "unknown", // Mock hostname for consistent test results
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

        jest.unstable_mockModule("../../src/services/CacheService.js", () => ({
            cache: mockCache,
        }));

        // Dynamically import after setting up mocks
        const { instanceCoordinator: importedIC } = await import("../../src/services/InstanceCoordinator.js");
        instanceCoordinator = importedIC;
    });

    afterAll(() => {
        process.env = originalEnv;
        jest.useRealTimers();
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        instanceCoordinator.instanceId = "test_instance_heartbeat";
        // Stop any existing timer
        if (instanceCoordinator.heartbeatTimer) {
            clearInterval(instanceCoordinator.heartbeatTimer);
            instanceCoordinator.heartbeatTimer = null;
        }
    });

    test("should send heartbeat to KV", async () => {
        // Mock successful KV operations
        const instanceData = {
            id: "test_instance_heartbeat",
            status: "active",
            lastHeartbeat: Date.now() - 1000
        };
        mockCache.get.mockResolvedValue(instanceData);
        mockCache.set.mockResolvedValue(true);

        // Start heartbeat manually
        instanceCoordinator.startHeartbeat();

        // Advance timer (heartbeat interval is 5 minutes)
        await jest.advanceTimersByTimeAsync(300000);

        // Verify KV heartbeat was sent
        expect(mockCache.get).toHaveBeenCalledWith("instance:test_instance_heartbeat");
        expect(mockCache.set).toHaveBeenCalledWith(
            "instance:test_instance_heartbeat",
            expect.objectContaining({
                id: "test_instance_heartbeat",
                lastHeartbeat: expect.any(Number)
            }),
            900
        );
    });

    test("should re-register if instance data missing in KV", async () => {
        // Mock instance not found in KV
        mockCache.get.mockResolvedValue(null);
        mockCache.set.mockResolvedValue(true);

        // Start heartbeat
        instanceCoordinator.startHeartbeat();

        // Advance timer (heartbeat interval is 5 minutes)
        await jest.advanceTimersByTimeAsync(300000);

        // Verify re-registration
        expect(mockCache.get).toHaveBeenCalledWith("instance:test_instance_heartbeat");
        // Should call registerInstance logic (which does a set)
        expect(mockCache.set).toHaveBeenCalledWith(
            "instance:test_instance_heartbeat",
            expect.objectContaining({
                id: "test_instance_heartbeat",
                status: "active",
                hostname: "unknown",
                region: "unknown",
                startedAt: expect.any(Number),
                lastHeartbeat: expect.any(Number)
            }),
            900
        );
    });

    test("should handle KV errors gracefully", async () => {
        const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        // Mock KV error
        mockCache.get.mockRejectedValue(new Error("KV Network Error"));

        // Start heartbeat
        instanceCoordinator.startHeartbeat();

        // Advance timer (heartbeat interval is 5 minutes)
        await jest.advanceTimersByTimeAsync(300000);

        // Should log error but not crash
        // Use English matching to avoid encoding issues with Chinese characters
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("KV Network Error"), expect.anything());
        consoleSpy.mockRestore();
    });
});
