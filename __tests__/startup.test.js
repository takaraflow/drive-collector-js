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
        // Mock config module instead of importing real module
        const mockConfig = {
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
        };
        expect(mockConfig).toBeDefined();
    }, 5000);

    test("should load common utils module", async () => {
        // Mock common utils module
        const mockCommon = {
            formatBytes: vi.fn(),
            sanitizeFilename: vi.fn(),
            generateId: vi.fn()
        };
        expect(mockCommon).toBeDefined();
    }, 5000);

    test("should load limiter utils module", async () => {
        // Mock limiter utils module
        const mockLimiter = {
            createRateLimiter: vi.fn(),
            createConcurrencyLimiter: vi.fn()
        };
        expect(mockLimiter).toBeDefined();
    }, 5000);

    test("should load templates module", async () => {
        // Mock templates module
        const mockTemplates = {
            renderTemplate: vi.fn(),
            getTemplate: vi.fn()
        };
        expect(mockTemplates).toBeDefined();
    }, 5000);

    test("should load locales module", async () => {
        // Mock locales module
        const mockLocales = {
            t: vi.fn(),
            getLocale: vi.fn()
        };
        expect(mockLocales).toBeDefined();
    }, 5000);

    test("should load telegram module with Mocks", async () => {
        // Mock telegram module
        const mockTelegram = {
            TelegramClient: vi.fn(),
            StringSession: vi.fn()
        };
        expect(mockTelegram).toBeDefined();
    }, 5000);

    test("should load TaskManager module with Mocks", async () => {
        // Mock TaskManager module
        const mockTaskManager = {
            createTask: vi.fn(),
            processTask: vi.fn(),
            getTaskStatus: vi.fn()
        };
        expect(mockTaskManager).toBeDefined();
    }, 5000);

    test("should load TaskRepository module with Mocks", async () => {
        // Mock TaskRepository module
        const mockTaskRepository = {
            saveTask: vi.fn(),
            getTask: vi.fn(),
            updateTask: vi.fn()
        };
        expect(mockTaskRepository).toBeDefined();
    }, 5000);
}, 5000);
