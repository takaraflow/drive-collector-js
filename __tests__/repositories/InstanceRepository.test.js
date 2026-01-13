import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import { cache } from "../../src/services/CacheService.js";
import { logger } from "../../src/services/logger/index.js";

// Mock cache 和 logger
vi.mock("../../src/services/CacheService.js", () => ({
    cache: {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        listKeys: vi.fn(),
    },
}));

vi.mock("../../src/services/logger/index.js", () => ({
    default: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    },
    logger: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    }
}));

describe("InstanceRepository (Cache Based)", () => {
    let InstanceRepository;

    beforeAll(async () => {
        vi.resetModules();
        const repoModule = await import("../../src/repositories/InstanceRepository.js");
        InstanceRepository = repoModule.InstanceRepository;
    });

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("upsert", () => {
        it("should set instance data in cache successfully", async () => {
            cache.set.mockResolvedValue(true);

            const instanceData = {
                id: "instance1",
                hostname: "host1",
                region: "us-east",
                startedAt: Date.now(),
                lastHeartbeat: Date.now(),
                status: "active",
                timeoutMs: 120000
            };

            const result = await InstanceRepository.upsert(instanceData);

            expect(result).toBe(true);
            expect(cache.set).toHaveBeenCalledWith(
                "instance:instance1",
                instanceData,
                120 // 120000 / 1000
            );
        });

        it("should return false on cache error", async () => {
            cache.set.mockRejectedValue(new Error("Cache Error"));

            const instanceData = { id: "instance1" };
            const result = await InstanceRepository.upsert(instanceData);

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                "InstanceRepository.upsert failed for instance1:",
                expect.any(Error)
            );
        });
    });

    describe("findAllActive", () => {
        it("should return only active instances within timeout", async () => {
            const now = Date.now();
            const mockInstances = [
                { id: "active1", lastHeartbeat: now - 1000 },
                { id: "stale1", lastHeartbeat: now - 200000 }
            ];
            
            cache.listKeys.mockResolvedValue(["instance:active1", "instance:stale1"]);
            cache.get.mockImplementation((key) => {
                if (key === "instance:active1") return Promise.resolve(mockInstances[0]);
                if (key === "instance:stale1") return Promise.resolve(mockInstances[1]);
                return Promise.resolve(null);
            });

            const result = await InstanceRepository.findAllActive(120000);

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe("active1");
        });
    });

    describe("findById", () => {
        it("should return instance from cache", async () => {
            const mockInstance = { id: "instance1", hostname: "host1" };
            cache.get.mockResolvedValue(mockInstance);

            const result = await InstanceRepository.findById("instance1");

            expect(result).toEqual(mockInstance);
            expect(cache.get).toHaveBeenCalledWith("instance:instance1", "json");
        });
    });

    describe("updateHeartbeat", () => {
        it("should update heartbeat successfully", async () => {
            const now = Date.now();
            const mockInstance = { id: "instance1", status: "active" };
            cache.get.mockResolvedValue(mockInstance);
            cache.set.mockResolvedValue(true);

            const result = await InstanceRepository.updateHeartbeat("instance1", now);

            expect(result).toBe(true);
            expect(cache.set).toHaveBeenCalledWith(
                "instance:instance1",
                expect.objectContaining({
                    id: "instance1",
                    lastHeartbeat: now
                }),
                expect.any(Number)
            );
        });
    });

    describe("markOffline", () => {
        it("should delete instance from cache", async () => {
            cache.delete.mockResolvedValue(true);

            const result = await InstanceRepository.markOffline("instance1");

            expect(result).toBe(true);
            expect(cache.delete).toHaveBeenCalledWith("instance:instance1");
        });
    });

    describe("getStats", () => {
        it("should calculate correct statistics", async () => {
            const now = Date.now();
            const mockInstances = [
                { id: "i1", lastHeartbeat: now - 1000 }, // active
                { id: "i2", lastHeartbeat: now - 500000 } // offline
            ];
            
            cache.listKeys.mockResolvedValue(["instance:i1", "instance:i2"]);
            cache.get.mockImplementation((key) => {
                if (key === "instance:i1") return Promise.resolve(mockInstances[0]);
                if (key === "instance:i2") return Promise.resolve(mockInstances[1]);
                return Promise.resolve(null);
            });

            const stats = await InstanceRepository.getStats(120000);

            expect(stats.activeCount).toBe(1);
            expect(stats.totalCount).toBe(2);
            expect(stats.offlineCount).toBe(1);
        });
    });
});
