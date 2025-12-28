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
    invoke: jest.fn().mockResolvedValue(undefined),
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
    TelegramClient: jest.fn().mockImplementation((session, apiId, apiHash, options) => {
        // 模拟构造函数，忽略 session 检查
        return mockClientInstance;
    }),
    Api: {
        messages: {
            GetHistory: jest.fn()
        }
    }
}));

jest.unstable_mockModule("telegram/sessions/index.js", () => ({
    StringSession: jest.fn().mockImplementation((sessionString) => ({
        save: jest.fn().mockReturnValue(sessionString || "mock_session")
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
const flushPromises = async (n = 10) => {
    for (let i = 0; i < n; i++) {
        await new Promise(resolve => jest.requireActual("timers").setImmediate(resolve));
    }
};

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

    beforeEach(async () => {
        jest.setSystemTime(new Date('2025-01-01T00:00:00Z'));
        // ... 清除 mock ...

        // Mock Math.random to return 0 for predictable wait times (5000ms)
        jest.spyOn(Math, 'random').mockReturnValue(0);

        // 清除调用记录
        mockClientInstance.connect.mockClear();
        mockClientInstance.disconnect.mockClear();
        mockClientInstance.getMe.mockClear();

        mockClientInstance.connected = true;

        // 强制设置 getMe 成功状态，确保 lastHeartbeat 在下一次心跳中被更新
        mockClientInstance.getMe.mockResolvedValue({ id: 123 });

        // 显式重启看门狗以对齐时间
        const module = await import("../../src/services/telegram.js");
        module.stopWatchdog();
        module.startWatchdog();

        // 热身：推进一次心跳并等待异步完成
        jest.advanceTimersByTime(60000);
        await flushPromises();

        // 再次清除热身产生的 mock 调用记录
        mockClientInstance.getMe.mockClear();
    });

    afterEach(() => {
        jest.spyOn(Math, 'random').mockRestore();
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
        // 重要：在设置 getMe 失败前，lastHeartbeat 已经被 beforeEach 同步了
        mockClientInstance.getMe.mockRejectedValue(new Error("Network Error"));

        // 模拟连续失败
        // 我们做 8 次以确保稳稳超过 5 分钟阈值
        for(let i=0; i<8; i++) {
             jest.advanceTimersByTime(60001);
             await flushPromises();
             await flushPromises();
             await flushPromises();
             await flushPromises();
             await flushPromises();
        }

        // 再次给一点时间让异步逻辑执行
        await flushPromises();
        await flushPromises();

        expect(mockClientInstance.disconnect).toHaveBeenCalled();

        // 3. 验证重连完成
        jest.advanceTimersByTime(5000);
        await flushPromises();
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
