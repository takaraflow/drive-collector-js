import { jest, describe, test, expect } from "@jest/globals";

// 为冒烟测试 Mock 必要的环境变量和外部连接，防止在 import 时崩溃
// 我们主要关注语法错误，而非运行逻辑
jest.unstable_mockModule("../src/config/index.js", () => ({
    config: {
        apiId: 12345,
        apiHash: "mock_hash",
        botToken: "mock_token",
        downloadDir: "/tmp",
        remoteFolder: "test"
    }
}));

jest.unstable_mockModule("../src/services/d1.js", () => ({
    d1: {
        fetchAll: jest.fn().mockResolvedValue([]),
        fetchOne: jest.fn().mockResolvedValue(null),
        execute: jest.fn().mockResolvedValue({ success: true })
    }
}));

describe("Project Smoke Test (Startup)", () => {
    test("should load core modules without SyntaxErrors", async () => {
        // 关键在于导入这些文件，只要没有 SyntaxError 就算通过
        const modules = [
            "../src/config/index.js",
            "../src/utils/common.js",
            "../src/utils/limiter.js",
            "../src/ui/templates.js",
            "../src/locales/zh-CN.js"
        ];

        for (const path of modules) {
            const module = await import(path);
            expect(module).toBeDefined();
        }
    });

    test("should load complex modules with Mocks", async () => {
        // 这些模块在顶级作用域有副作用（如初始化连接），需要 Mock
        const complexModules = [
            "../src/services/telegram.js",
            "../src/core/TaskManager.js",
            "../src/repositories/TaskRepository.js"
        ];

        for (const path of complexModules) {
            const module = await import(path);
            expect(module).toBeDefined();
        }
    });
});