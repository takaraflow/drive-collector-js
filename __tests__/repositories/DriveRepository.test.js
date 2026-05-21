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
                "SELECT id, user_id, name, type, config_data, remote_folder, status, is_default, created_at FROM drives WHERE user_id = ? AND status = ? ORDER BY is_default DESC, created_at DESC",
                ["user1", "active"]
            );
            expect(mockCache.set).toHaveBeenCalledWith("drive:user1", mockDrives);
            expect(mockLocalCache.set).toHaveBeenCalledWith("drive_user1", mockDrives, 60 * 1000);
            expect(result).toEqual(mockDrives);
        });

        it("should lazily mark unversioned legacy rclone password configs when loading drives", async () => {
            const legacyDrive = {
                id: "drive1",
                user_id: "user1",
                name: "Mega",
                type: "mega",
                config_data: JSON.stringify({ user: "test@example.com", pass: "raw-pass" }),
                status: "active",
                is_default: 1
            };
            mockD1.fetchAll.mockResolvedValue([legacyDrive]);
            mockD1.run.mockResolvedValue({ changes: 1 });

            const result = await DriveRepository.findByUserId("user1", true);

            expect(result[0].config_data).toContain('"pass_format":"legacy_unknown"');
            expect(result[0].config_data).toContain('"config_schema_version":1');
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE drives SET config_data = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = ?",
                expect.arrayContaining([
                    expect.stringContaining('"pass_format":"legacy_unknown"'),
                    expect.any(Number),
                    "drive1",
                    "user1",
                    "active"
                ])
            );
            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive1");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drive_user1");
        });

        it("should not repeatedly migrate already marked legacy password configs", async () => {
            const legacyDrive = {
                id: "drive1",
                user_id: "user1",
                name: "Mega",
                type: "mega",
                config_data: JSON.stringify({
                    user: "test@example.com",
                    pass: "raw-pass",
                    pass_format: "legacy_unknown",
                    config_schema_version: 1
                }),
                status: "active",
                is_default: 1
            };
            mockD1.fetchAll.mockResolvedValue([legacyDrive]);

            const result = await DriveRepository.findByUserId("user1", true);

            expect(result).toEqual([legacyDrive]);
            expect(mockD1.run).not.toHaveBeenCalled();
        });

        it("should not lazily migrate stale deleted drives from cache", async () => {
            const deletedDrive = {
                id: "drive1",
                user_id: "user1",
                name: "Mega",
                type: "mega",
                config_data: JSON.stringify({ user: "test@example.com", pass: "raw-pass" }),
                status: "deleted",
                is_default: 0
            };
            mockLocalCache.get.mockReturnValue([deletedDrive]);

            const result = await DriveRepository.findByUserId("user1");

            expect(result).toEqual([deletedDrive]);
            expect(mockD1.run).not.toHaveBeenCalled();
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
                "SELECT id, user_id, name, type, config_data, remote_folder, status, is_default, created_at FROM drives WHERE user_id = ? AND status = ? ORDER BY is_default DESC, created_at DESC",
                ["user1", "active"]
            );
            expect(result).toEqual(mockDrives);
        });

        it("should handle non-primitive types by converting to string to avoid D1 400 errors", async () => {
            const complexObj = { toString: () => "complex-user-id" };
            mockD1.fetchAll.mockResolvedValue([]);
            
            await DriveRepository.findByUserId(complexObj, true);
            
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.any(String),
                ["complex-user-id", "active"]
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
            mockD1.fetchAll.mockResolvedValue([]);
        });

        it("should throw error for missing required parameters", async () => {
            await expect(DriveRepository.create(null, "name", "mega", {})).rejects.toThrow("DriveRepository.create: Missing required parameters.");
            await expect(DriveRepository.create("user1", null, "mega", {})).rejects.toThrow("DriveRepository.create: Missing required parameters.");
            await expect(DriveRepository.create("user1", "name", "mega", null)).rejects.toThrow("DriveRepository.create: Missing required parameters.");
        });

        it("should create drive successfully with Write-Through and invalidate derived list cache", async () => {
            const configData = { user: "test@example.com", pass: "password" };
            mockD1.fetchOne.mockResolvedValue(null);

            const result = await DriveRepository.create("user1", "Mega-test@example.com", "mega", configData);

            // Verify D1 write
            expect(mockD1.run).toHaveBeenCalledWith(
                "INSERT INTO drives (id, user_id, name, type, config_data, status, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                expect.arrayContaining(["user1", "Mega-test@example.com", "mega", JSON.stringify(configData), "active", 0])
            );

            // Verify drive_id cache write
            expect(mockCache.set).toHaveBeenCalledWith(expect.stringMatching(/^drive_id:.+/), expect.objectContaining({
                user_id: "user1",
                config_data: JSON.stringify(configData)
            }));

            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).toHaveBeenCalledWith("drives:active");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drive_user1");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drives:active");
            expect(result).toBe(true);
        });

        it("should reject creating a duplicate active drive of the same type", async () => {
            mockD1.fetchOne.mockResolvedValueOnce({
                id: "drive-active",
                user_id: "user1",
                type: "mega",
                status: "active"
            });

            await expect(DriveRepository.create("user1", "Mega-duplicate", "mega", { user: "dup@example.com" }))
                .rejects.toThrow("Active drive already exists");

            expect(mockD1.run).not.toHaveBeenCalled();
            expect(mockCache.set).not.toHaveBeenCalled();
        });

        it("should reactivate a soft-deleted drive of the same type", async () => {
            const deletedDrive = {
                id: "drive-deleted",
                user_id: "user1",
                type: "mega",
                status: "deleted",
                created_at: 1000
            };
            mockD1.fetchOne
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(deletedDrive);
            mockD1.run.mockResolvedValue({ changes: 1 });

            const result = await DriveRepository.create("user1", "Mega-new", "mega", { user: "new@example.com" });

            expect(result).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE drives SET name = ?, config_data = ?, remote_folder = NULL, status = ?, is_default = 0, updated_at = ? WHERE id = ? AND user_id = ? AND type = ? AND status = ?",
                ["Mega-new", JSON.stringify({ user: "new@example.com" }), "active", expect.any(Number), "drive-deleted", "user1", "mega", "deleted"]
            );
            expect(mockD1.run).not.toHaveBeenCalledWith(
                expect.stringContaining("INSERT INTO drives"),
                expect.any(Array)
            );
            expect(mockCache.set).toHaveBeenCalledWith("drive_id:drive-deleted", expect.objectContaining({
                id: "drive-deleted",
                status: "active",
                is_default: 0
            }));
        });

        it("should throw error on D1 failure", async () => {
            mockD1.run.mockRejectedValue(new Error("D1 Error"));

            await expect(DriveRepository.create("user1", "name", "mega", {})).rejects.toThrow("D1 Error");
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe("updateConfigData", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockD1.run.mockResolvedValue({ changes: 1 });
        });

        it("should update drive config and invalidate derived caches", async () => {
            const configData = {
                user: "test@example.com",
                pass: "stored-obscured",
                pass_format: "rclone_obscured",
                config_schema_version: 1
            };

            const result = await DriveRepository.updateConfigData("user1", "drive1", configData);

            expect(result).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE drives SET config_data = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = ?",
                [JSON.stringify(configData), expect.any(Number), "drive1", "user1", "active"]
            );
            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive1");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drive_user1");
        });

        it("should reject missing required parameters", async () => {
            await expect(DriveRepository.updateConfigData(null, "drive1", {}))
                .rejects.toThrow("DriveRepository.updateConfigData: Missing required parameters.");
            await expect(DriveRepository.updateConfigData("user1", null, {}))
                .rejects.toThrow("DriveRepository.updateConfigData: Missing required parameters.");
            await expect(DriveRepository.updateConfigData("user1", "drive1", null))
                .rejects.toThrow("DriveRepository.updateConfigData: Missing required parameters.");
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
            mockD1.fetchAll.mockResolvedValue(mockDrives);

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
            mockD1.fetchAll.mockResolvedValue(mockDrives);
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

        it("should return early for invalid userId or driveId", async () => {
            await expect(DriveRepository.delete(null, "drive123")).resolves.toBe(false);
            await expect(DriveRepository.delete("user1", null)).resolves.toBe(false);
            expect(mockCache.get).not.toHaveBeenCalled();
        });

        it("should delete drive owned by user and update user list cache", async () => {
            const initialList = [
                { id: "drive123", user_id: "user1" },
                { id: "drive456", user_id: "user1" }
            ];
            mockCache.get.mockImplementation((key) => {
                if (key === "drive_id:drive123") return Promise.resolve({ id: "drive123", user_id: "user1" });
                return Promise.resolve(null);
            });

            const result = await DriveRepository.delete("user1", "drive123");

            // Verify D1 update
            expect(result).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE drives SET status = ?, is_default = 0, updated_at = ? WHERE id = ? AND user_id = ?",
                ["deleted", expect.any(Number), "drive123", "user1"]
            );

            // Verify Cache operations
            expect(mockCache.get).toHaveBeenCalledWith("drive_id:drive123", "json");
            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).toHaveBeenCalledWith("drives:active");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive123");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drive_user1");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drives:active"); // Note: key is "drives:active"
        });

        it("should return false when the owner-scoped update affects no rows", async () => {
            mockCache.get.mockResolvedValue({ id: "drive123", user_id: "user1" });
            mockD1.run.mockResolvedValue({ changes: 0 });

            const result = await DriveRepository.delete("user1", "drive123");

            expect(result).toBe(false);
            expect(mockCache.delete).not.toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).not.toHaveBeenCalledWith("drive_id:drive123");
        });

        it("should not delete a drive that belongs to another user", async () => {
            mockCache.get.mockResolvedValue({ id: "drive123", user_id: "other-user" });

            const result = await DriveRepository.delete("user1", "drive123");

            expect(result).toBe(false);
            expect(mockD1.run).not.toHaveBeenCalled();
            expect(mockCache.delete).not.toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).not.toHaveBeenCalledWith("drive_id:drive123");
        });

        it("should handle case when drive not found", async () => {
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue(null);

            const result = await DriveRepository.delete("user1", "drive123");

            expect(result).toBe(false);
            expect(mockD1.run).not.toHaveBeenCalled();
            expect(mockCache.delete).not.toHaveBeenCalled();
        });

        it("should handle errors in delete", async () => {
            const mockDrive = { id: "drive123", user_id: "user1" };
            mockCache.get.mockResolvedValue(mockDrive);
            mockD1.run.mockRejectedValue(new Error("D1 Error"));

            await expect(DriveRepository.delete("user1", "drive123")).rejects.toThrow("D1 Error");
            expect(logger.error).toHaveBeenCalledWith("DriveRepository.delete failed for user1/drive123:", expect.any(Error));
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

        it("should lazily mark legacy password configs from drive id cache", async () => {
            const legacyDrive = {
                id: "drive123",
                user_id: "user1",
                type: "mega",
                config_data: JSON.stringify({ user: "test@example.com", pass: "raw-pass" }),
                status: "active"
            };
            mockCache.get.mockResolvedValue(legacyDrive);
            mockD1.run.mockResolvedValue({ changes: 1 });

            const result = await DriveRepository.findById("drive123");

            expect(result.config_data).toContain('"pass_format":"legacy_unknown"');
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE drives SET config_data = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = ?",
                expect.arrayContaining([
                    expect.stringContaining('"pass_format":"legacy_unknown"'),
                    expect.any(Number),
                    "drive123",
                    "user1",
                    "active"
                ])
            );
            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive123");
        });

        it("should lazily mark legacy password configs from D1 by id before caching", async () => {
            const legacyDrive = {
                id: "drive123",
                user_id: "user1",
                type: "mega",
                config_data: JSON.stringify({ user: "test@example.com", pass: "raw-pass" }),
                status: "active"
            };
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue(legacyDrive);
            mockD1.run.mockResolvedValue({ changes: 1 });

            const result = await DriveRepository.findById("drive123");

            expect(result.config_data).toContain('"pass_format":"legacy_unknown"');
            expect(mockCache.set).toHaveBeenCalledWith("drive_id:drive123", expect.objectContaining({
                id: "drive123",
                config_data: expect.stringContaining('"pass_format":"legacy_unknown"')
            }));
        });
    });

    describe("findByUserAndId", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue(null);
        });

        it("should return null for missing userId or driveId", async () => {
            await expect(DriveRepository.findByUserAndId(null, "drive123")).resolves.toBeNull();
            await expect(DriveRepository.findByUserAndId("user1", null)).resolves.toBeNull();
            expect(mockCache.get).not.toHaveBeenCalled();
        });

        it("should return drive only when it belongs to the user", async () => {
            const mockDrive = { id: "drive123", user_id: "user1", status: "active" };
            mockCache.get.mockResolvedValue(mockDrive);

            const result = await DriveRepository.findByUserAndId("user1", "drive123");

            expect(result).toEqual(mockDrive);
        });

        it("should return null when drive belongs to another user", async () => {
            mockCache.get.mockResolvedValue({ id: "drive123", user_id: "other-user", status: "active" });

            const result = await DriveRepository.findByUserAndId("user1", "drive123");

            expect(result).toBeNull();
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

    describe("default drive SSOT", () => {
        beforeEach(() => {
            vi.clearAllMocks();
            mockLocalCache.get.mockReturnValue(null);
            mockCache.get.mockResolvedValue(null);
            mockCache.delete.mockResolvedValue(true);
            mockCache.listKeys.mockResolvedValue([]);
            mockD1.run.mockResolvedValue({ changes: 1 });
            mockD1.fetchOne.mockResolvedValue(null);
        });

        it("should resolve the D1 default drive and fallback to first drive", async () => {
            const drives = [
                { id: "drive-default", user_id: "user1", is_default: 1 },
                { id: "drive-other", user_id: "user1", is_default: 0 }
            ];
            mockD1.fetchAll.mockResolvedValue(drives);

            await expect(DriveRepository.getDefaultDrive("user1")).resolves.toEqual(drives[0]);
        });

        it("should set exactly one active default drive for the user", async () => {
            mockD1.fetchOne.mockResolvedValue({ id: "drive1", user_id: "user1", status: "active" });
            mockD1.fetchAll.mockResolvedValue([
                { id: "drive1", user_id: "user1", is_default: 0 },
                { id: "drive2", user_id: "user1", is_default: 1 }
            ]);

            await DriveRepository.setDefaultDrive("user1", "drive1");

            expect(mockD1.fetchOne).toHaveBeenCalledWith(
                "SELECT id, user_id, name, type, config_data, remote_folder, status, is_default, created_at FROM drives WHERE id = ? AND user_id = ? AND status = ?",
                ["drive1", "user1", "active"]
            );
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE drives SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ? WHERE user_id = ? AND status = ?",
                ["drive1", expect.any(Number), "user1", "active"]
            );
            expect(mockCache.delete).toHaveBeenCalledWith("drive:user1");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive1");
            expect(mockCache.delete).toHaveBeenCalledWith("drive_id:drive2");
            expect(mockLocalCache.del).toHaveBeenCalledWith("drive_user1");
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
