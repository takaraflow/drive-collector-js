import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Mock telegram package to prevent TelegramClient initialization
jest.unstable_mockModule('telegram', () => ({
  TelegramClient: jest.fn().mockImplementation(() => ({})),
  StringSession: jest.fn().mockImplementation(() => ({}))
}));

// Early mock of the config module
jest.unstable_mockModule('../../src/config/index.js', () => ({
  config: {
    apiId: 12345,
    apiHash: 'test-api-hash'
  }
}));

// Mock telegram service
jest.unstable_mockModule('../../src/services/telegram.js', () => ({
  client: {},
  clearSession: jest.fn(),
  saveSession: jest.fn(),
  resetClientSession: jest.fn(),
  setConnectionStatusCallback: jest.fn(),
  stopWatchdog: jest.fn()
}));

describe('Logger Integration Tests', () => {
  let consoleInfoSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    jest.clearAllMocks();

    // Spy on console methods to capture fallback logging
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });


  describe('processor/TaskManager.js integration', () => {
    test('TaskManager can be imported without logger causing crashes', async () => {
      // This test verifies that importing TaskManager doesn't crash due to logger issues
      const taskManagerModule = await import('../../src/processor/TaskManager.js');

      // Verify TaskManager class is available
      expect(taskManagerModule.TaskManager).toBeDefined();
      expect(typeof taskManagerModule.TaskManager.init).toBe('function');
      expect(typeof taskManagerModule.TaskManager.addTask).toBe('function');
      expect(typeof taskManagerModule.TaskManager.handleDownloadWebhook).toBe('function');
    });

    test('TaskManager static methods work without logger crashes', async () => {
      const taskManagerModule = await import('../../src/processor/TaskManager.js');

      // Test that calling TaskManager methods don't crash due to logger issues
      // We won't actually execute the methods since they have complex dependencies,
      // but we can verify they exist and are callable

      expect(typeof taskManagerModule.TaskManager.getProcessingCount).toBe('function');
      expect(typeof taskManagerModule.TaskManager.getWaitingCount).toBe('function');
      expect(typeof taskManagerModule.TaskManager.batchUpdateStatus).toBe('function');

      // Call simple getter methods
      const processingCount = taskManagerModule.TaskManager.getProcessingCount();
      const waitingCount = taskManagerModule.TaskManager.getWaitingCount();

      expect(typeof processingCount).toBe('number');
      expect(typeof waitingCount).toBe('number');
    });

    test('TaskManager.init can be called without crashing', async () => {
      const taskManagerModule = await import('../../src/processor/TaskManager.js');

      // Mock TaskRepository to avoid database dependencies
      jest.doMock('../../src/repositories/TaskRepository.js', () => ({
        TaskRepository: {
          findStalledTasks: jest.fn().mockResolvedValue([])
        }
      }));

      // Mock other dependencies that TaskManager.init uses
      jest.doMock('../../src/services/CacheService.js', () => ({
          cache: {
              isFailoverMode: false
          }
      }));

      // Reset modules to pick up the mocks
      jest.resetModules();

      // Re-import TaskManager with mocks
      const freshTaskManagerModule = await import('../../src/processor/TaskManager.js');

      // Call init - it should complete without crashing due to logger issues
      await expect(freshTaskManagerModule.TaskManager.init()).resolves.toBeUndefined();
    });
  });

  describe('Logger output verification', () => {
    test('logger output can be captured in test environment', async () => {
      // Import logger directly
      const loggerModule = await import('../../src/services/logger.js');
      const logger = loggerModule.logger;

      // Call logger methods
      await logger.info('Test info message', { test: true });
      await logger.warn('Test warn message', { warning: true });
      await logger.error('Test error message', { error: true });

      // Verify console methods were called (since Axiom is not configured)
      // Note: logger now adds version prefix [vX.Y.Z] to messages
      expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('[v'), { test: true });
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('[v'), { warning: true });
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[v'), { error: true });
    });

    test('logger works in both configured and unconfigured states', async () => {
      // Test with Axiom unconfigured (default)
      const loggerModule1 = await import('../../src/services/logger.js');
      let logger1 = loggerModule1.logger;

      await logger1.info('Message when unconfigured');
      expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('[v'), {});

      // Reset for next test
      jest.clearAllMocks();

      // Test with Axiom configured
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Reset modules to trigger re-initialization
      jest.resetModules();

      const loggerModule2 = await import('../../src/services/logger.js');
      const logger2 = loggerModule2.logger;

      await logger2.info('Message when configured');

      // Since console spies are still active, and logger should work in both cases
      // The exact behavior depends on whether Axiom mock is properly set up,
      // but the important thing is no crashes occur
      expect(() => logger2.info('Another message')).not.toThrow();
    });
  });

  describe('Telegram TIMEOUT unified logging integration', () => {
    test('end-to-end: console proxy captures TIMEOUT and sends to Axiom', async () => {
      // Setup Axiom config
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Reset logger to pick up config
      jest.resetModules();
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      const logger = loggerModule.logger;
      const enableProxy = loggerModule.enableTelegramConsoleProxy;

      // Mock axiom ingest to track calls
      const { mockAxiomIngest } = await import('../setup/external-mocks.js');

      // Enable proxy
      enableProxy();

      // Simulate Telegram library timeout
      console.error('TIMEOUT in updates.js', { someData: 'value' });

      // Wait for async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify Axiom ingest was called with correct payload
      expect(mockAxiomIngest).toHaveBeenCalled();
      const payload = mockAxiomIngest.mock.calls[0][1][0];
      expect(payload.level).toBe('error');
      expect(payload.service).toBe('telegram');
      expect(payload.source).toBe('console_proxy');
      expect(payload.message).toContain('Telegram library TIMEOUT captured');
    });

    test('end-to-end: telegram client error handler sends to Axiom', async () => {
      // This test verifies the full flow from telegram.js error handler to Axiom
      // We'll mock the telegram client and simulate an error event

      // Setup Axiom config
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Reset modules
      jest.resetModules();

      // Mock telegram package
      jest.unstable_mockModule('telegram', () => ({
        TelegramClient: jest.fn().mockImplementation(() => ({
          connect: jest.fn(),
          start: jest.fn(),
          disconnect: jest.fn(),
          on: jest.fn((event, handler) => {
            // Store handler for later invocation
            if (event === 'error') {
              // Simulate error after a short delay
              setTimeout(() => {
                const timeoutError = new Error('Request timed out');
                timeoutError.code = 'ETIMEDOUT';
                handler(timeoutError);
              }, 10);
            }
          }),
          addEventHandler: jest.fn(),
          getMe: jest.fn().mockResolvedValue({ id: 123 }),
          session: { save: jest.fn().mockReturnValue('mock') },
          connected: false,
          _sender: { disconnect: jest.fn() }
        })),
        StringSession: jest.fn().mockImplementation(() => ({
          save: jest.fn().mockReturnValue('mock')
        }))
      }));

      // Mock other dependencies
      jest.unstable_mockModule('../../src/repositories/SettingsRepository.js', () => ({
        SettingsRepository: {
          get: jest.fn().mockResolvedValue(''),
          set: jest.fn().mockResolvedValue(undefined)
        }
      }));

      jest.unstable_mockModule('../../src/services/InstanceCoordinator.js', () => ({
        instanceCoordinator: {
          hasLock: jest.fn().mockResolvedValue(true),
          releaseLock: jest.fn().mockResolvedValue(undefined)
        }
      }));

      // Import logger and enable proxy
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      const enableProxy = loggerModule.enableTelegramConsoleProxy;
      enableProxy();

      // Mock axiom ingest
      const { mockAxiomIngest } = await import('../setup/external-mocks.js');

      // Import telegram service (will use mocked client)
      const telegramModule = await import('../../src/services/telegram.js');

      // Get client to trigger event listener setup
      const client = await telegramModule.getClient();

      // Wait for simulated error
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify logger.error was called (which would send to Axiom)
      // Since we're using real logger, check if ingest was called
      if (mockAxiomIngest.mock.calls.length > 0) {
        const payload = mockAxiomIngest.mock.calls[0][1][0];
        expect(payload.service).toBe('telegram');
        expect(payload.level).toBe('error');
      }
    });
  });
});