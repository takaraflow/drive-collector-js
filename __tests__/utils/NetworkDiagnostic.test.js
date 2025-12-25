import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.unstable_mockModule("../../src/services/telegram.js", () => ({
    client: {
        getMe: jest.fn(),
    },
}));

jest.unstable_mockModule("../../src/services/d1.js", () => ({
    d1: {
        fetchAll: jest.fn(),
    },
}));

jest.unstable_mockModule("../../src/services/kv.js", () => ({
    kv: {
        get: jest.fn(),
    },
}));

jest.unstable_mockModule("../../src/services/rclone.js", () => ({
    CloudTool: {
        validateConfig: jest.fn(),
    },
}));

jest.unstable_mockModule("../../src/repositories/DriveRepository.js", () => ({
    DriveRepository: {
        findAll: jest.fn(),
    },
}));

jest.unstable_mockModule("../../src/config/index.js", () => ({
    config: {
        botToken: "mock_token",
    },
}));

jest.unstable_mockModule("child_process", () => ({
    spawnSync: jest.fn(),
}));

jest.unstable_mockModule("fs", () => ({
    existsSync: jest.fn(),
}));

const { NetworkDiagnostic } = await import("../../src/utils/NetworkDiagnostic.js");
const { client } = await import("../../src/services/telegram.js");
const { d1 } = await import("../../src/services/d1.js");
const { kv } = await import("../../src/services/kv.js");
const { CloudTool } = await import("../../src/services/rclone.js");
const { DriveRepository } = await import("../../src/repositories/DriveRepository.js");
const { config } = await import("../../src/config/index.js");
const { spawnSync } = await import("child_process");
const fs = await import("fs");

