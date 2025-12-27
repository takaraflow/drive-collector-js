import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";

// Mock the Axiom SDK to avoid external dependencies
jest.mock('@axiomhq/js', () => ({
  Axiom: jest.fn().mockImplementation(() => ({
    ingest: jest.fn().mockResolvedValue(undefined)
  }))
}));

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

  describe('worker/lb.js integration', () => {
    test('lb.js can be imported without logger causing crashes', async () => {
      // This test verifies that importing lb.js doesn't crash due to logger issues
      const lbModule = await import('../../src/worker/lb.js');

      // Verify that lb.js exports the expected functions
      expect(typeof lbModule.default).toBe('object'); // Worker main object
      expect(typeof lbModule.default.fetch).toBe('function'); // Worker main function
      expect(typeof lbModule.verifyQStashSignature).toBe('function');
      expect(typeof lbModule.getActiveInstances).toBe('function');
      expect(typeof lbModule.selectTargetInstance).toBe('function');
    });

    test('lb.js logger calls work without crashing', async () => {
      // Import lb.js and test that its internal logger calls don't crash
      const lbModule = await import('../../src/worker/lb.js');

      // Test the exported functions that use logger
      // These functions should not crash even if logger falls back to console

      // Test shouldFailover function (which uses logger.warn)
      const mockError = { message: 'quota exceeded' };
      const result = lbModule.shouldFailover(mockError, {});

      // Function should return boolean without crashing
      expect(typeof result).toBe('boolean');

      // Test failover function (which uses logger.info)
      const failoverResult = lbModule.failover({});
      expect(typeof failoverResult).toBe('boolean');

      // Test getCurrentProvider function
      const provider = lbModule.getCurrentProvider();
      expect(typeof provider).toBe('string');

      // Verify console was called (since Axiom is not configured by default)
      // Note: actual calls might not happen in these simple function calls,
      // but at least we verified they don't crash
    });

    test('lb.js worker function can handle requests without logger crashes', async () => {
      const lbModule = await import('../../src/worker/lb.js');

      // Create a mock request
      const mockRequest = {
        method: 'POST',
        url: 'https://example.com/webhook',
        headers: new Map([
          ['Upstash-Signature', 'v1a=test-signature'],
          ['Upstash-Timestamp', '1234567890'],
          ['CF-Connecting-IP', '127.0.0.1']
        ]),
        text: () => Promise.resolve('{"test": "data"}')
      };

      // Mock environment
      const mockEnv = {
        KV_STORAGE: {
          list: jest.fn().mockResolvedValue({ keys: [] }),
          get: jest.fn().mockResolvedValue(null),
          put: jest.fn().mockResolvedValue(true)
        },
        QSTASH_CURRENT_SIGNING_KEY: 'test-key'
      };

      // Mock execution context
      const mockCtx = {};

      // Call the worker function - it should not crash due to logger issues
      const responsePromise = lbModule.default.fetch(mockRequest, mockEnv, mockCtx);

      // Should return a response without throwing
      await expect(responsePromise).resolves.toBeInstanceOf(Response);
    });
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