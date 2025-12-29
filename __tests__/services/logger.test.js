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

      expect(consoleDebugSpy).toHaveBeenCalledTimes(1);
      expect(consoleDebugSpy).toHaveBeenCalledWith(expect.stringContaining('[v'), data);
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

    test('when axiom.ingest fails, console.error is called', async () => {
      mockIngest.mockRejectedValueOnce(new Error('Axiom ingest failed'));

      const message = 'test message';
      const data = { test: true };

      await logger.error(message, data);

      expect(mockIngest).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith('Axiom ingest error:', 'Axiom ingest failed');
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

});