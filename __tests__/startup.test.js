import { jest, describe, test, expect } from "@jest/globals";

// Mock config for startup tests using unstable_mockModule
// 使用相对于根目录的路径，或者确保路径正确
jest.unstable_mockModule('../../src/config/index.js', () => ({
  config: {
    apiId: 12345,
    apiHash: "test_api_hash",
    botToken: "test_token",
    downloadDir: "/tmp",
    remoteFolder: "test"
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
            "../src/processor/TaskManager.js",
            "../src/repositories/TaskRepository.js"
        ];

        for (const path of complexModules) {
            const module = await import(path);
            expect(module).toBeDefined();
        }
    });
});