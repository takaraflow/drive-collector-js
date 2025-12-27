import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../src/services/d1.js", () => ({
    d1: {
        fetchAll: jest.fn(),
        fetchOne: jest.fn(),
        run: jest.fn(),
    },
}));

jest.unstable_mockModule("../../src/services/logger.js", () => ({
    default: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    },
}));

const { InstanceRepository } = await import("../../src/repositories/InstanceRepository.js");
const { d1 } = await import("../../src/services/d1.js");
const { default: logger } = await import("../../src/services/logger.js");

describe("InstanceRepository", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("createTableIfNotExists", () => {
        it("should create table successfully", async () => {
            d1.run.mockResolvedValue(undefined);

            await InstanceRepository.createTableIfNotExists();

            expect(d1.run).toHaveBeenCalledWith(
                expect.stringContaining("CREATE TABLE IF NOT EXISTS instances")
            );
        });

        it("should handle database errors", async () => {
            d1.run.mockRejectedValue(new Error("DB Error"));

            await InstanceRepository.createTableIfNotExists();

            expect(logger.error).toHaveBeenCalledWith(
                "InstanceRepository.createTableIfNotExists failed:",
                expect.anything()
            );
        });
    });

    describe("upsert", () => {
        it("should insert new instance successfully", async () => {
            d1.run.mockResolvedValue({ success: true });

            const instanceData = {
                id: "instance1",
                hostname: "host1",
                region: "us-east",
                startedAt: Date.now(),
                lastHeartbeat: Date.now(),
                status: "active"
            };

            const result = await InstanceRepository.upsert(instanceData);

            expect(result).toBe(true);
            expect(d1.run).toHaveBeenCalledWith(
                expect.stringContaining("INSERT INTO instances"),
                expect.arrayContaining([
                    "instance1",
                    "host1",
                    "us-east",
                    instanceData.startedAt,
                    instanceData.lastHeartbeat,
                    "active",
                    expect.any(Number), // created_at
                    expect.any(Number)  // updated_at
                ])
            );
        });

        it("should use default values for missing fields", async () => {
            d1.run.mockResolvedValue({ success: true });

            const instanceData = {
                id: "instance1",
                startedAt: Date.now(),
                lastHeartbeat: Date.now()
            };

            await InstanceRepository.upsert(instanceData);

            expect(d1.run).toHaveBeenCalledWith(
                expect.stringContaining("INSERT INTO instances"),
                expect.arrayContaining([
                    "instance1",
                    "unknown", // default hostname
                    "unknown", // default region
                    instanceData.startedAt,
                    instanceData.lastHeartbeat,
                    "active", // default status
                    expect.any(Number),
                    expect.any(Number)
                ])
            );
        });

        it("should return false on database error", async () => {
            d1.run.mockRejectedValue(new Error("DB Error"));

            const instanceData = {
                id: "instance1",
                startedAt: Date.now(),
                lastHeartbeat: Date.now()
            };

            const result = await InstanceRepository.upsert(instanceData);

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                "InstanceRepository.upsert failed for instance1:",
                expect.any(Error)
            );
        });
    });

    describe("findAllActive", () => {
        it("should return active instances within timeout", async () => {
            const mockInstances = [
                { id: "instance1", status: "active", last_heartbeat: Date.now() },
                { id: "instance2", status: "active", last_heartbeat: Date.now() }
            ];
            d1.fetchAll.mockResolvedValue(mockInstances);

            const result = await InstanceRepository.findAllActive();

            expect(result).toEqual(mockInstances);
            expect(d1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining("SELECT * FROM instances"),
                expect.arrayContaining([expect.any(Number)])
            );
            const callArgs = d1.fetchAll.mock.calls[0][0];
            expect(callArgs).toContain("last_heartbeat >= ?");
            expect(callArgs).toContain("status = 'active'");
        });

        it("should use custom timeout", async () => {
            d1.fetchAll.mockResolvedValue([]);

            await InstanceRepository.findAllActive(60000); // 1 minute timeout

            expect(d1.fetchAll).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([expect.any(Number)])
            );
        });

        it("should return empty array on database error", async () => {
            d1.fetchAll.mockRejectedValue(new Error("DB Error"));

            const result = await InstanceRepository.findAllActive();

            expect(result).toEqual([]);
            expect(logger.error).toHaveBeenCalledWith(
                "InstanceRepository.findAllActive failed:",
                expect.any(Error)
            );
        });
    });

    describe("findAll", () => {
        it("should return all instances", async () => {
            const mockInstances = [
                { id: "instance1", status: "active" },
                { id: "instance2", status: "offline" }
            ];
            d1.fetchAll.mockResolvedValue(mockInstances);

            const result = await InstanceRepository.findAll();

            expect(result).toEqual(mockInstances);
            expect(d1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining("SELECT * FROM instances")
            );
        });

        it("should return empty array on database error", async () => {
            d1.fetchAll.mockRejectedValue(new Error("DB Error"));

            const result = await InstanceRepository.findAll();

            expect(result).toEqual([]);
            expect(logger.error).toHaveBeenCalledWith(
                "InstanceRepository.findAll failed:",
                expect.any(Error)
            );
        });
    });

    describe("findById", () => {
        it("should return instance by id", async () => {
            const mockInstance = { id: "instance1", hostname: "host1" };
            d1.fetchOne.mockResolvedValue(mockInstance);

            const result = await InstanceRepository.findById("instance1");

            expect(result).toEqual(mockInstance);
            expect(d1.fetchOne).toHaveBeenCalledWith(
                expect.stringContaining("SELECT * FROM instances WHERE id = ?"),
                ["instance1"]
            );
        });

        it("should return null when instance not found", async () => {
            d1.fetchOne.mockResolvedValue(null);

            const result = await InstanceRepository.findById("nonexistent");

            expect(result).toBeNull();
        });

        it("should return null on database error", async () => {
            d1.fetchOne.mockRejectedValue(new Error("DB Error"));

            const result = await InstanceRepository.findById("instance1");

            expect(result).toBeNull();
            expect(logger.error).toHaveBeenCalledWith(
                "InstanceRepository.findById failed for instance1:",
                expect.any(Error)
            );
        });
    });

    describe("updateHeartbeat", () => {
        it("should update heartbeat successfully", async () => {
            d1.run.mockResolvedValue({ success: true });

            const result = await InstanceRepository.updateHeartbeat("instance1");

            expect(result).toBe(true);
            const callArgs = d1.run.mock.calls[0][0];
            expect(callArgs).toContain("UPDATE instances");
            expect(callArgs).toContain("SET last_heartbeat = ?, updated_at = ?");
            expect(callArgs).toContain("WHERE id = ?");
            expect(d1.run).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([
                    expect.any(Number), // heartbeat time
                    expect.any(Number), // updated_at
                    "instance1"
                ])
            );
        });

        it("should use custom heartbeat time", async () => {
            d1.run.mockResolvedValue({ success: true });
            const customTime = Date.now() - 1000;

            await InstanceRepository.updateHeartbeat("instance1", customTime);

            expect(d1.run).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([customTime, expect.any(Number), "instance1"])
            );
        });

        it("should return false on database error", async () => {
            d1.run.mockRejectedValue(new Error("DB Error"));

            const result = await InstanceRepository.updateHeartbeat("instance1");

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                "InstanceRepository.updateHeartbeat failed for instance1:",
                expect.any(Error)
            );
        });
    });

    describe("markOffline", () => {
        it("should mark instance as offline", async () => {
            d1.run.mockResolvedValue({ success: true });

            const result = await InstanceRepository.markOffline("instance1");

            expect(result).toBe(true);
            const callArgs = d1.run.mock.calls[0][0];
            expect(callArgs).toContain("UPDATE instances");
            expect(callArgs).toContain("SET status = 'offline', updated_at = ?");
            expect(callArgs).toContain("WHERE id = ?");
            expect(d1.run).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([
                    expect.any(Number), // updated_at
                    "instance1"
                ])
            );
        });

        it("should return false on database error", async () => {
            d1.run.mockRejectedValue(new Error("DB Error"));

            const result = await InstanceRepository.markOffline("instance1");

            expect(result).toBe(false);
            expect(logger.error).toHaveBeenCalledWith(
                "InstanceRepository.markOffline failed for instance1:",
                expect.any(Error)
            );
        });
    });

    describe("deleteExpired", () => {
        it("should delete expired instances", async () => {
            d1.run.mockResolvedValue({ changes: 5 });

            const result = await InstanceRepository.deleteExpired();

            expect(result).toBe(5);
            const callArgs = d1.run.mock.calls[0][0];
            expect(callArgs).toContain("DELETE FROM instances");
            expect(callArgs).toContain("last_heartbeat < ?");
            expect(callArgs).toContain("status != 'active'");
            expect(callArgs).toContain("updated_at < ?");
            expect(d1.run).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([expect.any(Number), expect.any(Number)])
            );
        });

        it("should use custom timeout", async () => {
            d1.run.mockResolvedValue({ changes: 0 });

            await InstanceRepository.deleteExpired(300000); // 5 minutes

            expect(d1.run).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([expect.any(Number), expect.any(Number)])
            );
        });

        it("should return 0 on database error", async () => {
            d1.run.mockRejectedValue(new Error("DB Error"));

            const result = await InstanceRepository.deleteExpired();

            expect(result).toBe(0);
            expect(logger.error).toHaveBeenCalledWith(
                "InstanceRepository.deleteExpired failed:",
                expect.any(Error)
            );
        });
    });

    describe("getStats", () => {
        it("should return instance statistics", async () => {
            const mockStats = {
                active_count: 3,
                offline_count: 1,
                total_count: 4,
                oldest_heartbeat: Date.now() - 3600000,
                newest_heartbeat: Date.now()
            };
            d1.fetchOne.mockResolvedValue(mockStats);

            const result = await InstanceRepository.getStats();

            expect(result).toEqual({
                activeCount: 3,
                offlineCount: 1,
                totalCount: 4,
                oldestHeartbeat: mockStats.oldest_heartbeat,
                newestHeartbeat: mockStats.newest_heartbeat
            });
            const callArgs = d1.fetchOne.mock.calls[0][0];
            expect(callArgs).toContain("SELECT");
            expect(callArgs).toContain("COUNT(CASE WHEN last_heartbeat >= ?");
            expect(callArgs).toContain("FROM instances");
            expect(d1.fetchOne).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([expect.any(Number)])
            );
        });

        it("should use custom timeout", async () => {
            d1.fetchOne.mockResolvedValue({
                active_count: 0,
                offline_count: 0,
                total_count: 0,
                oldest_heartbeat: null,
                newest_heartbeat: null
            });

            await InstanceRepository.getStats(60000);

            expect(d1.fetchOne).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([expect.any(Number)])
            );
        });

        it("should return default stats on database error", async () => {
            d1.fetchOne.mockRejectedValue(new Error("DB Error"));

            const result = await InstanceRepository.getStats();

            expect(result).toEqual({
                activeCount: 0,
                offlineCount: 0,
                totalCount: 0,
                oldestHeartbeat: null,
                newestHeartbeat: null
            });
            expect(logger.error).toHaveBeenCalledWith(
                "InstanceRepository.getStats failed:",
                expect.any(Error)
            );
        });
    });
});