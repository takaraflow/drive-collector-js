// Updated test file - V3 - Forced update
import { jest, describe, test, expect, beforeEach, beforeAll, afterAll } from "@jest/globals";
import logger from "../../src/services/logger.js";

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
    getCurrentProvider: jest.fn().mockReturnValue("Cloudflare KV"),
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
        // Mock setInterval to call immediately for testing
        global.setInterval = jest.fn((fn, delay) => {
            fn();
            return 123;
        });
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

        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, 0));

        // Since setInterval is mocked to call immediately, verify KV heartbeat was sent
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

        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, 0));

        // Since setInterval is mocked to call immediately, verify re-registration
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
        const loggerErrorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});

        // Mock KV error
        mockCache.get.mockRejectedValue(new Error("KV Network Error"));

        // Mock getCurrentProvider to return Cloudflare KV
        mockCache.getCurrentProvider = jest.fn().mockReturnValue("Cloudflare KV");

        // Start heartbeat
        instanceCoordinator.startHeartbeat();

        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, 0));

        // Since setInterval is mocked to call immediately, should log error with provider prefix but not crash
        expect(loggerErrorSpy).toHaveBeenCalledWith(expect.stringContaining("[Cloudflare KV] Cache心跳更新失败"));
        loggerErrorSpy.mockRestore();
    });
});
