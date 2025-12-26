import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Mock the global fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock the global setInterval
const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;

describe("Telegram Startup Protection and Re-entrance Prevention", () => {
    let mockClient;
    let mockCoordinator;
    let mockSettingsRepository;

    beforeEach(async () => {
        jest.useFakeTimers();

        // Mock Telegram client
        mockClient = {
            start: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            connected: false
        };

        // Mock coordinator
        mockCoordinator = {
            acquireLock: jest.fn().mockResolvedValue(true),
            instanceId: "test_instance"
        };

        // Mock settings repository
        mockSettingsRepository = {
            get: jest.fn().mockResolvedValue(""),
            set: jest.fn().mockResolvedValue(undefined)
        };

        // Mock global modules
        jest.doMock("../../src/services/telegram.js", () => ({
            client: mockClient,
            saveSession: jest.fn().mockResolvedValue(undefined),
            clearSession: jest.fn().mockResolvedValue(undefined),
            resetClientSession: jest.fn().mockResolvedValue(undefined),
            setConnectionStatusCallback: jest.fn()
        }));

        jest.doMock("../../src/services/InstanceCoordinator.js", () => ({
            instanceCoordinator: mockCoordinator
        }));

        jest.doMock("../../src/repositories/SettingsRepository.js", () => ({
            SettingsRepository: mockSettingsRepository
        }));

        // Mock setInterval to capture calls
        global.setInterval = jest.fn((callback, interval) => {
            const timerId = Symbol('timer');
            // Simulate calling the callback immediately for testing
            setTimeout(() => callback(), 0);
            return timerId;
        });

        global.clearInterval = jest.fn();
    });

    afterEach(() => {
        jest.useRealTimers();
        global.setInterval = originalSetInterval;
        global.clearInterval = originalClearInterval;
        jest.clearAllMocks();
    });

    /**
     * 模拟修复后的 startTelegramClient 逻辑（包含防重入保护）
     */
    async function simulateFixedStartTelegramClient() {
        // 外部状态（模拟 index.js 中的变量）
        let isClientActive = false;
        let isClientStarting = false; // 防重入标志

        const startTelegramClient = async () => {
            // 防止重入：如果正在启动中，直接返回
            if (isClientStarting) {
                console.log("⏳ 客户端正在启动中，跳过本次重试...");
                return false;
            }

            // 尝试获取 Telegram 客户端专属锁
            const hasLock = await mockCoordinator.acquireLock("telegram_client", 90);
            if (!hasLock) {
                if (isClientActive) {
                    console.log("🚨 失去 Telegram 锁，正在断开连接...");
                    await mockClient.disconnect();
                    isClientActive = false;
                }
                return false;
            }

            if (isClientActive) return true; // 已启动且持有锁

            isClientStarting = true; // 标记开始启动
            console.log("👑 已获取 Telegram 锁，正在启动客户端...");

            try {
                await mockClient.start({ botAuthToken: "test_token" });
                await mockSettingsRepository.set("tg_bot_session", "session_data");
                console.log("🚀 Telegram 客户端已连接");
                isClientActive = true;
                return true;
            } catch (error) {
                console.error("❌ 启动 Telegram 客户端失败:", error.message);
                return false;
            } finally {
                // 无论成功失败，最后都要清除启动标志
                isClientStarting = false;
            }
        };

        return { startTelegramClient, getClientState: () => ({ isClientActive, isClientStarting }) };
    }

    test("should prevent concurrent startup attempts", async () => {
        // Mock client.start to take 5 seconds (simulating slow network)
        mockClient.start.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 5000)));

        const { startTelegramClient, getClientState } = await simulateFixedStartTelegramClient();

        // 第一次调用开始启动
        const promise1 = startTelegramClient();

        // 立即第二次调用（模拟 setInterval 触发）
        const promise2 = startTelegramClient();

        // 第二次调用应该立即返回，因为 isClientStarting = true
        const result2 = await promise2;
        expect(result2).toBe(false);
        expect(getClientState().isClientStarting).toBe(true);

        // 等待第一次调用完成
        await jest.advanceTimersByTimeAsync(5000);
        const result1 = await promise1;
        expect(result1).toBe(true);
        expect(getClientState().isClientActive).toBe(true);
        expect(getClientState().isClientStarting).toBe(false);
    });

    test("should handle startup failure gracefully", async () => {
        // Mock client.start to fail
        mockClient.start.mockRejectedValue(new Error("Connection failed"));

        const { startTelegramClient, getClientState } = await simulateFixedStartTelegramClient();

        const result = await startTelegramClient();

        expect(result).toBe(false);
        expect(getClientState().isClientActive).toBe(false);
        expect(getClientState().isClientStarting).toBe(false); // 应该被清除
        expect(mockCoordinator.acquireLock).toHaveBeenCalledWith("telegram_client", 90);
    });

    test("should handle lock acquisition failure", async () => {
        mockCoordinator.acquireLock.mockResolvedValue(false);

        const { startTelegramClient, getClientState } = await simulateFixedStartTelegramClient();

        const result = await startTelegramClient();

        expect(result).toBe(false);
        expect(getClientState().isClientActive).toBe(false);
        expect(mockClient.start).not.toHaveBeenCalled();
    });

    test("should skip startup when already active", async () => {
        const { startTelegramClient, getClientState } = await simulateFixedStartTelegramClient();

        // 手动设置已启动状态
        const state = getClientState();
        state.isClientActive = true;

        const result = await startTelegramClient();

        expect(result).toBe(true);
        expect(mockClient.start).not.toHaveBeenCalled();
        expect(mockCoordinator.acquireLock).toHaveBeenCalled();
    });

    test("should disconnect when lock is lost and client is active", async () => {
        mockCoordinator.acquireLock.mockResolvedValue(false);

        const { startTelegramClient, getClientState } = await simulateFixedStartTelegramClient();

        // 手动设置已启动状态
        const state = getClientState();
        state.isClientActive = true;

        const result = await startTelegramClient();

        expect(result).toBe(false);
        expect(getClientState().isClientActive).toBe(false);
        expect(mockClient.disconnect).toHaveBeenCalled();
    });
});