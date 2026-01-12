// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock services before import
const mockQueueService = {
    initialize: vi.fn().mockResolvedValue(undefined),
    verifyWebhookSignature: vi.fn().mockResolvedValue(true)
};

const mockCache = {
    initialize: vi.fn().mockResolvedValue(undefined),
    getCurrentProvider: vi.fn().mockReturnValue('test')
};

const mockD1 = {
    initialize: vi.fn().mockResolvedValue(undefined)
};

const mockLogger = {
    withModule: vi.fn().mockReturnThis(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined)
};

const mockInstanceCoordinator = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined)
};

const mockGracefulShutdown = {
    shutdown: vi.fn(),
    exitCode: 0
};

// Set up mocks before importing modules
vi.mock('../../src/config/index.js', () => ({
    initConfig: vi.fn().mockResolvedValue(undefined),
    validateConfig: vi.fn().mockReturnValue(true),
    getConfig: vi.fn().mockReturnValue({
        apiId: 12345,
        apiHash: 'test_api_hash',
        botToken: 'test_bot_token'
    })
}));

vi.mock('../../src/config/env.js', () => ({
    getEnv: () => ({ NODE_ENV: 'test', API_ID: '123456789', API_HASH: 'test_api_hash', BOT_TOKEN: 'test_bot_token' }),
    NODE_ENV: 'test',
    API_ID: '123456789',
    API_HASH: 'test_api_hash',
    BOT_TOKEN: 'test_bot_token'
}));

vi.mock('../../src/services/QueueService.js', () => ({
    __esModule: true,
    default: mockQueueService,
    queueService: mockQueueService
}));

vi.mock('../../src/services/CacheService.js', () => ({
    __esModule: true,
    default: mockCache,
    cache: mockCache
}));

vi.mock('../../src/services/d1.js', () => ({
    __esModule: true,
    default: mockD1,
    d1: mockD1
}));

vi.mock('../../src/services/logger/index.js', () => ({
    __esModule: true,
    default: mockLogger,
    logger: mockLogger
}));

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    __esModule: true,
    default: mockInstanceCoordinator,
    instanceCoordinator: mockInstanceCoordinator
}));

vi.mock('../../src/dispatcher/bootstrap.js', () => ({
    __esModule: true,
    startDispatcher: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/processor/bootstrap.js', () => ({
    __esModule: true,
    startProcessor: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/services/telegram.js', () => ({
    __esModule: true,
    default: { client: { connect: vi.fn().mockResolvedValue(undefined), start: vi.fn().mockResolvedValue(undefined) } }
}));

vi.mock('../../src/utils/lifecycle.js', () => ({
    __esModule: true,
    buildWebhookServer: vi.fn().mockResolvedValue(undefined),
    registerShutdownHooks: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../src/services/GracefulShutdown.js', () => ({
    __esModule: true,
    default: mockGracefulShutdown,
    gracefulShutdown: mockGracefulShutdown
}));

vi.mock('../../src/utils/startupConfig.js', () => ({
    __esModule: true,
    summarizeStartupConfig: vi.fn().mockResolvedValue({})
}));

describe("Application Startup Resilience and Degradation", () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        
        // Mock console to prevent log pollution
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("should handle successful startup", async () => {
        // Import and call main function
        const { main } = await import('../../index.js');
        
        // Call main function
        await main();
        
        // Verify initialization calls
        expect(mockQueueService.initialize).toHaveBeenCalled();
        expect(mockCache.initialize).toHaveBeenCalled();
        expect(mockD1.initialize).toHaveBeenCalled();
        expect(mockInstanceCoordinator.start).toHaveBeenCalled();
    });
});