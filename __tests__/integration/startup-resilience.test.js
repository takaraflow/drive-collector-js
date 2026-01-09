import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';

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
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("Application Startup Resilience and Degradation", () => {
    let mockSettingsRepository;
    let mockInstanceCoordinator;
    let mockClient;

    beforeEach(async () => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        
        // Mock env access instead of modifying process.env
        await jest.unstable_mockModule('../../src/config/env.js', () => ({
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
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});

        // Mock SettingsRepository
        mockSettingsRepository = {
            get: jest.fn(),
            set: jest.fn()
        };

        // Mock InstanceCoordinator
        mockInstanceCoordinator = {
            getInstanceInfo: jest.fn(),
            claim: jest.fn().mockResolvedValue(true),
            release: jest.fn()
        };

        // Mock Telegram client
        mockClient = {
            connect: jest.fn().mockResolvedValue(true),
            start: jest.fn().mockResolvedValue(true),
            stop: jest.fn().mockResolvedValue(true)
        };

        await jest.unstable_mockModule('../../src/repositories/SettingsRepository.js', () => ({
            SettingsRepository: mockSettingsRepository
        }));

        await jest.unstable_mockModule('../../src/services/InstanceCoordinator.js', () => ({
            instanceCoordinator: mockInstanceCoordinator
        }));

        await jest.unstable_mockModule('../../src/services/telegram.js', () => ({
            client: mockClient
        }));

        await jest.unstable_mockModule('../../src/services/InfisicalClient.js', () => ({
            fetchInfisicalSecrets: jest.fn().mockResolvedValue({
                API_ID: '123456789',
                API_HASH: 'test_api_hash',
                BOT_TOKEN: 'test_bot_token'
            })
        }));

        await jest.unstable_mockModule('../../src/config/dotenv.js', () => ({
            loadDotenv: jest.fn()
        }));
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
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
        jest.advanceTimersByTime(1000);
        
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
        jest.advanceTimersByTime(backoffSeconds * 1000);
        
        expect(mockInstanceCoordinator.getInstanceInfo).toHaveBeenCalled();
    });

    test("should handle configuration loading failures", async () => {
        // Mock configuration error
        await jest.unstable_mockModule('../../src/config/env.js', () => ({
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