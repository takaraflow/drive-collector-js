// Updated test file - V3
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockCache = {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    getOrSet: jest.fn(),
    del: jest.fn(),
};

const mockLocalCache = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    getOrSet: jest.fn(),
};

jest.unstable_mockModule("../../src/services/CacheService.js", () => ({
    cache: mockCache,
}));

jest.unstable_mockModule("../../src/utils/LocalCache.js", () => ({
    localCache: mockLocalCache,
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
const { logger } = await import("../../src/services/logger.js");

describe("DriveRepository", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockLocalCache.getOrSet.mockImplementation(async (key, loader) => {
            return await loader();
        });
    });

    describe("findByUserId", () => {
        it("should return null for invalid userId", async () => {
            const result = await DriveRepository.findByUserId(null);
            expect(result).toBeNull();
            expect(mockLocalCache.getOrSet).not.toHaveBeenCalled();
        });

        it("should return cached drive data", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            mockLocalCache.getOrSet.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findByUserId("user1");

            expect(mockLocalCache.getOrSet).toHaveBeenCalledWith("drive_user1", expect.any(Function), 60 * 1000);
            expect(result).toEqual(mockDrive);
        });

        it("should return null and log error on KV failure", async () => {
            mockLocalCache.getOrSet.mockImplementation(async (key, loader) => {
                return await loader(); // Call the loader function
            });
            mockCache.get.mockRejectedValue(new Error("KV Error"));

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith("DriveRepository.findByUserId error for user1:", expect.anything());
        });
    });

    describe("create", () => {
        it("should throw error for missing required parameters", async () => {
            await expect(DriveRepository.create(null, "name", "mega", {})).rejects.toThrow("DriveRepository.create: Missing required parameters.");
            await expect(DriveRepository.create("user1", null, "mega", {})).rejects.toThrow("DriveRepository.create: Missing required parameters.");
            await expect(DriveRepository.create("user1", "name", "mega", null)).rejects.toThrow("DriveRepository.create: Missing required parameters.");
        });

        it("should create drive successfully", async () => {
            const configData = { user: "test@example.com", pass: "password" };
            mockCache.set.mockResolvedValue(true);

            const result = await DriveRepository.create("user1", "Mega-test@example.com", "mega", configData);

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

        it("should throw error on KV failure", async () => {
            mockCache.set.mockRejectedValue(new Error("KV Error"));

            await expect(DriveRepository.create("user1", "name", "mega", {})).rejects.toThrow("KV Error");
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe("deleteByUserId", () => {
        it("should return early for invalid userId", async () => {
            await DriveRepository.deleteByUserId(null);
            expect(mockCache.get).not.toHaveBeenCalled();
        });

        it("should delete drive by userId successfully", async () => {
            const mockDrive = { id: "drive123", user_id: "user1" };
            mockLocalCache.getOrSet.mockResolvedValue(mockDrive);
            mockCache.delete.mockResolvedValue(true);

            await DriveRepository.deleteByUserId("user1");

            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive123");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drive_user1");
        });

        it("should throw error on KV failure during deletion", async () => {
            // Mock findByUserId success
            mockLocalCache.getOrSet.mockResolvedValue({ id: "drive123", user_id: "user1" });
            // Mock delete failure
            mockCache.delete.mockRejectedValue(new Error("KV Delete Error"));

            await expect(DriveRepository.deleteByUserId("user1")).rejects.toThrow("KV Delete Error");
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe("delete", () => {
        it("should return early for invalid driveId", async () => {
            await DriveRepository.delete(null);
            expect(mockCache.get).not.toHaveBeenCalled();
        });

        it("should delete drive by id successfully", async () => {
            const mockDrive = { id: "drive123", user_id: "user1" };
            mockCache.get.mockResolvedValue(mockDrive);
            mockCache.delete.mockResolvedValue(true);

            await DriveRepository.delete("drive123");

            expect(mockCache.get).toHaveBeenCalledWith("drive_id:drive123", "json");
            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive123");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drives:active");
        });

        it("should throw error on KV failure during deletion", async () => {
            // Mock findById success
            mockCache.get.mockResolvedValue({ id: "drive123", user_id: "user1" });
            // Mock delete failure
            mockCache.delete.mockRejectedValue(new Error("KV Delete Error"));

            await expect(DriveRepository.delete("drive123")).rejects.toThrow("KV Delete Error");
            expect(logger.error).toHaveBeenCalled();
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

        it("should return empty array when no active drives", async () => {
            mockCache.get.mockResolvedValue(null);
            const result = await DriveRepository.findAll();
            expect(result).toEqual([]);
        });
    });
});
