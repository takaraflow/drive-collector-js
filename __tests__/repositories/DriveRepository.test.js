// Updated test file - V3
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockCache = {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    getOrSet: jest.fn(),
    del: jest.fn(),
    listKeys: jest.fn(),
};

const mockLocalCache = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    getOrSet: jest.fn(),
};

const mockD1 = {
    fetchOne: jest.fn(),
    fetchAll: jest.fn(),
    run: jest.fn(),
};

jest.unstable_mockModule("../../src/services/CacheService.js", () => ({
    cache: mockCache,
}));

jest.unstable_mockModule("../../src/utils/LocalCache.js", () => ({
    localCache: mockLocalCache,
}));

jest.unstable_mockModule("../../src/services/d1.js", () => ({
    d1: mockD1,
}));

jest.unstable_mockModule("../../src/services/logger.js", () => ({
    default: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }
}));

const { DriveRepository } = await import("../../src/repositories/DriveRepository.js");
const { cache } = await import("../../src/services/CacheService.js");
const { localCache } = await import("../../src/utils/LocalCache.js");
const { d1 } = await import("../../src/services/d1.js");
const { logger } = await import("../../src/services/logger.js");

describe("DriveRepository", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLocalCache.getOrSet.mockImplementation(async (key, loader) => {
            return await loader();
        });
    });

    describe("findByUserId", () => {
        beforeEach(() => {
            jest.clearAllMocks();
            mockLocalCache.get.mockReturnValue(null);
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue(null);
        });

        it("should return null for invalid userId", async () => {
            const result = await DriveRepository.findByUserId(null);
            expect(result).toBeNull();
            expect(mockLocalCache.get).not.toHaveBeenCalled();
        });

        it("should return local cached drive data", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            mockLocalCache.get.mockReturnValue(mockDrive);

            const result = await DriveRepository.findByUserId("user1");

            expect(mockLocalCache.get).toHaveBeenCalledWith("drive_user1");
            expect(result).toEqual(mockDrive);
        });

        it("should return cache drive data when local cache miss", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            mockCache.get.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findByUserId("user1");

            expect(mockLocalCache.get).toHaveBeenCalledWith("drive_user1");
            expect(mockCache.get).toHaveBeenCalledWith("drive:user1", "json");
            expect(mockLocalCache.set).toHaveBeenCalledWith("drive_user1", mockDrive, 60 * 1000);
            expect(result).toEqual(mockDrive);
        });

        it("should return D1 drive data when cache miss", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            mockD1.fetchOne.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findByUserId("user1");

            expect(mockLocalCache.get).toHaveBeenCalledWith("drive_user1");
            expect(mockCache.get).toHaveBeenCalledWith("drive:user1", "json");
            expect(mockD1.fetchOne).toHaveBeenCalledWith(
                "SELECT id, user_id, name, type, config_data, status, created_at FROM drives WHERE user_id = ? AND status = 'active'",
                ["user1"]
            );
            expect(mockCache.set).toHaveBeenCalledWith("drive:user1", mockDrive);
            expect(mockLocalCache.set).toHaveBeenCalledWith("drive_user1", mockDrive, 60 * 1000);
            expect(result).toEqual(mockDrive);
        });

        it("should fallback to D1 when cache fails", async () => {
            mockCache.get.mockRejectedValue(new Error("KV Error"));
            const d1Drive = { id: "drive123", user_id: "user1", name: "Test Drive", type: "mega", config_data: {}, status: "active" };
            mockD1.fetchOne.mockResolvedValue(d1Drive);

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toEqual(d1Drive);
            expect(logger.warn).toHaveBeenCalledWith("Cache unavailable for user1, falling back to D1:", expect.anything());
            expect(mockD1.fetchOne).toHaveBeenCalled();
        });

        it("should return null when both cache and D1 fail", async () => {
            mockCache.get.mockRejectedValue(new Error("KV Error"));
            mockD1.fetchOne.mockRejectedValue(new Error("D1 Error"));

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toBeNull();
        });
    });

    describe("create", () => {
        beforeEach(() => {
            jest.clearAllMocks();
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockCache.set.mockResolvedValue(true);
        });

        it("should throw error for missing required parameters", async () => {
            await expect(DriveRepository.create(null, "name", "mega", {})).rejects.toThrow("DriveRepository.create: Missing required parameters.");
            await expect(DriveRepository.create("user1", null, "mega", {})).rejects.toThrow("DriveRepository.create: Missing required parameters.");
            await expect(DriveRepository.create("user1", "name", "mega", null)).rejects.toThrow("DriveRepository.create: Missing required parameters.");
        });

        it("should create drive successfully with Write-Through", async () => {
            const configData = { user: "test@example.com", pass: "password" };

            const result = await DriveRepository.create("user1", "Mega-test@example.com", "mega", configData);

            // Verify D1 write
            expect(mockD1.run).toHaveBeenCalledWith(
                "INSERT INTO drives (id, user_id, name, type, config_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                expect.arrayContaining(["user1", "Mega-test@example.com", "mega", JSON.stringify(configData), "active"])
            );

            // Verify Cache writes
            expect(mockCache.set).toHaveBeenCalledWith("drive:user1", expect.objectContaining({
                id: expect.any(String),
                user_id: "user1",
                name: "Mega-test@example.com",
                type: "mega",
                config_data: configData,
                status: "active"
            }));
            expect(mockCache.set).toHaveBeenCalledWith(expect.stringMatching(/^drive_id:.+/), expect.objectContaining({
                id: expect.any(String),
                user_id: "user1"
            }));

            expect(mockLocalCache.del).toHaveBeenCalledWith("drive_user1");
            expect(result).toBe(true);
        });

        it("should throw error on D1 failure", async () => {
            mockD1.run.mockRejectedValue(new Error("D1 Error"));

            await expect(DriveRepository.create("user1", "name", "mega", {})).rejects.toThrow("D1 Error");
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe("deleteByUserId", () => {
        beforeEach(() => {
            jest.clearAllMocks();
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockCache.delete.mockResolvedValue(true);
        });

        it("should return early for invalid userId", async () => {
            await DriveRepository.deleteByUserId(null);
            expect(mockCache.get).not.toHaveBeenCalled();
        });

        it("should delete drive by userId successfully with Write-Through", async () => {
            const mockDrive = { id: "drive123", user_id: "user1" };
            mockLocalCache.get.mockReturnValue(mockDrive);

            await DriveRepository.deleteByUserId("user1");

            // Verify D1 update
            expect(mockD1.run).toHaveBeenCalledWith("UPDATE drives SET status = 'deleted', updated_at = ? WHERE id = ?", expect.any(Array));

            // Verify Cache deletes
            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive123");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drive_user1");
        });

        it("should handle case when drive not found", async () => {
            mockLocalCache.get.mockReturnValue(null);

            await DriveRepository.deleteByUserId("user1");

            expect(mockD1.run).not.toHaveBeenCalled();
            expect(mockCache.delete).not.toHaveBeenCalled();
        });
    });

    describe("delete", () => {
        beforeEach(() => {
            jest.clearAllMocks();
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockCache.get.mockResolvedValue({ id: "drive123", user_id: "user1" });
            mockCache.delete.mockResolvedValue(true);
        });

        it("should return early for invalid driveId", async () => {
            await DriveRepository.delete(null);
            expect(mockCache.get).not.toHaveBeenCalled();
        });

        it("should delete drive by id successfully with Write-Through", async () => {
            await DriveRepository.delete("drive123");

            // Verify D1 update
            expect(mockD1.run).toHaveBeenCalledWith("UPDATE drives SET status = 'deleted', updated_at = ? WHERE id = ?", [expect.any(Number), "drive123"]);

            // Verify Cache operations
            expect(mockCache.get).toHaveBeenCalledWith("drive_id:drive123", "json");
            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive123");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drives:active");
        });

        it("should handle case when drive not found", async () => {
            mockCache.get.mockResolvedValue(null);

            await DriveRepository.delete("drive123");

            expect(mockD1.run).not.toHaveBeenCalled();
            expect(mockCache.delete).not.toHaveBeenCalled();
        });
    });

    describe("findById", () => {
        it("should return null for invalid driveId", async () => {
            const result = await DriveRepository.findById(null);
            expect(result).toBeNull();
            expect(mockCache.get).not.toHaveBeenCalled();
        });

        it("should return drive by id", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            mockCache.get.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findById("drive123");

            expect(mockCache.get).toHaveBeenCalledWith("drive_id:drive123", "json");
            expect(result).toEqual(mockDrive);
        });

        it("should return null and log error on KV failure", async () => {
            mockCache.get.mockRejectedValue(new Error("KV Error"));

            const result = await DriveRepository.findById("drive123");

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe("findAll", () => {
        beforeEach(() => {
            jest.clearAllMocks();
            mockCache.listKeys = jest.fn();
        });

        it("should return drives from the active list", async () => {
            const mockDrives = ["drive1", "drive2"];
            mockCache.get.mockImplementation((key) => {
                if (key === "drives:active") return Promise.resolve(mockDrives);
                if (key === "drive_id:drive1") return Promise.resolve({ id: "drive1", name: "Drive 1" });
                if (key === "drive_id:drive2") return Promise.resolve({ id: "drive2", name: "Drive 2" });
                return Promise.resolve(null);
            });

            const result = await DriveRepository.findAll();
            expect(result).toHaveLength(2);
            expect(result[0].name).toBe("Drive 1");
            expect(result[1].name).toBe("Drive 2");
        });

        it("should return drives from D1 when cache is empty", async () => {
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchAll.mockResolvedValue([
                { id: "drive1" },
                { id: "drive2" }
            ]);
            mockCache.get.mockImplementation((key) => {
                if (key === "drive_id:drive1") return Promise.resolve({ id: "drive1", name: "Drive 1" });
                if (key === "drive_id:drive2") return Promise.resolve({ id: "drive2", name: "Drive 2" });
                return Promise.resolve(null);
            });

            const result = await DriveRepository.findAll();

            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                "SELECT id FROM drives WHERE status = 'active' ORDER BY created_at DESC"
            );
            expect(mockCache.set).toHaveBeenCalledWith("drives:active", ["drive1", "drive2"]);
            expect(result).toHaveLength(2);
        });

        it("should return empty array when no active drives", async () => {
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchAll.mockResolvedValue([]);
            const result = await DriveRepository.findAll();
            expect(result).toEqual([]);
        });
    });

    describe("Persistence and Cache Failover", () => {
        beforeEach(() => {
            jest.clearAllMocks();
        });

        it("should recover from cache failure using D1", async () => {
            // Setup: Cache fails, D1 has data
            mockLocalCache.get.mockReturnValue(null);
            mockCache.get.mockRejectedValue(new Error("Cache unavailable"));
            const d1Drive = { id: "drive123", user_id: "user1", name: "Test Drive", type: "mega", config_data: {}, status: "active" };
            mockD1.fetchOne.mockResolvedValue(d1Drive);

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toEqual(d1Drive);
            expect(mockCache.set).toHaveBeenCalledWith("drive:user1", d1Drive);
            expect(mockLocalCache.set).toHaveBeenCalledWith("drive_user1", d1Drive, 60 * 1000);
        });

        it("should maintain data consistency during create", async () => {
            const configData = { user: "test@example.com" };
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockCache.set.mockResolvedValue(true);

            await DriveRepository.create("user1", "Test Drive", "mega", configData);

            // Verify both D1 and Cache are updated
            expect(mockD1.run).toHaveBeenCalled();
            expect(mockCache.set).toHaveBeenCalledTimes(2); // drive:user1 and drive_id:xxx
        });

        it("should handle Write-Through delete", async () => {
            const mockDrive = { id: "drive123", user_id: "user1" };
            mockLocalCache.get.mockReturnValue(mockDrive);
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockCache.delete.mockResolvedValue(true);

            await DriveRepository.deleteByUserId("user1");

            // Verify both D1 and Cache are updated
            expect(mockD1.run).toHaveBeenCalledWith("UPDATE drives SET status = 'deleted', updated_at = ? WHERE id = ?", expect.any(Array));
            expect(mockCache.delete).toHaveBeenCalledTimes(2); // drive:user1 and drive_id:xxx
        });
    });
});
