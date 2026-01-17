// Updated test file - V4 (Multi-Drive Support)
const mockCache = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrSet: vi.fn(),
    del: vi.fn(),
    listKeys: vi.fn(),
};

const mockLocalCache = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    getOrSet: vi.fn(),
};

const mockD1 = {
    fetchOne: vi.fn(),
    fetchAll: vi.fn(),
    run: vi.fn(),
};

vi.mock("../../src/services/CacheService.js", () => ({
    cache: mockCache,
}));

vi.mock("../../src/utils/LocalCache.js", () => ({
    localCache: mockLocalCache,
}));

vi.mock("../../src/services/d1.js", () => ({
    d1: mockD1,
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

const { DriveRepository } = await import("../../src/repositories/DriveRepository.js");
const { cache } = await import("../../src/services/CacheService.js");
const { localCache } = await import("../../src/utils/LocalCache.js");
const { d1 } = await import("../../src/services/d1.js");
const { logger } = await import("../../src/services/logger/index.js");

describe("DriveRepository", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("findByUserId (Multi-Drive)", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockLocalCache.get.mockReturnValue(null);
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchAll.mockResolvedValue([]);
        });

        it("should return empty array for invalid userId", async () => {
            const result = await DriveRepository.findByUserId(null);
            expect(result).toEqual([]);
            expect(mockLocalCache.get).not.toHaveBeenCalled();
        });

        it("should return local cached drive array", async () => {
            const mockDrives = [
                { id: "drive1", user_id: "user1", status: "active" },
                { id: "drive2", user_id: "user1", status: "active" }
            ];
            mockLocalCache.get.mockReturnValue(mockDrives);

            const result = await DriveRepository.findByUserId("user1");

            expect(mockLocalCache.get).toHaveBeenCalledWith("drive_user1");
            expect(result).toEqual(mockDrives);
        });

        it("should return cache drive array when local cache miss", async () => {
            const mockDrives = [
                { id: "drive1", user_id: "user1", status: "active" },
                { id: "drive2", user_id: "user1", status: "active" }
            ];
            mockCache.get.mockResolvedValue(mockDrives);

            const result = await DriveRepository.findByUserId("user1");

            expect(mockLocalCache.get).toHaveBeenCalledWith("drive_user1");
            expect(mockCache.get).toHaveBeenCalledWith("drive:user1", "json");
            expect(mockLocalCache.set).toHaveBeenCalledWith("drive_user1", mockDrives, 60 * 1000);
            expect(result).toEqual(mockDrives);
        });

        it("should return D1 drive array when cache miss", async () => {
            const mockDrives = [
                { id: "drive1", user_id: "user1", status: "active" },
                { id: "drive2", user_id: "user1", status: "active" }
            ];
            mockD1.fetchAll.mockResolvedValue(mockDrives);

            const result = await DriveRepository.findByUserId("user1");

            expect(mockLocalCache.get).toHaveBeenCalledWith("drive_user1");
            expect(mockCache.get).toHaveBeenCalledWith("drive:user1", "json");
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                "SELECT id, user_id, name, type, config_data, remote_folder, status, created_at FROM drives WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC",
                ["user1"]
            );
            expect(mockCache.set).toHaveBeenCalledWith("drive:user1", mockDrives);
            expect(mockLocalCache.set).toHaveBeenCalledWith("drive_user1", mockDrives, 60 * 1000);
            expect(result).toEqual(mockDrives);
        });

        it("should fallback to D1 when cache fails", async () => {
            mockCache.get.mockRejectedValue(new Error("KV Error"));
            const d1Drives = [
                { id: "drive1", user_id: "user1", name: "Drive 1", type: "mega", config_data: {}, status: "active" }
            ];
            mockD1.fetchAll.mockResolvedValue(d1Drives);

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toEqual(d1Drives);
            expect(logger.warn).toHaveBeenCalledWith("Cache unavailable for user1, falling back to D1:", expect.anything());
            expect(mockD1.fetchAll).toHaveBeenCalled();
        });

        it("should return empty array when both cache and D1 fail", async () => {
            mockCache.get.mockRejectedValue(new Error("KV Error"));
            mockD1.fetchAll.mockRejectedValue(new Error("D1 Error"));

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toEqual([]);
        });

        it("should skip cache and query D1 directly when skipCache is true", async () => {
            const mockDrives = [{ id: "drive1", user_id: "user1", status: "active" }];
            mockD1.fetchAll.mockResolvedValue(mockDrives);

            const result = await DriveRepository.findByUserId("user1", true);

            expect(mockLocalCache.get).not.toHaveBeenCalled();
            expect(mockCache.get).not.toHaveBeenCalled();
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                "SELECT id, user_id, name, type, config_data, remote_folder, status, created_at FROM drives WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC",
                ["user1"]
            );
            expect(result).toEqual(mockDrives);
        });

        it("should handle non-primitive types by converting to string to avoid D1 400 errors", async () => {
            const complexObj = { toString: () => "complex-user-id" };
            mockD1.fetchAll.mockResolvedValue([]);
            
            await DriveRepository.findByUserId(complexObj, true);
            
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.any(String),
                ["complex-user-id"] // toString() called
            );
        });

        it("should continue if cache.set fails in findByUserId", async () => {
            const mockDrives = [{ id: "drive1", user_id: "user1", status: "active" }];
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchAll.mockResolvedValue(mockDrives);
            mockCache.set.mockRejectedValue(new Error("Set failed"));

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toEqual(mockDrives);
            expect(logger.warn).toHaveBeenCalledWith("Failed to update cache for user1:", expect.any(Error));
        });
    });

    describe("create (Multi-Drive)", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockCache.set.mockResolvedValue(true);
            mockCache.get.mockResolvedValue([]); // Assume empty initial list
            mockCache.listKeys.mockResolvedValue([]);
        });

        it("should throw error for missing required parameters", async () => {
            await expect(DriveRepository.create(null, "name", "mega", {})).rejects.toThrow("DriveRepository.create: Missing required parameters.");
            await expect(DriveRepository.create("user1", null, "mega", {})).rejects.toThrow("DriveRepository.create: Missing required parameters.");
            await expect(DriveRepository.create("user1", "name", "mega", null)).rejects.toThrow("DriveRepository.create: Missing required parameters.");
        });

        it("should create drive successfully with Write-Through and append to list", async () => {
            const configData = { user: "test@example.com", pass: "password" };
            
            // Mock getting existing drives (empty)
            mockCache.get.mockResolvedValue([]);

            const result = await DriveRepository.create("user1", "Mega-test@example.com", "mega", configData);

            // Verify D1 write
            expect(mockD1.run).toHaveBeenCalledWith(
                "INSERT INTO drives (id, user_id, name, type, config_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                expect.arrayContaining(["user1", "Mega-test@example.com", "mega", JSON.stringify(configData), "active"])
            );

            // Verify Cache writes (expecting array append)
            expect(mockCache.set).toHaveBeenCalledWith("drive:user1", expect.arrayContaining([
                expect.objectContaining({ user_id: "user1", name: "Mega-test@example.com" })
            ]));
            
            // Verify drive_id cache write
            expect(mockCache.set).toHaveBeenCalledWith(expect.stringMatching(/^drive_id:.+/), expect.objectContaining({
                user_id: "user1"
            }));

            expect(mockLocalCache.del).toHaveBeenCalledWith("drive_user1");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drives:active");
            expect(result).toBe(true);
        });

        it("should append to existing drive list", async () => {
            const configData = { user: "test2@example.com", pass: "password" };
            const existingDrives = [{ id: "drive1", user_id: "user1", name: "Mega-test1@example.com", type: "mega", config_data: {}, status: "active", created_at: 1000 }];
            mockCache.get.mockResolvedValue(existingDrives);

            await DriveRepository.create("user1", "Mega-test2@example.com", "mega", configData);

            // Verify that cache.set is called with the UPDATED array
            expect(mockCache.set).toHaveBeenCalledWith("drive:user1", expect.arrayContaining([
                expect.objectContaining({ id: "drive1" }),
                expect.objectContaining({ name: "Mega-test2@example.com" })
            ]));
        });

        it("should throw error on D1 failure", async () => {
            mockD1.run.mockRejectedValue(new Error("D1 Error"));

            await expect(DriveRepository.create("user1", "name", "mega", {})).rejects.toThrow("D1 Error");
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe("deleteByUserId", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockD1.fetchAll.mockResolvedValue([]);
            mockCache.delete.mockResolvedValue(true);
        });

        it("should return early for invalid userId", async () => {
            await DriveRepository.deleteByUserId(null);
            expect(mockCache.get).not.toHaveBeenCalled();
        });

        it("should delete all drives by userId successfully", async () => {
            const mockDrives = [
                { id: "drive1", user_id: "user1" },
                { id: "drive2", user_id: "user1" }
            ];
            mockLocalCache.get.mockReturnValue(mockDrives);

            await DriveRepository.deleteByUserId("user1");

            // Verify D1 updates for EACH drive
            expect(mockD1.run).toHaveBeenCalledTimes(2);
            
            // Verify Cache deletes (drive_id keys)
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive1");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive2");
            
            // Verify user key deleted
            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            
            expect(mockLocalCache.del).toHaveBeenCalledWith("drive_user1");
        });

        it("should handle case when no drives found", async () => {
            mockLocalCache.get.mockReturnValue([]);

            await DriveRepository.deleteByUserId("user1");

            expect(mockD1.run).not.toHaveBeenCalled();
            // We expect cache.delete to be called to clean up the user key (even if empty)
            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
        });

        it("should handle errors in deleteByUserId", async () => {
            const mockDrives = [{ id: "drive1", user_id: "user1" }];
            mockLocalCache.get.mockReturnValue(mockDrives);
            mockD1.run.mockRejectedValue(new Error("D1 Error"));

            await expect(DriveRepository.deleteByUserId("user1")).rejects.toThrow("D1 Error");
            expect(logger.error).toHaveBeenCalledWith("DriveRepository.deleteByUserId failed for user1:", expect.any(Error));
        });
    });

    describe("delete (Single Drive)", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockD1.fetchOne.mockResolvedValue({ id: "drive123", user_id: "user1", status: "active" });
            mockCache.get.mockResolvedValue([{ id: "drive123", user_id: "user1" }]);
            mockCache.delete.mockResolvedValue(true);
        });

        it("should return early for invalid driveId", async () => {
            await DriveRepository.delete(null);
            expect(mockCache.get).not.toHaveBeenCalled();
        });

        it("should delete drive by id and update user list cache", async () => {
            const initialList = [
                { id: "drive123", user_id: "user1" },
                { id: "drive456", user_id: "user1" }
            ];
            // Mock findById (drive_id:drive123)
            mockCache.get.mockImplementation((key) => {
                if (key === "drive_id:drive123") return Promise.resolve({ id: "drive123", user_id: "user1" });
                if (key === "drive:user1") return Promise.resolve(initialList);
                return Promise.resolve(null);
            });

            await DriveRepository.delete("drive123");

            // Verify D1 update
            expect(mockD1.run).toHaveBeenCalledWith("UPDATE drives SET status = 'deleted', updated_at = ? WHERE id = ?", [expect.any(Number), "drive123"]);

            // Verify Cache operations
            expect(mockCache.get).toHaveBeenCalledWith("drive_id:drive123", "json");
            expect(mockCache.get).toHaveBeenCalledWith("drive:user1", "json");
            
            // Verify list was updated (drive123 removed)
            expect(mockCache.set).toHaveBeenCalledWith("drive:user1", [
                { id: "drive456", user_id: "user1" }
            ]);

            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive123");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drives:active"); // Note: key is "drives:active"
        });

        it("should handle case when drive not found", async () => {
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue(null);

            await DriveRepository.delete("drive123");

            expect(mockD1.run).not.toHaveBeenCalled();
            expect(mockCache.delete).not.toHaveBeenCalled();
        });

        it("should handle errors in delete", async () => {
            const mockDrive = { id: "drive123", user_id: "user1" };
            mockCache.get.mockResolvedValue([mockDrive]);
            mockD1.run.mockRejectedValue(new Error("D1 Error"));

            await expect(DriveRepository.delete("drive123")).rejects.toThrow("D1 Error");
            expect(logger.error).toHaveBeenCalledWith("DriveRepository.delete failed for drive123:", expect.any(Error));
        });
    });

    describe("findById", () => {
        // (Unchanged from previous version, but ensure mocks are reset)
        beforeEach(() => {
            vi.clearAllMocks();
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue(null);
        });

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
    });

    describe("findAll", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockCache.listKeys = vi.fn();
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchAll.mockResolvedValue([]);
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
    });

    describe("Persistence and Cache Failover", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should recover from cache failure using D1 (Multi-Drive)", async () => {
            mockLocalCache.get.mockReturnValue(null);
            mockCache.get.mockRejectedValue(new Error("Cache unavailable"));
            const d1Drives = [
                { id: "drive1", user_id: "user1", name: "Drive 1", type: "mega", config_data: {}, status: "active" },
                { id: "drive2", user_id: "user1", name: "Drive 2", type: "mega", config_data: {}, status: "active" }
            ];
            mockD1.fetchAll.mockResolvedValue(d1Drives);

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toEqual(d1Drives);
            expect(mockCache.set).toHaveBeenCalledWith("drive:user1", d1Drives);
            expect(mockLocalCache.set).toHaveBeenCalledWith("drive_user1", d1Drives, 60 * 1000);
        });
    });
});