describe("NetworkDiagnostic", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("diagnoseAll", () => {
        it("should return diagnostic results for all services", async () => {
            // Mock successful responses for all services
            client.getMe.mockResolvedValue({ id: 123 });
            d1.fetchAll.mockResolvedValue([]);
            kv.get.mockResolvedValue(null);
            spawnSync.mockReturnValue({
                status: 0,
                stdout: "rclone v1.60.0",
                stderr: "",
            });
            fs.existsSync.mockReturnValue(true);
            DriveRepository.findAll.mockResolvedValue([]);
            CloudTool.validateConfig.mockResolvedValue({ success: true });

            const result = await NetworkDiagnostic.diagnoseAll();

            expect(result).toHaveProperty("timestamp");
            expect(result.services).toHaveProperty("telegram");
            expect(result.services).toHaveProperty("telegramBot");
            expect(result.services).toHaveProperty("d1");
            expect(result.services).toHaveProperty("kv");
            expect(result.services).toHaveProperty("rclone");
            expect(result.services).toHaveProperty("cloudStorage");

            expect(client.getMe).toHaveBeenCalled();
            expect(d1.fetchAll).toHaveBeenCalledWith("SELECT 1 as test");
            expect(kv.get).toHaveBeenCalled();
            expect(spawnSync).toHaveBeenCalled();
            expect(DriveRepository.findAll).toHaveBeenCalled();
        }, 15000); // Increase timeout

        it("should handle errors gracefully", async () => {
            // Mock errors for all services
            client.getMe.mockRejectedValue(new Error("Connection failed"));
            d1.fetchAll.mockRejectedValue(new Error("DB error"));
            kv.get.mockRejectedValue(new Error("KV error"));
            spawnSync.mockReturnValue({
                status: 1,
                stderr: "rclone not found",
            });
            fs.existsSync.mockReturnValue(false); // No rclone binary
            DriveRepository.findAll.mockRejectedValue(new Error("Repository error"));

            const result = await NetworkDiagnostic.diagnoseAll();

            expect(result.services.telegram.status).toBe("error");
            expect(result.services.d1.status).toBe("error");
            expect(result.services.kv.status).toBe("error");
            expect(result.services.rclone.status).toBe("error");
            expect(result.services.cloudStorage.status).toBe("error");
        }, 15000); // Increase timeout
    });

    describe("_checkTelegram", () => {
        it("should return success when telegram client responds", async () => {
            client.getMe.mockResolvedValue({ id: 123 });

            const result = await NetworkDiagnostic._checkTelegram();

            expect(result.status).toBe("ok");
            expect(result.message).toContain("正常");
            expect(result.responseTime).toMatch(/\d+ms/);
        });

        it("should return error when telegram client fails", async () => {
            client.getMe.mockRejectedValue(new Error("Connection timeout"));

            const result = await NetworkDiagnostic._checkTelegram();

            expect(result.status).toBe("error");
            expect(result.message).toContain("失败");
            expect(result.responseTime).toMatch(/\d+ms/);
        });
    });

    describe("_checkTelegramBot", () => {
        it("should return warning when bot token is not configured", async () => {
            config.botToken = null;

            const result = await NetworkDiagnostic._checkTelegramBot();

            expect(result.status).toBe("warning");
            expect(result.message).toContain("未配置");
        });

        it("should return success when bot API responds ok", async () => {
            config.botToken = "mock_token";
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                json: jest.fn().mockResolvedValue({
                    ok: true,
                    result: { username: "testbot" }
                })
            });

            const result = await NetworkDiagnostic._checkTelegramBot();

            expect(result.status).toBe("ok");
            expect(result.message).toContain("@testbot");
        });

        it("should return error when bot API fails", async () => {
            config.botToken = "mock_token";
            global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

            const result = await NetworkDiagnostic._checkTelegramBot();

            expect(result.status).toBe("error");
            expect(result.message).toContain("失败");
        });
    });

    describe("_checkD1", () => {
        it("should return success when D1 query succeeds", async () => {
            d1.fetchAll.mockResolvedValue([{ test: 1 }]);

            const result = await NetworkDiagnostic._checkD1();

            expect(result.status).toBe("ok");
            expect(result.message).toContain("正常");
        });

        it("should return error when D1 query fails", async () => {
            d1.fetchAll.mockRejectedValue(new Error("Connection failed"));

            const result = await NetworkDiagnostic._checkD1();

            expect(result.status).toBe("error");
            expect(result.message).toContain("失败");
        });
    });

    describe("_checkKV", () => {
        it("should return success when KV get succeeds", async () => {
            kv.get.mockResolvedValue(null);

            const result = await NetworkDiagnostic._checkKV();

            expect(result.status).toBe("ok");
            expect(result.message).toContain("正常");
        });

        it("should return error when KV get fails", async () => {
            kv.get.mockRejectedValue(new Error("KV error"));

            const result = await NetworkDiagnostic._checkKV();

            expect(result.status).toBe("error");
            expect(result.message).toContain("失败");
        });
    });

    describe("_checkRclone", () => {
        it("should return success when rclone version check succeeds", () => {
            fs.existsSync.mockReturnValue(true);
            spawnSync.mockReturnValue({
                status: 0,
                stdout: "rclone v1.60.0",
                stderr: "",
            });

            const result = NetworkDiagnostic._checkRclone();

            expect(result.status).toBe("ok");
            expect(result.message).toContain("正常");
            expect(result.message).toContain("1.60.0");
        });

        it("should return error when rclone version check fails", () => {
            fs.existsSync.mockReturnValue(true);
            spawnSync.mockReturnValue({
                status: 1,
                stderr: "command not found",
            });

            const result = NetworkDiagnostic._checkRclone();

            expect(result.status).toBe("error");
            expect(result.message).toContain("错误");
        });

        it("should check alternative rclone path when default not found", () => {
            fs.existsSync.mockReturnValue(false);
            spawnSync.mockReturnValue({
                status: 0,
                stdout: "rclone v1.60.0",
            });

            NetworkDiagnostic._checkRclone();

            expect(spawnSync).toHaveBeenCalledWith("rclone", ["version"], expect.any(Object));
        });
    });

    describe("_checkCloudStorage", () => {
        it("should return warning when no drives configured", async () => {
            DriveRepository.findAll.mockResolvedValue([]);

            const result = await NetworkDiagnostic._checkCloudStorage();

            expect(result.status).toBe("warning");
            expect(result.message).toContain("未找到");
        });

        it("should return success when drive validation succeeds", async () => {
            const mockDrive = {
                id: 1,
                type: "mega",
                config_data: JSON.stringify({ user: "test" })
            };
            DriveRepository.findAll.mockResolvedValue([mockDrive]);
            CloudTool.validateConfig.mockResolvedValue({ success: true });

            const result = await NetworkDiagnostic._checkCloudStorage();

            expect(result.status).toBe("ok");
            expect(result.message).toContain("MEGA");
            expect(result.message).toContain("正常");
        });

        it("should return error when drive validation fails", async () => {
            const mockDrive = {
                id: 1,
                type: "mega",
                config_data: JSON.stringify({ user: "test" })
            };
            DriveRepository.findAll.mockResolvedValue([mockDrive]);
            CloudTool.validateConfig.mockResolvedValue({
                success: false,
                reason: "Invalid credentials"
            });

            const result = await NetworkDiagnostic._checkCloudStorage();

            expect(result.status).toBe("error");
            expect(result.message).toContain("MEGA");
            expect(result.message).toContain("失败");
        });

        it("should handle repository errors", async () => {
            DriveRepository.findAll.mockRejectedValue(new Error("DB error"));

            const result = await NetworkDiagnostic._checkCloudStorage();

            expect(result.status).toBe("error");
            expect(result.message).toContain("失败");
        });
    });

    describe("formatResults", () => {
        it("should format results with all services ok", () => {
            const results = {
                timestamp: "2025-01-01T00:00:00.000Z",
                services: {
                    telegram: { status: "ok", message: "OK", responseTime: "100ms" },
                    telegramBot: { status: "ok", message: "OK", responseTime: "200ms" },
                    d1: { status: "ok", message: "OK", responseTime: "50ms" },
                    kv: { status: "ok", message: "OK", responseTime: "30ms" },
                    rclone: { status: "ok", message: "OK", responseTime: "150ms" },
                    cloudStorage: { status: "ok", message: "OK", responseTime: "300ms" }
                }
            };

            const formatted = NetworkDiagnostic.formatResults(results);

            expect(formatted).toContain("🔍");
            expect(formatted).toContain("✅");
            expect(formatted).toContain("所有服务运行正常");
        });

        it("should format results with some errors", () => {
            const results = {
                timestamp: "2025-01-01T00:00:00.000Z",
                services: {
                    telegram: { status: "ok", message: "OK", responseTime: "100ms" },
                    telegramBot: { status: "error", message: "Failed", responseTime: "200ms" },
                    d1: { status: "error", message: "DB error", responseTime: "50ms" },
                    kv: { status: "ok", message: "OK", responseTime: "30ms" },
                    rclone: { status: "ok", message: "OK", responseTime: "150ms" },
                    cloudStorage: { status: "ok", message: "OK", responseTime: "300ms" }
                }
            };

            const formatted = NetworkDiagnostic.formatResults(results);

            expect(formatted).toContain("❌");
            expect(formatted).toContain("⚠️ 发现 2 个服务异常");
        });
    });
});