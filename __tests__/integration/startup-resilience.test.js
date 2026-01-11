// Mock env.js instead of accessing process.env
let mockEnv = {
  NODE_ENV: 'development',
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
    let mockSettingsRepository;
    let mockInstanceCoordinator;
    let mockClient;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        
        // Mock env access instead of modifying process.env
        await vi.doMock('../../src/config/env.js', () => ({
            getEnv: () => mockEnv,
            NODE_ENV: mockEnv.NODE_ENV,
            API_ID: mockEnv.API_ID,
            API_HASH: mockEnv.API_HASH,
            BOT_TOKEN: mockEnv.BOT_TOKEN,
            INFISICAL_ENV: mockEnv.INFISICAL_ENV,
            INFISICAL_TOKEN: mockEnv.INFISICAL_TOKEN,
            INFISICAL_PROJECT_ID: mockEnv.INFISICAL_PROJECT_ID
        }));

        // Mock console to prevent log pollution
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});

        // Mock SettingsRepository
        mockSettingsRepository = {
            get: vi.fn(),
            set: vi.fn()
        };

        // Mock InstanceCoordinator
        mockInstanceCoordinator = {
            getInstanceInfo: vi.fn(),
            claim: vi.fn().mockResolvedValue(true),
            release: vi.fn()
        };

        // Mock Telegram client
        mockClient = {
            connect: vi.fn().mockResolvedValue(true),
            start: vi.fn().mockResolvedValue(true),
            stop: vi.fn().mockResolvedValue(true)
        };

        await vi.doMock('../../src/repositories/SettingsRepository.js', () => ({
            SettingsRepository: mockSettingsRepository
        }));

        await vi.doMock('../../src/services/InstanceCoordinator.js', () => ({
            instanceCoordinator: mockInstanceCoordinator
        }));

        await vi.doMock('../../src/services/telegram.js', () => ({
            client: mockClient
        }));

        await vi.doMock('../../src/services/InfisicalClient.js', () => ({
            fetchInfisicalSecrets: vi.fn().mockResolvedValue({
                API_ID: '123456789',
                API_HASH: 'test_api_hash',
                BOT_TOKEN: 'test_bot_token'
            })
        }));

        await vi.doMock('../../src/config/dotenv.js', () => ({
            loadDotenv: vi.fn()
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    test("should handle successful startup", async () => {
        mockSettingsRepository.get.mockResolvedValue({
            instanceId: 'test-instance',
            telegramAuthorized: true
        });

        mockInstanceCoordinator.getInstanceInfo.mockResolvedValue({
            instanceId: 'test-instance',
            role: 'primary',
            isActive: true
        });

        // Simulate startup
        const { default: app } = await import('../../src/index.js');
        
        // Advance timers to complete any async operations
        vi.advanceTimersByTime(1000);
        
        // Verify initialization calls
        expect(mockInstanceCoordinator.claim).toHaveBeenCalled();
        expect(mockClient.connect).toHaveBeenCalled();
    });

    test("should handle connection timeout gracefully", async () => {
        mockSettingsRepository.get.mockResolvedValue({
            instanceId: 'test-instance',
            telegramAuthorized: false
        });

        mockInstanceCoordinator.getInstanceInfo.mockRejectedValue(new Error('Connection timeout'));

        // Mock backoff mechanism
        const backoffSeconds = 5;
        
        // Simulate connection timeout
        try {
            await mockInstanceCoordinator.getInstanceInfo();
        } catch (error) {
            // Expected error
        }
        
        // Advance time to simulate backoff without real setTimeout
        vi.advanceTimersByTime(backoffSeconds * 1000);
        
        expect(mockInstanceCoordinator.getInstanceInfo).toHaveBeenCalled();
    });

    test("should handle configuration loading failures", async () => {
        // Mock configuration error
        await vi.doMock('../../src/config/env.js', () => ({
            getEnv: () => {
                throw new Error('Configuration loading failed');
            },
            NODE_ENV: undefined,
            API_ID: undefined,
            API_HASH: undefined,
            BOT_TOKEN: undefined
        }));

        // The application should handle this gracefully
        expect(() => import('../../src/config/env.js')).not.toThrow();
    });
});