// Mock env.js instead of accessing process.env
let mockEnv = {
  NODE_ENV: 'test',
  API_ID: '123456789',
  API_HASH: 'test_api_hash',
  BOT_TOKEN: 'test_bot_token',
  INFISICAL_ENV: 'test',
  INFISICAL_TOKEN: 'test_token',
  INFISICAL_PROJECT_ID: 'test_project'
};

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("Application Startup Resilience and Degradation", () => {
    let mockInstanceCoordinator;
    let mockQueueService;
    let mockCache;
    let mockD1;
    let mockLogger;
    let mockGracefulShutdown;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        
        // Mock console to prevent log pollution
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});

        // Mock InstanceCoordinator
        mockInstanceCoordinator = {
            start: vi.fn().mockResolvedValue(undefined),
            stop: vi.fn().mockResolvedValue(undefined)
        };

        // Mock QueueService
        mockQueueService = {
            initialize: vi.fn().mockResolvedValue(undefined),
            verifyWebhookSignature: vi.fn().mockResolvedValue(true)
        };

        // Mock CacheService
        mockCache = {
            initialize: vi.fn().mockResolvedValue(undefined),
            getCurrentProvider: vi.fn().mockReturnValue('test')
        };

        // Mock D1
        mockD1 = {
            initialize: vi.fn().mockResolvedValue(undefined)
        };

        // Mock Logger
        mockLogger = {
            withModule: vi.fn().mockReturnThis(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        };

        // Mock GracefulShutdown
        mockGracefulShutdown = {
            shutdown: vi.fn(),
            exitCode: 0
        };

        // Mock config module
        await vi.doMock('../../src/config/index.js', () => ({
            initConfig: vi.fn().mockResolvedValue(undefined),
            validateConfig: vi.fn().mockReturnValue(true),
            getConfig: vi.fn().mockReturnValue({
                apiId: 12345,
                apiHash: 'test_api_hash',
                botToken: 'test_bot_token'
            })
        }));

        // Mock env module
        await vi.doMock('../../src/config/env.js', () => ({
            getEnv: () => mockEnv,
            NODE_ENV: mockEnv.NODE_ENV,
            API_ID: mockEnv.API_ID,
            API_HASH: mockEnv.API_HASH,
            BOT_TOKEN: mockEnv.BOT_TOKEN
        }));

        // Mock services
        await vi.doMock('../../src/services/QueueService.js', () => ({
            queueService: mockQueueService
        }));

        await vi.doMock('../../src/services/CacheService.js', () => ({
            cache: mockCache
        }));

        await vi.doMock('../../src/services/d1.js', () => ({
            d1: mockD1
        }));

        await vi.doMock('../../src/services/logger/index.js', () => ({
            logger: mockLogger
        }));

        await vi.doMock('../../src/services/InstanceCoordinator.js', () => ({
            instanceCoordinator: mockInstanceCoordinator
        }));

        await vi.doMock('../../src/dispatcher/bootstrap.js', () => ({
            startDispatcher: vi.fn().mockResolvedValue(undefined)
        }));

        await vi.doMock('../../src/processor/bootstrap.js', () => ({
            startProcessor: vi.fn().mockResolvedValue(undefined)
        }));

        await vi.doMock('../../src/services/telegram.js', () => ({
            client: {
                connect: vi.fn().mockResolvedValue(undefined),
                start: vi.fn().mockResolvedValue(undefined)
            }
        }));

        await vi.doMock('../../src/utils/lifecycle.js', () => ({
            buildWebhookServer: vi.fn().mockResolvedValue(undefined),
            registerShutdownHooks: vi.fn().mockResolvedValue(undefined)
        }));

        await vi.doMock('../../src/services/GracefulShutdown.js', () => ({
            gracefulShutdown: mockGracefulShutdown
        }));

        await vi.doMock('../../src/utils/startupConfig.js', () => ({
            summarizeStartupConfig: vi.fn().mockResolvedValue({})
        }));
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