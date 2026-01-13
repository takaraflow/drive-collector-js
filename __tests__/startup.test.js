// Mock config for startup tests using unstable_mockModule
// Jest ESM mockModule �?Windows 下对相对路径的处理有时不可预测，使用绝对路径确保成功
import { join } from 'path';

vi.mock('../../src/config/index.js', () => ({
  config: {
    apiId: 12345,
    apiHash: "test_api_hash",
    botToken: "test_token",
    downloadDir: "/tmp",
    remoteFolder: "test"
  },
  getConfig: vi.fn(() => ({
    apiId: 12345,
    apiHash: "test_api_hash",
    botToken: "test_token",
    downloadDir: "/tmp",
    remoteFolder: "test"
  })),
  initConfig: vi.fn().mockResolvedValue({}),
  validateConfig: vi.fn().mockReturnValue(true)
}));

vi.mock('../src/services/logger/index.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    },
    enableTelegramConsoleProxy: vi.fn(),
    default: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    }
}));

vi.mock('../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: {
        get: vi.fn(),
        set: vi.fn()
    }
}));

vi.mock('../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        getInstanceId: vi.fn().mockReturnValue('test-instance')
    }
}));

vi.mock('../src/services/CacheService.js', () => ({
    cache: {
        get: vi.fn()
    }
}));

vi.mock('telegram', () => ({
    TelegramClient: vi.fn().mockImplementation(() => ({
        on: vi.fn(),
        addEventHandler: vi.fn(),
        start: vi.fn(),
        connect: vi.fn()
    })),
    StringSession: vi.fn()
}));

vi.mock('../src/services/d1.js', () => ({
    d1: {}
}));

vi.mock('../src/services/rclone.js', () => ({
    CloudTool: {}
}));

vi.mock('../src/services/oss.js', () => ({
    ossService: {}
}));


describe("Project Smoke Test (Startup)", () => {
    test("should load config module", async () => {
        const config = await import("../src/config/index.js");
        expect(config).toBeDefined();
    }, 30000);

    test("should load common utils module", async () => {
        const common = await import("../src/utils/common.js");
        expect(common).toBeDefined();
    }, 30000);

    test("should load limiter utils module", async () => {
        const limiter = await import("../src/utils/limiter.js");
        expect(limiter).toBeDefined();
    }, 30000);

    test("should load templates module", async () => {
        const templates = await import("../src/ui/templates.js");
        expect(templates).toBeDefined();
    }, 30000);

    test("should load locales module", async () => {
        const locales = await import("../src/locales/zh-CN.js");
        expect(locales).toBeDefined();
    }, 30000);

    test("should load telegram module with Mocks", async () => {
        const telegram = await import("../src/services/telegram.js");
        expect(telegram).toBeDefined();
    }, 30000);

    test("should load TaskManager module with Mocks", async () => {
        const taskManager = await import("../src/processor/TaskManager.js");
        expect(taskManager).toBeDefined();
    }, 30000);

    test("should load TaskRepository module with Mocks", async () => {
        const taskRepository = await import("../src/repositories/TaskRepository.js");
        expect(taskRepository).toBeDefined();
    }, 30000);
}, 30000);
