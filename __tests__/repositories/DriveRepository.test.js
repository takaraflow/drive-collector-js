// Updated test file - V3
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

vi.mock("../../src/services/logger.js", () => ({
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
const { logger } = await import("../../src/services/logger.js");

describe("DriveRepository", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockLocalCache.getOrSet.mockImplementation(async (key, loader) => {
            return await loader();
        });
    });

    describe("findByUserId", () => {
        beforeEach(() => {
            vi.clearAllMocks();
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
                "SELECT id, user_id, name, type, config_data, remote_folder, status, created_at FROM drives WHERE user_id = ? AND status = 'active'",
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

        it("should skip cache and query D1 directly when skipCache is true", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            mockD1.fetchOne.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findByUserId("user1", true);

            expect(mockLocalCache.get).not.toHaveBeenCalled();
            expect(mockCache.get).not.toHaveBeenCalled();
            expect(mockD1.fetchOne).toHaveBeenCalledWith(
                "SELECT id, user_id, name, type, config_data, remote_folder, status, created_at FROM drives WHERE user_id = ? AND status = 'active'",
                ["user1"]
            );
            expect(result).toEqual(mockDrive);
        });

        it("should handle invalid types passed to _findDriveInD1 gracefully", async () => {
             // 通过 skipCache=true 强制直接调用 _findDriveInD1
             const resultNum = await DriveRepository.findByUserId(12345, true);
             expect(mockD1.fetchOne).toHaveBeenCalledWith(
                 expect.stringContaining("WHERE user_id = ?"),
                 ["12345"] // Should be stringified
             );

             // Test with object (although findByUserId usually filters, simulate direct internal call logic)
             // We can't call _findDriveInD1 directly as it is private, but we can verify behavior if passed through
             // If findByUserId allows it (e.g. if we remove the check there or if we test the private method implicitly)
        });

        it("should handle non-primitive types by converting to string to avoid D1 400 errors", async () => {
             // Directly mocking what would happen if a complex object bypassed initial checks
             const complexObj = { toString: () => "complex-user-id" };
             mockD1.fetchOne.mockResolvedValue(null);
             
             await DriveRepository.findByUserId(complexObj, true);
             
             expect(mockD1.fetchOne).toHaveBeenCalledWith(
                 expect.any(String),
                 ["complex-user-id"] // toString() called
             );
        });

        it("should continue if cache.set fails in findByUserId", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue(mockDrive);
            mockCache.set.mockRejectedValue(new Error("Set failed"));

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toEqual(mockDrive);
            expect(logger.warn).toHaveBeenCalledWith("Failed to update cache for user1:", expect.any(Error));
        });
    });

    describe("create", () => {
        beforeEach(() => {
            vi.clearAllMocks();
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
            mockCache.listKeys.mockResolvedValue([]);
            mockCache.get.mockResolvedValue(null);

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
            expect(mockLocalCache.del).toHaveBeenCalledWith("drives:active");
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
            vi.clearAllMocks();
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockD1.fetchOne.mockResolvedValue(null);
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

        it("should handle errors in deleteByUserId", async () => {
            const mockDrive = { id: "drive123", user_id: "user1" };
            mockLocalCache.get.mockReturnValue(mockDrive);
            mockD1.run.mockRejectedValue(new Error("D1 Error"));

            await expect(DriveRepository.deleteByUserId("user1")).rejects.toThrow("D1 Error");
            expect(logger.error).toHaveBeenCalledWith("DriveRepository.deleteByUserId failed for user1:", expect.any(Error));
        });
    });

    describe("delete", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockD1.fetchOne.mockResolvedValue({ id: "drive123", user_id: "user1", status: "active" });
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
            mockD1.fetchOne.mockResolvedValue(null);

            await DriveRepository.delete("drive123");

            expect(mockD1.run).not.toHaveBeenCalled();
            expect(mockCache.delete).not.toHaveBeenCalled();
        });

        it("should handle errors in delete", async () => {
            const mockDrive = { id: "drive123", user_id: "user1" };
            mockCache.get.mockResolvedValue(mockDrive);
            mockD1.run.mockRejectedValue(new Error("D1 Error"));

            await expect(DriveRepository.delete("drive123")).rejects.toThrow("D1 Error");
            expect(logger.error).toHaveBeenCalledWith("DriveRepository.delete failed for drive123:", expect.any(Error));
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
            expect(logger.error).toHaveBeenCalledWith("DriveRepository.findById error for drive123:", expect.any(Error));
        });

        it("should handle cache miss and populate from D1", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findById("drive123");

            expect(mockCache.get).toHaveBeenCalledWith("drive_id:drive123", "json");
            expect(mockD1.fetchOne).toHaveBeenCalledWith(
                "SELECT id, user_id, name, type, config_data, remote_folder, status, created_at FROM drives WHERE id = ? AND status = 'active'",
                ["drive123"]
            );
            expect(mockCache.set).toHaveBeenCalledWith("drive_id:drive123", mockDrive);
            expect(result).toEqual(mockDrive);
        });
    });

    describe("findAll", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockCache.listKeys = vi.fn();
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

        it("should handle cache miss in findById during findAll", async () => {
            mockCache.get.mockResolvedValue(["drive1"]);
            mockCache.get.mockImplementation((key) => {
                if (key === "drives:active") return ["drive1"];
                return null;
            });
            mockD1.fetchOne.mockResolvedValue({ id: "drive1", name: "Drive 1" });

            const result = await DriveRepository.findAll();

            expect(mockD1.fetchOne).toHaveBeenCalled();
            expect(mockCache.set).toHaveBeenCalledWith("drive_id:drive1", { id: "drive1", name: "Drive 1" });
            expect(result).toHaveLength(1);
        });

        it("should return empty array when no active drives", async () => {
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchAll.mockResolvedValue([]);
            const result = await DriveRepository.findAll();
            expect(result).toEqual([]);
        });

        it("should handle errors in findAll", async () => {
            mockCache.get.mockRejectedValue(new Error("Cache error"));

            const result = await DriveRepository.findAll();

            expect(result).toEqual([]);
            expect(logger.error).toHaveBeenCalledWith("DriveRepository.findAll error:", expect.any(Error));
        });

        it("should handle partial failures in findAll", async () => {
            mockCache.get.mockImplementation((key) => {
                if (key === "drives:active") return ["drive1", "drive2"];
                if (key === "drive_id:drive1") return { id: "drive1", name: "Drive 1" };
                if (key === "drive_id:drive2") return null; // drive2 missing
                return null;
            });
            mockD1.fetchOne.mockResolvedValue({ id: "drive2", name: "Drive 2" });

            const result = await DriveRepository.findAll();

            expect(result).toHaveLength(2);
            expect(mockD1.fetchOne).toHaveBeenCalledWith(
                "SELECT id, user_id, name, type, config_data, remote_folder, status, created_at FROM drives WHERE id = ? AND status = 'active'",
                ["drive2"]
            );
        });

        it("should skip drives that cannot be found anywhere in findAll", async () => {
            mockCache.get.mockImplementation((key) => {
                if (key === "drives:active") return ["drive1", "drive2"];
                if (key === "drive_id:drive1") return { id: "drive1", name: "Drive 1" };
                return null;
            });
            mockD1.fetchOne.mockResolvedValue(null); // drive2 missing from D1 too

            const result = await DriveRepository.findAll();

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe("drive1");
        });
    });

    describe("Persistence and Cache Failover", () => {
        beforeEach(() => {
            vi.clearAllMocks();
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

    describe("_updateActiveDrivesList", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should update active drives list successfully", async () => {
            mockCache.listKeys.mockResolvedValue(["drive:user1"]);
            mockCache.get.mockResolvedValue({ id: "drive123", user_id: "user1" });

            await DriveRepository._updateActiveDrivesList();

            expect(mockCache.listKeys).toHaveBeenCalledWith('drive:');
            expect(mockCache.get).toHaveBeenCalledWith("drive:user1", "json");
            expect(mockCache.set).toHaveBeenCalledWith("drives:active", ["drive123"]);
            expect(logger.info).toHaveBeenCalledWith("📝 已更新活跃网盘列表，共 1 个");
        });

        it("should handle errors in _updateActiveDrivesList", async () => {
            mockCache.listKeys.mockRejectedValue(new Error("ListKeys failed"));

            await DriveRepository._updateActiveDrivesList();

            expect(logger.error).toHaveBeenCalledWith("Failed to update active drives list:", expect.any(Error));
        });

        it("should skip drive_id keys when updating active list", async () => {
            mockCache.listKeys.mockResolvedValue(["drive:user1", "drive_id:drive123"]);
            mockCache.get.mockImplementation((key) => {
                if (key === "drive:user1") return { id: "drive123", user_id: "user1" };
                return null;
            });

            await DriveRepository._updateActiveDrivesList();

            expect(mockCache.get).toHaveBeenCalledWith("drive:user1", "json");
            expect(mockCache.set).toHaveBeenCalledWith("drives:active", ["drive123"]);
        });

        it("should handle empty cache list", async () => {
            mockCache.listKeys.mockResolvedValue([]);

            await DriveRepository._updateActiveDrivesList();

            expect(mockCache.set).toHaveBeenCalledWith("drives:active", []);
        });
    });
});
