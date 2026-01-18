// Mock the global fetch function
const mockFetch = vi.fn();
global.fetch = mockFetch;



describe("Telegram Startup Protection and Re-entrance Prevention", () => {
    // Remove vi.setTimeout - use fake timers instead
    let mockClient;
    let mockCoordinator;
    let mockSettingsRepository;

    beforeEach(async () => {
        vi.useFakeTimers();

        // Mock Telegram client
        mockClient = {
            start: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn().mockResolvedValue(undefined),
            connected: false
        };

        // Mock coordinator
        mockCoordinator = {
            acquireLock: vi.fn().mockResolvedValue(true),
            instanceId: "test_instance"
        };

        // Mock settings repository
        mockSettingsRepository = {
            get: vi.fn().mockResolvedValue(""),
            set: vi.fn().mockResolvedValue(undefined)
        };

        // Mock global modules
        vi.doMock("../../src/services/telegram.js", () => ({
            client: mockClient,
            saveSession: vi.fn().mockResolvedValue(undefined),
            clearSession: vi.fn().mockResolvedValue(undefined),
            resetClientSession: vi.fn().mockResolvedValue(undefined),
            setConnectionStatusCallback: vi.fn()
        }));

        vi.doMock("../../src/services/InstanceCoordinator.js", () => ({
            instanceCoordinator: mockCoordinator
        }));

        vi.doMock("../../src/repositories/SettingsRepository.js", () => ({
            SettingsRepository: mockSettingsRepository
        }));


    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
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
                return false;
            }

            // 尝试获取 Telegram 客户端专属锁
            const hasLock = await mockCoordinator.acquireLock("telegram_client", 90, { maxAttempts: 5 });
            if (!hasLock) {
                if (isClientActive) {
                    await mockClient.disconnect();
                    isClientActive = false;
                }
                return false;
            }

            if (isClientActive) return true; // 已启动且持有锁

            isClientStarting = true; // 标记开始启动

            try {
                await mockClient.start({ botAuthToken: "test_token" });
                await mockSettingsRepository.set("tg_bot_session", "session_data");
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

        return {
            startTelegramClient,
            getClientState: () => ({ isClientActive, isClientStarting }),
            setClientState: (active, starting) => {
                isClientActive = active;
                isClientStarting = starting;
            }
        };
    }

    test("should prevent concurrent startup attempts", async () => {
        // 使用一个受控的 Promise 来模拟慢速启动
        let resolveStart;
        const startPromise = new Promise(resolve => { resolveStart = resolve; });
        mockClient.start.mockReturnValue(startPromise);

        const { startTelegramClient, getClientState } = await simulateFixedStartTelegramClient();

        // 第一次调用开始启动
        const promise1 = startTelegramClient();

        // 确保第一次调用已经运行到第一个 await (acquireLock) 之后
        // 在 Fake Timers 模式下，微任务需要手动 flush
        await Promise.resolve();

        // 立即第二次调用
        const promise2 = startTelegramClient();

        // 第二次调用应该立即返回 false，因为它检测到 isClientStarting 为 true
        const result2 = await promise2;
        expect(result2).toBe(false);
        expect(getClientState().isClientStarting).toBe(true);

        // 完成第一次启动
        resolveStart();

        // 刷新所有 Promise 和 Timer
        await Promise.resolve();
        await Promise.resolve(); // 多次 flush 确保 finally 执行

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
        expect(mockCoordinator.acquireLock).toHaveBeenCalledWith("telegram_client", 90, expect.objectContaining({ maxAttempts: 5 }));
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
        const { startTelegramClient, getClientState, setClientState } = await simulateFixedStartTelegramClient();

        // 手动设置已启动状态
        setClientState(true, false);

        const result = await startTelegramClient();

        expect(result).toBe(true);
        expect(mockClient.start).not.toHaveBeenCalled();
        expect(mockCoordinator.acquireLock).toHaveBeenCalled();
    });

    test("should disconnect when lock is lost and client is active", async () => {
        mockCoordinator.acquireLock.mockResolvedValue(false);

        const { startTelegramClient, getClientState, setClientState } = await simulateFixedStartTelegramClient();

        // 手动设置已启动状态
        setClientState(true, false);

        const result = await startTelegramClient();

        expect(result).toBe(false);
        expect(getClientState().isClientActive).toBe(false);
        expect(mockClient.disconnect).toHaveBeenCalled();
    });
});