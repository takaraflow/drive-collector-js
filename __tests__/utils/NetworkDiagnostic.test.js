vi.mock("../../src/services/telegram.js", () => ({
    client: {
        getMe: vi.fn(),
    },
    getUpdateHealth: vi.fn(() => ({
        lastUpdate: Date.now() - 30000,
        timeSince: 30000
    })),
}));

vi.mock("../../src/services/d1.js", () => ({
    d1: {
        fetchAll: vi.fn(),
    },
}));

const mockCache = {
    get: vi.fn(),
    getCurrentProvider: vi.fn().mockReturnValue("Cloudflare KV"),
};

vi.mock("../../src/services/CacheService.js", () => ({
    cache: mockCache,
}));

const mockTunnelService = {
    getStatus: vi.fn(),
    getPublicUrl: vi.fn(),
};

vi.mock("../../src/services/TunnelService.js", () => ({
    tunnelService: mockTunnelService,
}));

const mockConfig = {
    botToken: "mock_token",
    telegram: {
        testMode: false
    },
    tunnel: {
        enabled: false
    }
};
vi.mock("../../src/config/index.js", () => ({
    config: mockConfig,
    getConfig: () => mockConfig,
    validateConfig: () => true
}));

vi.mock("child_process", () => ({
    spawnSync: vi.fn(),
}));

vi.mock("fs", () => ({
    existsSync: vi.fn(),
}));

const { NetworkDiagnostic } = await import("../../src/utils/NetworkDiagnostic.js");
const { client } = await import("../../src/services/telegram.js");
const { d1 } = await import("../../src/services/d1.js");
const { cache } = await import("../../src/services/CacheService.js");
const { config } = await import("../../src/config/index.js");
const { spawnSync } = await import("child_process");
const fs = await import("fs");

