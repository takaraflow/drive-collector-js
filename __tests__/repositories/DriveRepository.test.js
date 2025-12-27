// Updated test file - V3
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../src/services/kv.js", () => ({
    kv: {
        get: jest.fn(),
        set: jest.fn(),
        delete: jest.fn(),
    },
}));

jest.unstable_mockModule("../../src/utils/CacheService.js", () => ({
    cacheService: {
        getOrSet: jest.fn(),
        del: jest.fn(),
    },
}));

const { DriveRepository } = await import("../../src/repositories/DriveRepository.js");
const { kv } = await import("../../src/services/kv.js");
const { cacheService } = await import("../../src/utils/CacheService.js");

describe("DriveRepository", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        cacheService.getOrSet.mockImplementation(async (key, loader) => {
            return await loader();
        });
    });

    describe("findByUserId", () => {
        it("should return null for invalid userId", async () => {
            const result = await DriveRepository.findByUserId(null);
            expect(result).toBeNull();
            expect(cacheService.getOrSet).not.toHaveBeenCalled();
        });

        it("should return cached drive data", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            cacheService.getOrSet.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findByUserId("user1");

            expect(cacheService.getOrSet).toHaveBeenCalledWith("drive_user1", expect.any(Function), 60 * 1000);
            expect(result).toEqual(mockDrive);
        });

        it("should return null and log error on KV failure", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            cacheService.getOrSet.mockImplementation(async (key, loader) => {
                await loader(); // Call the loader function
            });
            kv.get.mockRejectedValue(new Error("KV Error"));

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith("DriveRepository.findByUserId error for user1:", expect.any(Error));
            consoleSpy.mockRestore();
        });
    });

    describe("create", () => {
        it("should throw error for missing required parameters", async () => {
            await expect(DriveRepository.create(null, "name", {})).rejects.toThrow("DriveRepository.create: Missing required parameters.");
            await expect(DriveRepository.create("user1", null, {})).rejects.toThrow("DriveRepository.create: Missing required parameters.");
            await expect(DriveRepository.create("user1", "name", null)).rejects.toThrow("DriveRepository.create: Missing required parameters.");
        });

        it("should create drive successfully", async () => {
            const configData = { user: "test@example.com", pass: "password" };
            kv.set.mockResolvedValue(true);

            const result = await DriveRepository.create("user1", "Mega-test@example.com", "mega", configData);

            expect(kv.set).toHaveBeenCalledWith("drive:user1", expect.objectContaining({
                id: expect.any(String),
                user_id: "user1",
                name: "Mega-test@example.com",
                type: "mega",
                config_data: configData,
                status: "active"
            }));
            expect(kv.set).toHaveBeenCalledWith(expect.stringMatching(/^drive_id:.+/), expect.objectContaining({
                id: expect.any(String),
                user_id: "user1"
            }));
            expect(cacheService.del).toHaveBeenCalledWith("drive_user1");
            expect(result).toBe(true);
        });

        it("should throw error on KV failure", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            kv.set.mockRejectedValue(new Error("KV Error"));

            await expect(DriveRepository.create("user1", "name", "mega", {})).rejects.toThrow("KV Error");
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe("deleteByUserId", () => {
        it("should return early for invalid userId", async () => {
            await DriveRepository.deleteByUserId(null);
            expect(kv.get).not.toHaveBeenCalled();
        });

        it("should delete drive by userId successfully", async () => {
            const mockDrive = { id: "drive123", user_id: "user1" };
            kv.get.mockResolvedValue(mockDrive);
            kv.delete.mockResolvedValue(true);

            await DriveRepository.deleteByUserId("user1");

            expect(kv.get).toHaveBeenCalledWith("drive:user1", "json");
            expect(kv.delete).toHaveBeenCalledWith("drive:user1");
            expect(kv.delete).toHaveBeenCalledWith("drive_id:drive123");
            expect(cacheService.del).toHaveBeenCalledWith("drive_user1");
        });

        it("should throw error on KV failure during deletion", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            // Mock findByUserId success
            kv.get.mockResolvedValue({ id: "drive123", user_id: "user1" });
            // Mock delete failure
            kv.delete.mockRejectedValue(new Error("KV Delete Error"));

            await expect(DriveRepository.deleteByUserId("user1")).rejects.toThrow("KV Delete Error");
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe("delete", () => {
        it("should return early for invalid driveId", async () => {
            await DriveRepository.delete(null);
            expect(kv.get).not.toHaveBeenCalled();
        });

        it("should delete drive by id successfully", async () => {
            const mockDrive = { id: "drive123", user_id: "user1" };
            kv.get.mockResolvedValue(mockDrive);
            kv.delete.mockResolvedValue(true);

            await DriveRepository.delete("drive123");

            expect(kv.get).toHaveBeenCalledWith("drive_id:drive123", "json");
            expect(kv.delete).toHaveBeenCalledWith("drive:user1");
            expect(kv.delete).toHaveBeenCalledWith("drive_id:drive123");
            expect(cacheService.del).toHaveBeenCalledWith("drives:active");
        });

        it("should throw error on KV failure during deletion", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            // Mock findById success
            kv.get.mockResolvedValue({ id: "drive123", user_id: "user1" });
            // Mock delete failure
            kv.delete.mockRejectedValue(new Error("KV Delete Error"));

            await expect(DriveRepository.delete("drive123")).rejects.toThrow("KV Delete Error");
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe("findById", () => {
        it("should return null for invalid driveId", async () => {
            const result = await DriveRepository.findById(null);
            expect(result).toBeNull();
            expect(kv.get).not.toHaveBeenCalled();
        });

        it("should return drive by id", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            kv.get.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findById("drive123");

            expect(kv.get).toHaveBeenCalledWith("drive_id:drive123", "json");
            expect(result).toEqual(mockDrive);
        });

        it("should return null and log error on KV failure", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            kv.get.mockRejectedValue(new Error("KV Error"));

            const result = await DriveRepository.findById("drive123");

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe("findAll", () => {
        it("should return empty array and log warning", async () => {
            const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

            const result = await DriveRepository.findAll();

            expect(result).toEqual([]);
            // Use stringContaining to avoid encoding issues with full Chinese string
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("DriveRepository.findAll"));
            consoleSpy.mockRestore();
        });
    });
});