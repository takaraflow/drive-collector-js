import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { mockAxiomIngest, mockAxiomConstructor } from '../setup/external-mocks.js';

// Use the global mock
const mockIngest = mockAxiomIngest;

// Mock the config module
jest.unstable_mockModule('../../src/config/index.js', () => ({
  config: {}
}));

// Mock InstanceCoordinator
jest.unstable_mockModule('../../src/services/InstanceCoordinator.js', () => ({
  getInstanceId: jest.fn().mockReturnValue('test-instance-id')
}));

describe('Logger Service', () => {
  let logger;
  let consoleInfoSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;
  let consoleDebugSpy;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset modules to ensure clean state
    jest.resetModules();

    // Spy on console methods
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation();
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();

    // Import logger after mocks are set up
    const loggerModule = await import('../../src/services/logger.js');
    logger = loggerModule.logger;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('When Axiom is not configured', () => {
    beforeEach(async () => {
      // Ensure axiom config is not present
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = undefined;

      // Reset logger module to pick up config changes
      jest.resetModules();
      const loggerModule = await import('../../src/services/logger.js');
      logger = loggerModule.logger;
    });

    test('logger.info falls back to console.info with version prefix', async () => {
      const message = 'test info message';
      const data = { key: 'value' };

      await logger.info(message, data);

      expect(consoleInfoSpy).toHaveBeenCalledTimes(1);
      expect(consoleInfoSpy).toHaveBeenCalledWith(expect.stringContaining('[v'), data);
    });

    test('logger.warn falls back to console.warn with version prefix', async () => {
      const message = 'test warn message';
      const data = { error: 'something' };

      await logger.warn(message, data);

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('[v'), data);
    });

    test('logger.error falls back to console.error with version prefix', async () => {
      const message = 'test error message';
      const data = { stack: 'error stack' };

      await logger.error(message, data);

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[v'), data);
    });

    test('logger.debug falls back to console.debug with version prefix', async () => {
      const message = 'test debug message';
      const data = { debug: true };

      await logger.debug(message, data);

      // Now console.debug is called twice: once for instance ID fallback, once for the actual log
      expect(consoleDebugSpy).toHaveBeenCalledTimes(2);
      // The second call should be the actual log message
      const secondCall = consoleDebugSpy.mock.calls[1];
      expect(secondCall[0]).toContain('[v');
      expect(secondCall[1]).toEqual(data);
    });
  });

  describe('When Axiom is configured', () => {
    beforeEach(async () => {
      // Reset logger internal state
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();

      // Mock Axiom configuration
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      logger = loggerModule.logger;
    });

    test('logger.info calls axiom.ingest with correct payload including version', async () => {
      const message = 'structured info message';
      const data = { userId: 123, action: 'login' };

      await logger.info(message, data);

      expect(mockIngest).toHaveBeenCalledTimes(1);
      expect(mockIngest).toHaveBeenCalledWith('test-dataset', expect.any(Array));

      const payload = mockIngest.mock.calls[0][1][0];
      expect(payload).toMatchObject({
        version: expect.any(String),
        instanceId: expect.any(String),
        level: 'info',
        message: expect.stringContaining('[v'),
        userId: 123,
        action: 'login'
      });
      expect(payload).toHaveProperty('timestamp');
      expect(payload).toHaveProperty('worker');

      // Ensure console was not called
      expect(consoleInfoSpy).not.toHaveBeenCalled();
    });

    test('logger.warn calls axiom.ingest with correct payload including version', async () => {
      const message = 'structured warn message';
      const data = { warning: 'deprecated' };

      await logger.warn(message, data);

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      expect(payload).toMatchObject({
        version: expect.any(String),
        instanceId: expect.any(String),
        level: 'warn',
        message: expect.stringContaining('[v'),
        warning: 'deprecated'
      });
    });

    test('logger.error calls axiom.ingest with correct payload including version', async () => {
      const message = 'structured error message';
      const error = new Error('test error');
      const data = { error };

      await logger.error(message, data);

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      expect(payload).toMatchObject({
        version: expect.any(String),
        instanceId: expect.any(String),
        level: 'error',
        message: expect.stringContaining('[v'),
        error: {
          name: 'Error',
          message: 'test error',
          stack: expect.any(String)
        }
      });
    });

    test('logger.debug calls axiom.ingest with correct payload including version', async () => {
      const message = 'structured debug message';
      const data = { debug: 'verbose' };

      await logger.debug(message, data);

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      expect(payload).toMatchObject({
        version: expect.any(String),
        instanceId: expect.any(String),
        level: 'debug',
        message: expect.stringContaining('[v'),
        debug: 'verbose'
      });
    });

    test('when axiom.ingest fails, retry and fallback to console + structured error', async () => {
      // Mock ingest to fail 3 times then succeed (or fail all)
      mockIngest.mockRejectedValue(new Error('Axiom ingest failed'));

      const message = 'test message';
      const data = { test: true };

      await logger.error(message, data);

      // Should retry 3 times (initial + 3 retries = 4 calls)
      expect(mockIngest).toHaveBeenCalledTimes(4);
      // Should log to console.error for the final failure
      expect(consoleErrorSpy).toHaveBeenCalledWith('Axiom ingest failed after retries:', 'Axiom ingest failed');
      // Should also call logger.error for structured fallback (which will try to ingest again, but since we're in test, it'll fallback to console)
      // The second logger.error call is from the fallback logic, which will also fail and log to console
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe('Lazy initialization', () => {
    test('Axiom is initialized only once on first log call', async () => {
      // Reset logger
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();

      // Configure Axiom
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      logger = loggerModule.logger;

      const callCountBefore = mockAxiomConstructor.mock.calls.length;

      // First call
      await logger.info('first call');

      // Second call
      await logger.debug('second call');

      // Third call
      await logger.warn('third call');

      const callCountAfter = mockAxiomConstructor.mock.calls.length;
      expect(callCountAfter - callCountBefore).toBe(1);
    });

    test('Axiom is not initialized when config is missing', async () => {
      // Ensure axiom config is not present
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = undefined;

      // Reset logger
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();

      logger = loggerModule.logger;

      const callCountBefore = mockAxiomConstructor.mock.calls.length;

      // Call logger
      await logger.info('test call');

      // Axiom should not be initialized
      const callCountAfter = mockAxiomConstructor.mock.calls.length;
      expect(callCountAfter - callCountBefore).toBe(0);
    });
  });

  describe('canSend method', () => {
    test('canSend method exists and returns true', () => {
      expect(typeof logger.canSend).toBe('function');
      expect(logger.canSend('info')).toBe(true);
      expect(logger.canSend('warn')).toBe(true);
      expect(logger.canSend('error')).toBe(true);
      expect(logger.canSend('debug')).toBe(true);
    });
  });

  describe('Telegram Console Proxy', () => {
    let enableTelegramConsoleProxy;
    let originalConsoleError;
    let originalConsoleWarn;
    let originalConsoleLog;

    beforeEach(async () => {
      // Import the proxy function
      const loggerModule = await import('../../src/services/logger.js');
      enableTelegramConsoleProxy = loggerModule.enableTelegramConsoleProxy;
      
      // Save original console methods
      originalConsoleError = console.error;
      originalConsoleWarn = console.warn;
      originalConsoleLog = console.log;
    });

    afterEach(() => {
      // Restore original console methods
      console.error = originalConsoleError;
      console.warn = originalConsoleWarn;
      console.log = originalConsoleLog;
    });

    test('proxy captures TIMEOUT in updates.js and calls logger.error with service: telegram', async () => {
      // Setup Axiom config
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };
      logger = loggerModule.logger;

      // Enable proxy
      enableTelegramConsoleProxy();

      // Mock console.error to capture the proxy call
      const mockConsoleError = jest.fn();
      console.error = mockConsoleError;

      // Simulate Telegram library error
      console.error('TIMEOUT in updates.js', 'some args');

      // Wait for async logger call
      await new Promise(resolve => setTimeout(resolve, 10));

      // Verify logger.error was called with correct payload
      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      expect(payload.level).toBe('error');
      expect(payload.service).toBe('telegram');
      expect(payload.source).toBe('console_proxy');
      expect(payload.message).toContain('Telegram library TIMEOUT captured');
      expect(payload.message).toContain('TIMEOUT in updates.js');
    });

    test('proxy captures timeout patterns and calls logger.error', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };
      logger = loggerModule.logger;

      enableTelegramConsoleProxy();
      const mockConsoleError = jest.fn();
      console.error = mockConsoleError;

      // Various timeout patterns
      console.error('ETIMEDOUT');
      console.error('ECONNRESET');
      console.error('Connection timed out');

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockIngest).toHaveBeenCalledTimes(3);
      mockIngest.mock.calls.forEach(call => {
        const payload = call[1][0];
        expect(payload.level).toBe('error');
        expect(payload.service).toBe('telegram');
        expect(payload.source).toBe('console_proxy');
      });
    });

    test('proxy does not capture non-timeout errors', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };
      logger = loggerModule.logger;

      enableTelegramConsoleProxy();
      const mockConsoleError = jest.fn();
      console.error = mockConsoleError;

      // Non-timeout error
      console.error('Some other error');

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should not call logger.error (no ingest)
      expect(mockIngest).not.toHaveBeenCalled();
    });
  });

  describe('Instance ID Fallback', () => {
    test('should use fallback ID when provider returns null', async () => {
      // Reset logger and set up Axiom config
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Set provider that returns null
      loggerModule.setInstanceIdProvider(() => null);
      
      logger = loggerModule.logger;

      await logger.info('test message');

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      
      // Should use fallback ID (starts with 'boot_')
      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider returns undefined', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Set provider that returns undefined
      loggerModule.setInstanceIdProvider(() => undefined);
      
      logger = loggerModule.logger;

      await logger.warn('test warning');

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      
      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider returns empty string', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Set provider that returns empty string
      loggerModule.setInstanceIdProvider(() => '');
      
      logger = loggerModule.logger;

      await logger.error('test error');

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      
      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider returns whitespace only', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Set provider that returns whitespace
      loggerModule.setInstanceIdProvider(() => '   ');
      
      logger = loggerModule.logger;

      await logger.debug('test debug');

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      
      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider returns "unknown"', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Set provider that returns 'unknown'
      loggerModule.setInstanceIdProvider(() => 'unknown');
      
      logger = loggerModule.logger;

      await logger.info('test message');

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      
      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider throws exception', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Set provider that throws
      loggerModule.setInstanceIdProvider(() => {
        throw new Error('Provider not ready');
      });
      
      logger = loggerModule.logger;

      await logger.info('test message');

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      
      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider returns non-string type', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Set provider that returns number
      loggerModule.setInstanceIdProvider(() => 12345);
      
      logger = loggerModule.logger;

      await logger.info('test message');

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      
      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should call console.debug when provider returns invalid value', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Set provider that returns null
      loggerModule.setInstanceIdProvider(() => null);
      
      logger = loggerModule.logger;

      await logger.info('test message');

      // Should have called console.debug with debug message
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        'Logger: Instance ID provider returned invalid value, using fallback',
        expect.objectContaining({
          received: null,
          fallback: expect.any(String)
        })
      );
    });

    test('should call console.debug when provider throws exception', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Set provider that throws
      loggerModule.setInstanceIdProvider(() => {
        throw new Error('Provider error');
      });
      
      logger = loggerModule.logger;

      await logger.info('test message');

      // Should have called console.debug with debug message
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        'Logger: Instance ID provider failed, using fallback',
        expect.objectContaining({
          error: 'Provider error',
          fallback: expect.any(String)
        })
      );
    });

    test('should use fallback ID when provider is not registered (before setInstanceIdProvider)', async () => {
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      const configModule = await import('../../src/config/index.js');
      configModule.config.axiom = {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
      };

      // Don't register provider, use default 'unknown' function
      logger = loggerModule.logger;

      await logger.info('test message');

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      
      // Default provider returns 'unknown', so should use fallback
      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });
  });

});