describe("NetworkDiagnostic", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Mock fetch globally for all tests to prevent real network calls
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ ok: true, result: { username: "mockbot" } })
        });
    });

    describe("diagnoseAll", () => {
        it("should return diagnostic results for all services", async () => {
            // Mock successful responses for all services
            client.getMe.mockResolvedValue({ id: 123 });
            d1.fetchAll.mockResolvedValue([]);
            mockCache.get.mockResolvedValue(null);
            spawnSync.mockReturnValue({
                status: 0,
                stdout: "rclone v1.60.0",
                stderr: "",
            });
            fs.existsSync.mockReturnValue(true);

            const result = await NetworkDiagnostic.diagnoseAll();

            expect(result).toHaveProperty("timestamp");
            expect(result.services).toHaveProperty("telegram");
            expect(result.services).toHaveProperty("telegramBot");
            expect(result.services).toHaveProperty("d1");
            expect(result.services).toHaveProperty("kv");
            expect(result.services).toHaveProperty("rclone");

            expect(client.getMe).toHaveBeenCalled();
            expect(d1.fetchAll).toHaveBeenCalledWith("SELECT 1 as test");
            expect(mockCache.get).toHaveBeenCalled();
            expect(spawnSync).toHaveBeenCalled();
        });

        it("should handle errors gracefully", async () => {
            // Mock errors for all services
            client.getMe.mockRejectedValue(new Error("Connection failed"));
            d1.fetchAll.mockRejectedValue(new Error("DB error"));
            mockCache.get.mockRejectedValue(new Error("KV error"));
            spawnSync.mockReturnValue({
                status: 1,
                stderr: "rclone not found",
            });
            fs.existsSync.mockReturnValue(false); // No rclone binary
            // Mock fetch error for bot API
            global.fetch.mockRejectedValue(new Error("Bot API error"));

            const result = await NetworkDiagnostic.diagnoseAll();

            expect(result.services.telegram.status).toBe("error");
            expect(result.services.d1.status).toBe("error");
            expect(result.services.kv.status).toBe("error");
            expect(result.services.rclone.status).toBe("error");
            expect(result.services.telegramBot.status).toBe("error");
        });
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
            const result = await NetworkDiagnostic._checkTelegramBot();

            expect(result.status).toBe("ok");
            expect(result.message).toContain("@mockbot");
        });

        it("should return error when bot API fails", async () => {
            config.botToken = "mock_token";
            global.fetch.mockRejectedValueOnce(new Error("Network error"));

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

    describe("_checkCache", () => {
        it("should return success when KV get succeeds", async () => {
            mockCache.get.mockResolvedValue(null);

            const result = await NetworkDiagnostic._checkCache();

            expect(result.status).toBe("ok");
            expect(result.message).toContain("正常");
        });

        it("should return error when KV get fails", async () => {
            mockCache.get.mockRejectedValue(new Error("KV error"));

            const result = await NetworkDiagnostic._checkCache();

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

    describe("_checkUpdateLoopHealth", () => {
        it("should return ok when update loop is healthy", async () => {
            const mockGetUpdateHealth = await import("../../src/services/telegram.js").then(m => m.getUpdateHealth);
            mockGetUpdateHealth.mockReturnValue({
                lastUpdate: Date.now() - 30000,
                timeSince: 30000
            });

            const result = await NetworkDiagnostic._checkUpdateLoopHealth();

            expect(result.status).toBe("ok");
            expect(result.message).toContain("更新循环正常");
            expect(result.details.timeSinceSeconds).toBe(30);
        });

        it("should return warning when update loop is slow", async () => {
            const mockGetUpdateHealth = await import("../../src/services/telegram.js").then(m => m.getUpdateHealth);
            mockGetUpdateHealth.mockReturnValue({
                lastUpdate: Date.now() - 95000,
                timeSince: 95000
            });

            const result = await NetworkDiagnostic._checkUpdateLoopHealth();

            expect(result.status).toBe("warning");
            expect(result.message).toContain("可能卡住");
            expect(result.details.timeSinceSeconds).toBe(95);
        });

        it("should return error when getUpdateHealth throws", async () => {
            const mockGetUpdateHealth = await import("../../src/services/telegram.js").then(m => m.getUpdateHealth);
            mockGetUpdateHealth.mockImplementation(() => {
                throw new Error("Health check failed");
            });

            const result = await NetworkDiagnostic._checkUpdateLoopHealth();

            expect(result.status).toBe("error");
            expect(result.message).toContain("无法检查");
        });
    });

    describe("_checkTunnel", () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it("should return warning when tunnel is not enabled in config", async () => {
            mockConfig.tunnel = { enabled: false };

            const result = await NetworkDiagnostic._checkTunnel();

            expect(result.status).toBe("warning");
            expect(result.message).toContain("未启用");
        });

        it("should return warning when tunnel is enabled but not initialized", async () => {
            mockConfig.tunnel = { enabled: true };
            mockTunnelService.getStatus.mockReturnValue({ enabled: false });

            const result = await NetworkDiagnostic._checkTunnel();

            expect(result.status).toBe("warning");
            expect(result.message).toContain("未初始化");
        });

        it("should return ok when tunnel is running and has public URL", async () => {
            mockConfig.tunnel = { enabled: true, provider: 'cloudflare' };
            mockTunnelService.getStatus.mockReturnValue({
                enabled: true,
                serviceUp: true,
                lastUpdate: new Date().toISOString()
            });
            mockTunnelService.getPublicUrl.mockResolvedValue("https://tunnel-url.trycloudflare.com");

            const result = await NetworkDiagnostic._checkTunnel();

            expect(result.status).toBe("ok");
            expect(result.message).toContain("正常");
            expect(result.message).toContain("tunnel-url.trycloudflare.com");
            expect(result.details.url).toBe("https://tunnel-url.trycloudflare.com");
        });

        it("should return warning when tunnel is running but no public URL", async () => {
            mockConfig.tunnel = { enabled: true, provider: 'cloudflare' };
            mockTunnelService.getStatus.mockReturnValue({
                enabled: true,
                serviceUp: true,
                lastUpdate: new Date().toISOString()
            });
            mockTunnelService.getPublicUrl.mockResolvedValue(null);

            const result = await NetworkDiagnostic._checkTunnel();

            expect(result.status).toBe("warning");
            expect(result.message).toContain("运行中但未获取到公网 URL");
        });

        it("should return error when tunnel check throws exception", async () => {
            mockConfig.tunnel = { enabled: true };
            mockTunnelService.getStatus.mockImplementation(() => {
                throw new Error("Tunnel service error");
            });

            const result = await NetworkDiagnostic._checkTunnel();

            expect(result.status).toBe("error");
            expect(result.message).toContain("检查失败");
        });
    });

});
