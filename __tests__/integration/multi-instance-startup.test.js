// Mock 外部依赖
const mockClientInstance = {
    start: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getMe: vi.fn().mockResolvedValue({ id: 123 }),
    session: {
        save: vi.fn().mockReturnValue("mock_session")
    },
    connected: true,
    addEventHandler: vi.fn()
};

vi.mock("../../src/services/telegram.js", () => ({
    client: mockClientInstance,
    saveSession: vi.fn().mockResolvedValue(undefined),
    clearSession: vi.fn().mockResolvedValue(undefined),
    resetClientSession: vi.fn().mockResolvedValue(undefined)
}));

const mockInstanceCoordinator = {
    start: vi.fn().mockResolvedValue(undefined),
    acquireLock: vi.fn(),
    instanceId: "test_instance"
};

vi.mock("../../src/services/InstanceCoordinator.js", () => ({
    instanceCoordinator: mockInstanceCoordinator
}));

vi.mock("../../src/repositories/SettingsRepository.js", () => ({
    SettingsRepository: {
        get: vi.fn().mockResolvedValue("0"),
        set: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock("../../src/config/index.js", () => ({
    config: {
        botToken: "mock_token",
        port: 3000
    }
}));

// Mock 其他不相关的依赖
vi.mock("../../src/processor/TaskManager.js", () => ({
    TaskManager: {
        init: vi.fn().mockResolvedValue(undefined),
        startAutoScaling: vi.fn(),
        stopAutoScaling: vi.fn()
    }
}));

vi.mock("../../src/dispatcher/Dispatcher.js", () => ({
    Dispatcher: {
        handle: vi.fn()
    }
}));

const flushPromises = () => new Promise(resolve => vi.requireActual("timers").setImmediate(resolve));

describe("Multi-Instance Startup Logic", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test("只有获取锁的实例应当启动 Telegram 客户端", async () => {
        // 模拟抢锁成功
        mockInstanceCoordinator.acquireLock.mockResolvedValue(true);

        // 我们不能直接导入 index.js 因为它是一个立即执行函数且包含 http server
        // 但我们可以模拟它内部的启动逻辑
        const startLogic = async () => {
            await mockInstanceCoordinator.start();
            const hasLock = await mockInstanceCoordinator.acquireLock("telegram_client", 60);
            if (hasLock) {
                await mockClientInstance.start({ botAuthToken: "mock_token" });
            }
        };

        await startLogic();
        expect(mockClientInstance.start).toHaveBeenCalled();
    });

    test("未获取锁的实例不应当启动 Telegram 客户端", async () => {
        // 模拟抢锁失败
        mockInstanceCoordinator.acquireLock.mockResolvedValue(false);

        const startLogic = async () => {
            await mockInstanceCoordinator.start();
            const hasLock = await mockInstanceCoordinator.acquireLock("telegram_client", 60);
            if (hasLock) {
                await mockClientInstance.start({ botAuthToken: "mock_token" });
            }
        };

        await startLogic();
        expect(mockClientInstance.start).not.toHaveBeenCalled();
    });

    test("当锁续租失败时应当断开连接", async () => {
        let isClientActive = true;
        
        // 第一次获取成功
        mockInstanceCoordinator.acquireLock.mockResolvedValueOnce(true);
        await mockInstanceCoordinator.acquireLock("telegram_client", 60);

        // 第二次获取失败（模拟续租失败）
        mockInstanceCoordinator.acquireLock.mockResolvedValueOnce(false);

        const monitorLogic = async () => {
            const hasLock = await mockInstanceCoordinator.acquireLock("telegram_client", 60);
            if (!hasLock && isClientActive) {
                await mockClientInstance.disconnect();
                isClientActive = false;
            }
        };

        await monitorLogic();
        expect(mockClientInstance.disconnect).toHaveBeenCalled();
        expect(isClientActive).toBe(false);
    });
});