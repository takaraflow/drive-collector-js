import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../src/services/d1.js", () => ({
    d1: {
        fetchAll: jest.fn(),
        fetchOne: jest.fn(),
        run: jest.fn(),
    },
}));

jest.unstable_mockModule("../../src/utils/CacheService.js", () => ({
    cacheService: {
        getOrSet: jest.fn(),
        del: jest.fn(),
    },
}));

const { DriveRepository } = await import("../../src/repositories/DriveRepository.js");
const { d1 } = await import("../../src/services/d1.js");
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
            const mockDrive = { id: 1, user_id: "user1", status: "active" };
            cacheService.getOrSet.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findByUserId("user1");

            expect(cacheService.getOrSet).toHaveBeenCalledWith("drive_user1", expect.any(Function), 10 * 60 * 1000);
            expect(result).toEqual(mockDrive);
        });

        it("should return null and log error on database failure", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            cacheService.getOrSet.mockImplementation(async (key, loader) => {
                await loader(); // Call the loader function
            });
            d1.fetchOne.mockRejectedValue(new Error("DB Error"));

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
            d1.run.mockResolvedValue({ success: true });

            const result = await DriveRepository.create("user1", "Mega-test@example.com", "mega", configData);

            expect(d1.run).toHaveBeenCalledWith(
                expect.stringContaining("INSERT INTO user_drives"),
                ["user1", "Mega-test@example.com", "mega", JSON.stringify(configData), expect.any(Number)]
            );
            expect(cacheService.del).toHaveBeenCalledWith("drive_user1");
            expect(cacheService.del).toHaveBeenCalledWith("drives:active");
            expect(result).toBe(true);
        });

        it("should throw error on database failure", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            d1.run.mockRejectedValue(new Error("DB Error"));

            await expect(DriveRepository.create("user1", "name", "mega", {})).rejects.toThrow("DB Error");
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe("deleteByUserId", () => {
        it("should return early for invalid userId", async () => {
            await DriveRepository.deleteByUserId(null);
            expect(d1.run).not.toHaveBeenCalled();
        });

        it("should delete drive by userId successfully", async () => {
            d1.run.mockResolvedValue({ success: true });

            await DriveRepository.deleteByUserId("user1");

            expect(d1.run).toHaveBeenCalledWith("DELETE FROM user_drives WHERE user_id = ?", ["user1"]);
            expect(cacheService.del).toHaveBeenCalledWith("drive_user1");
            expect(cacheService.del).toHaveBeenCalledWith("drives:active");
        });

        it("should throw error on database failure", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            d1.run.mockRejectedValue(new Error("DB Error"));

            await expect(DriveRepository.deleteByUserId("user1")).rejects.toThrow("DB Error");
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe("delete", () => {
        it("should return early for invalid driveId", async () => {
            await DriveRepository.delete(null);
            expect(d1.run).not.toHaveBeenCalled();
        });

        it("should delete drive by id successfully", async () => {
            d1.run.mockResolvedValue({ success: true });

            await DriveRepository.delete("123");

            expect(d1.run).toHaveBeenCalledWith("DELETE FROM user_drives WHERE id = ?", ["123"]);
            expect(cacheService.del).toHaveBeenCalledWith("drives:active");
        });

        it("should throw error on database failure", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            d1.run.mockRejectedValue(new Error("DB Error"));

            await expect(DriveRepository.delete("123")).rejects.toThrow("DB Error");
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe("findById", () => {
        it("should return null for invalid driveId", async () => {
            const result = await DriveRepository.findById(null);
            expect(result).toBeNull();
            expect(d1.fetchOne).not.toHaveBeenCalled();
        });

        it("should return drive by id", async () => {
            const mockDrive = { id: 123, user_id: "user1", status: "active" };
            d1.fetchOne.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findById("123");

            expect(d1.fetchOne).toHaveBeenCalledWith(
                "SELECT * FROM user_drives WHERE id = ? AND status = 'active'",
                ["123"]
            );
            expect(result).toEqual(mockDrive);
        });

        it("should return null and log error on database failure", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            d1.fetchOne.mockRejectedValue(new Error("DB Error"));

            const result = await DriveRepository.findById("123");

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe("findAll", () => {
        it("should call d1.fetchAll with correct SQL", async () => {
            const mockDrives = [
                { id: 1, user_id: "user1", status: "active" },
                { id: 2, user_id: "user2", status: "active" }
            ];
            d1.fetchAll.mockResolvedValue(mockDrives);

            const result = await DriveRepository.findAll();

            expect(d1.fetchAll).toHaveBeenCalledWith("SELECT * FROM user_drives WHERE status = 'active'");
            expect(result).toEqual(mockDrives);
        });

        it("should return empty array and log error on failure", async () => {
            const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});
            d1.fetchAll.mockRejectedValue(new Error("DB Error"));

            const result = await DriveRepository.findAll();

            expect(result).toEqual([]);
            expect(consoleSpy).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });
});