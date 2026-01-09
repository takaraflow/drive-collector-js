import { jest, describe, test, expect, beforeAll, afterAll, afterEach } from "@jest/globals";

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

const originalEnv = process.env;
let instanceCoordinator;
let mockLogger; 

const mockCache = {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
    isFailoverMode: true,
    getCurrentProvider: jest.fn().mockReturnValue("Cloudflare KV"),
};

describe("InstanceCoordinator Heartbeat (KV Only)", () => {
    beforeAll(async () => {
        // 强制使用真实定时器，防止 setTimeout 挂起
        jest.useRealTimers();

        process.env = {
            ...originalEnv,
            CF_ACCOUNT_ID: "mock_account_id",
            CF_KV_NAMESPACE_ID: "mock_namespace_id",
            CF_KV_TOKEN: "mock_kv_token",
            INSTANCE_ID: "test_instance_heartbeat",
            HOSTNAME: "unknown",
        };

        // Mock Logger
        mockLogger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
        };

        /**
         * 【核心修复】：补全命名导出 setInstanceIdProvider
         * InstanceCoordinator.js 内部 import { setInstanceIdProvider } from "./logger.js"
         * 如果不 Mock 这个命名导出，动态 import 时会报 SyntaxError
         */
        jest.unstable_mockModule("../../src/services/logger.js", () => ({
            default: mockLogger,
            logger: mockLogger,
            setInstanceIdProvider: jest.fn(), // 必须包含这个
            resetLogger: jest.fn(),
            enableTelegramConsoleProxy: jest.fn(),
            disableTelegramConsoleProxy: jest.fn()
        }));

        jest.unstable_mockModule("../../src/repositories/InstanceRepository.js", () => ({
            InstanceRepository: {
                createTableIfNotExists: jest.fn().mockResolvedValue(undefined),
                upsert: jest.fn().mockResolvedValue(true),
                updateHeartbeat: jest.fn().mockResolvedValue(true),
                findAll: jest.fn().mockResolvedValue([]),
            },
        }));

        jest.unstable_mockModule("../../src/services/CacheService.js", () => ({
            cache: mockCache,
            default: { cache: mockCache }
        }));

        // 处理 QStash 依赖，防止 import InstanceCoordinator 时报错
        jest.unstable_mockModule("../../src/services/QStashService.js", () => ({
            qstashService: {
                broadcastSystemEvent: jest.fn().mockResolvedValue(undefined)
            }
        }));

        jest.resetModules();
        
        const { instanceCoordinator: importedIC } = await import("../../src/services/InstanceCoordinator.js");
        instanceCoordinator = importedIC;
    });

    afterAll(() => {
        process.env = originalEnv;
        jest.useRealTimers();
    });

    afterEach(() => {
        // 清理 Mocks
        jest.clearAllMocks();
        
        // 清理定时器
        if (instanceCoordinator && instanceCoordinator.heartbeatTimer) {
            clearInterval(instanceCoordinator.heartbeatTimer);
            instanceCoordinator.heartbeatTimer = null;
        }

        // 【关键修复】强制 GC
        if (global.gc) {
            global.gc();
        }
    });

    test("should send heartbeat to KV", async () => {
        // 使用 Jest Fake Timers
        jest.useFakeTimers();

        const instanceData = {
            id: "test_instance_heartbeat",
            status: "active",
            lastHeartbeat: Date.now() - 1000
        };
        mockCache.get.mockResolvedValue(instanceData);
        mockCache.set.mockResolvedValue(true);

        instanceCoordinator.startHeartbeat();

        // 快进时间以触发心跳
        jest.advanceTimersByTime(30 * 1000); // 30秒心跳间隔

        // 等待异步操作完成
        await Promise.resolve();

        expect(mockCache.get).toHaveBeenCalledWith("instance:test_instance_heartbeat");
        expect(mockCache.set).toHaveBeenCalledWith(
            "instance:test_instance_heartbeat",
            expect.objectContaining({
                id: "test_instance_heartbeat",
                lastHeartbeat: expect.any(Number)
            }),
            90 // 90秒 TTL (instanceTimeout / 1000)
        );

        // 清理定时器
        if (instanceCoordinator.heartbeatTimer) {
            clearInterval(instanceCoordinator.heartbeatTimer);
        }
        jest.useRealTimers();
    });

    test("should re-register if instance data missing in KV", async () => {
        // 使用 Jest Fake Timers
        jest.useFakeTimers();

        mockCache.get.mockResolvedValue(null);
        mockCache.set.mockResolvedValue(true);

        instanceCoordinator.startHeartbeat();

        // 快进时间以触发心跳
        jest.advanceTimersByTime(30 * 1000); // 30秒心跳间隔

        // 等待异步操作完成
        await Promise.resolve();

        expect(mockCache.get).toHaveBeenCalledWith("instance:test_instance_heartbeat");
        // 根据源码，重新注册会写入 hostname, startedAt 等信息
        expect(mockCache.set).toHaveBeenCalledWith(
            "instance:test_instance_heartbeat",
            expect.objectContaining({
                id: "test_instance_heartbeat",
                status: "active",
                hostname: "unknown"
            }),
            90 // 90秒 TTL
        );
        
        // 清理定时器
        if (instanceCoordinator.heartbeatTimer) {
            clearInterval(instanceCoordinator.heartbeatTimer);
        }
        jest.useRealTimers();
    });

    test("should handle KV errors gracefully", async () => {
        // 使用 Jest Fake Timers
        jest.useFakeTimers();

        // 根据 InstanceCoordinator.js 第 126 行：logger.error(`[${cache.getCurrentProvider()}] Cache心跳更新失败...`)
        const loggerSpy = jest.spyOn(mockLogger, "error").mockImplementation(() => {});

        mockCache.get.mockRejectedValue(new Error("KV Network Error"));

        instanceCoordinator.startHeartbeat();

        // 快进时间以触发心跳
        jest.advanceTimersByTime(30 * 1000); // 30秒心跳间隔

        // 等待异步操作完成
        await Promise.resolve();

        // 验证是否记录了错误日志
        expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining("心跳更新失败"));
        
        // Clean up
        loggerSpy.mockRestore();
        if (instanceCoordinator.heartbeatTimer) {
            clearInterval(instanceCoordinator.heartbeatTimer);
        }
        jest.useRealTimers();
    });
});