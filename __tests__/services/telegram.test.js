import { jest } from "@jest/globals";

// 全局变量用于存储捕获的回调函数
let capturedErrorCallback = null;

// 1. 定义 Mock 实例
const mockClientInstance = {
    // 自定义 on 方法实现，用于捕获回调
    on: jest.fn((event, callback) => {
        if (event === 'error') {
            capturedErrorCallback = callback;
        }
    }),
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getMe: jest.fn().mockResolvedValue({ id: 123 }),
    session: {
        save: jest.fn().mockReturnValue("mock_session")
    },
    connected: true,
    _sender: {
        disconnect: jest.fn().mockResolvedValue(undefined)
    }
};

// 2. Mock 外部依赖
jest.unstable_mockModule("telegram", () => ({
    TelegramClient: jest.fn().mockImplementation(() => mockClientInstance),
    Api: {
        messages: {
            GetHistory: jest.fn()
        }
    }
}));

jest.unstable_mockModule("telegram/sessions/index.js", () => ({
    StringSession: jest.fn().mockImplementation(() => ({
        save: jest.fn().mockReturnValue("mock_session")
    }))
}));

jest.unstable_mockModule("../../src/config/index.js", () => ({
    config: {
        apiId: 123,
        apiHash: "mock_hash",
        botToken: "mock_token"
    }
}));

jest.unstable_mockModule("../../src/repositories/SettingsRepository.js", () => ({
    SettingsRepository: {
        get: jest.fn().mockResolvedValue(""),
        set: jest.fn().mockResolvedValue(undefined)
    }
}));

// 辅助函数：等待微任务队列清空
const flushPromises = () => new Promise(resolve => jest.requireActual("timers").setImmediate(resolve));

describe("Telegram Service Watchdog", () => {
    let client;

    beforeAll(async () => {
        // 在导入模块之前启用 Fake Timers
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));

        // 动态导入被测模块
        const module = await import("../../src/services/telegram.js");
        client = module.client;
    });

    beforeEach(() => {
        // 重置系统时间
        jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
        
        // 清除调用记录
        mockClientInstance.connect.mockClear();
        mockClientInstance.disconnect.mockClear();
        mockClientInstance.getMe.mockClear();
        
        mockClientInstance.connected = true;
    });

    afterAll(async () => {
        jest.useRealTimers();
        // Clean up timers
        const module = await import("../../src/services/telegram.js");
        if (module.stopWatchdog) {
            module.stopWatchdog();
        }
    });

    test("应当注册 'error' 事件监听器", () => {
        expect(capturedErrorCallback).toBeDefined();
        expect(typeof capturedErrorCallback).toBe('function');
    });

    test("应当在检测到 TIMEOUT 错误时触发重连", async () => {
        expect(capturedErrorCallback).toBeDefined();

        await capturedErrorCallback(new Error("TIMEOUT"));

        // 现在的逻辑是 setTimeout 2秒后再触发断开
        jest.advanceTimersByTime(2001);
        await flushPromises();

        expect(mockClientInstance.disconnect).toHaveBeenCalled();

        // 由于使用了随机等待时间（5-10秒），我们需要等待更长时间
        jest.advanceTimersByTime(15000);
        await flushPromises();

        expect(mockClientInstance.connect).toHaveBeenCalled();
    });

    test("应当在检测到 Not connected 错误时触发重连", async () => {
        expect(capturedErrorCallback).toBeDefined();

        // 对于 "Not connected" 错误，直接调用 handleConnectionIssue（无 setTimeout）
        await capturedErrorCallback(new Error("RPCError: ... Not connected ..."));

        // 等待 disconnect 的异步操作完成
        await flushPromises();

        expect(mockClientInstance.disconnect).toHaveBeenCalled();

        // 由于使用了随机等待时间（5-10秒），我们需要等待更长时间
        jest.advanceTimersByTime(15000);
        await flushPromises();

        expect(mockClientInstance.connect).toHaveBeenCalled();
    });

    test("应当在心跳连续失败（5分钟）时触发强制重连", async () => {
        mockClientInstance.getMe.mockRejectedValue(new Error("Network Error"));

        // 模拟时间流逝
        for(let i=0; i<6; i++) {
             jest.advanceTimersByTime(60 * 1000);
             await flushPromises();
        }

        // 验证由于心跳超时，调用了 disconnect
        expect(mockClientInstance.disconnect).toHaveBeenCalled();

        // 关键修复：确保重连逻辑（包括随机等待时间）执行完毕，释放 isReconnecting 锁
        jest.advanceTimersByTime(15000);
        await flushPromises();
        expect(mockClientInstance.connect).toHaveBeenCalled();
    });

    test("正在重连时应当防止并发调用 (isReconnecting 锁)", async () => {
        expect(capturedErrorCallback).toBeDefined();

        const p1 = capturedErrorCallback(new Error("TIMEOUT"));
        const p2 = capturedErrorCallback(new Error("TIMEOUT"));

        // 触发 setTimeout 内部的 handleConnectionIssue
        jest.advanceTimersByTime(2001);

        await Promise.all([p1, p2]);
        await flushPromises();

        // disconnect 应该只被调用一次
        expect(mockClientInstance.disconnect).toHaveBeenCalledTimes(1);

        // 善后：完成重连流程（随机等待时间）
        jest.advanceTimersByTime(15000);
        await flushPromises();
    });

    test("应当在重连时强制清理底层连接器状态", async () => {
        expect(capturedErrorCallback).toBeDefined();

        await capturedErrorCallback(new Error("TIMEOUT"));

        jest.advanceTimersByTime(2001);
        await flushPromises();

        expect(mockClientInstance.disconnect).toHaveBeenCalled();
        expect(mockClientInstance._sender.disconnect).toHaveBeenCalled();

        // 随机等待时间
        jest.advanceTimersByTime(15000);
        await flushPromises();

        expect(mockClientInstance.connect).toHaveBeenCalled();
    });

    test("应当处理 disconnect() 超时情况", async () => {
        expect(capturedErrorCallback).toBeDefined();

        // 模拟 disconnect() 永不返回的情况
        mockClientInstance.disconnect.mockImplementation(() => new Promise(() => {}));

        await capturedErrorCallback(new Error("TIMEOUT"));

        jest.advanceTimersByTime(2001);
        await flushPromises();

        // 等待 Promise.race 的超时（5秒）
        jest.advanceTimersByTime(5001);
        await flushPromises();

        // 现在 _sender.disconnect 应该被调用
        expect(mockClientInstance._sender.disconnect).toHaveBeenCalled();

        // 等待随机延迟时间
        jest.advanceTimersByTime(15000);
        await flushPromises();

        expect(mockClientInstance.connect).toHaveBeenCalled();
    });
});