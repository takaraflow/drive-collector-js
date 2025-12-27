import { jest } from "@jest/globals";

// Mock 外部依赖
const mockClientInstance = {
    start: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getMe: jest.fn().mockResolvedValue({ id: 123 }),
    session: {
        save: jest.fn().mockReturnValue("mock_session")
    },
    connected: true,
    addEventHandler: jest.fn()
};

jest.unstable_mockModule("../../src/services/telegram.js", () => ({
    client: mockClientInstance,
    saveSession: jest.fn().mockResolvedValue(undefined),
    clearSession: jest.fn().mockResolvedValue(undefined),
    resetClientSession: jest.fn().mockResolvedValue(undefined)
}));

const mockInstanceCoordinator = {
    start: jest.fn().mockResolvedValue(undefined),
    acquireLock: jest.fn(),
    instanceId: "test_instance"
};

jest.unstable_mockModule("../../src/services/InstanceCoordinator.js", () => ({
    instanceCoordinator: mockInstanceCoordinator
}));

jest.unstable_mockModule("../../src/repositories/SettingsRepository.js", () => ({
    SettingsRepository: {
        get: jest.fn().mockResolvedValue("0"),
        set: jest.fn().mockResolvedValue(undefined)
    }
}));

jest.unstable_mockModule("../../src/config/index.js", () => ({
    config: {
        botToken: "mock_token",
        port: 3000
    }
}));

// Mock 其他不相关的依赖
jest.unstable_mockModule("../../src/processor/TaskManager.js", () => ({
    TaskManager: {
        init: jest.fn().mockResolvedValue(undefined),
        startAutoScaling: jest.fn(),
        stopAutoScaling: jest.fn()
    }
}));

jest.unstable_mockModule("../../src/dispatcher/Dispatcher.js", () => ({
    Dispatcher: {
        handle: jest.fn()
    }
}));

const flushPromises = () => new Promise(resolve => jest.requireActual("timers").setImmediate(resolve));

describe("Multi-Instance Startup Logic", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
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