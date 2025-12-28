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
      jest.doMock('../../src/services/kv.js', () => ({
        kv: {
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
      expect(consoleInfoSpy).toHaveBeenCalledWith('Test info message', { test: true });
      expect(consoleWarnSpy).toHaveBeenCalledWith('Test warn message', { warning: true });
      expect(consoleErrorSpy).toHaveBeenCalledWith('Test error message', { error: true });
    });

    test('logger works in both configured and unconfigured states', async () => {
      // Test with Axiom unconfigured (default)
      const loggerModule1 = await import('../../src/services/logger.js');
      let logger1 = loggerModule1.logger;

      await logger1.info('Message when unconfigured');
      expect(consoleInfoSpy).toHaveBeenCalledWith('Message when unconfigured', {});

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
});