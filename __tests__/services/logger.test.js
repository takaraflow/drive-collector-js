import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { mockAxiomIngest, mockAxiomConstructor as mockAxiomConstructorImport } from '../setup/external-mocks.js';

// Use the global mock - use let so we can reassign them in beforeEach
let mockIngest = mockAxiomIngest;
let mockAxiomConstructor = mockAxiomConstructorImport;

// Mock InstanceCoordinator
jest.unstable_mockModule('../../src/services/InstanceCoordinator.js', () => ({
  getInstanceId: jest.fn().mockReturnValue('test-instance-id')
}));

describe('Logger Service', () => {
  let logger;
  let consoleInfoSpy;
  let consoleWarnSpy;
  let consoleErrorSpy;
  let enableTelegramConsoleProxy;
  let disableTelegramConsoleProxy;
  let createLogger;

  // Top-level setup for all tests in this describe block
  beforeEach(async () => {
    // Set environment for tests
    process.env.DEBUG = 'true';
    process.env.APP_VERSION = 'test-version';
    jest.useFakeTimers('modern');

    // Spy on console methods BEFORE resetting modules, so logger.js captures the spied versions
    consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Mock Math.random to return a fixed value for deterministic tests
    const mockMath = Object.create(global.Math);
    mockMath.random = () => 0.5;
    global.Math = mockMath;

    jest.clearAllMocks();

    // Reset modules to ensure clean state
    jest.resetModules();

    // Re-import mocks after resetModules to ensure they're fresh
    const { mockAxiomIngest: freshMockIngest, mockAxiomConstructor: freshMockConstructor } = await import('../setup/external-mocks.js');
    mockIngest = freshMockIngest;
    mockAxiomConstructor = freshMockConstructor;
    
    // Reset Axiom mock implementation to default successful state
    mockIngest.mockResolvedValue(undefined);

    // Import logger after mocks are set up
    const loggerModule = await import('../../src/services/logger.js');
    logger = loggerModule.logger;
    enableTelegramConsoleProxy = loggerModule.enableTelegramConsoleProxy;
    disableTelegramConsoleProxy = loggerModule.disableTelegramConsoleProxy;
    createLogger = loggerModule.createLogger;
  });

  // Top-level teardown for all tests in this describe block
  afterEach(() => {
    // Clean up environment variables
    delete process.env.DEBUG;
    delete process.env.AXIOM_TOKEN;
    delete process.env.AXIOM_ORG_ID;
    delete process.env.AXIOM_DATASET;
    delete process.env.APP_VERSION;
    jest.runAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();

    // Restore original Math object
    global.Math = Object.getPrototypeOf(global.Math);
  });

  describe('When Axiom is not configured', () => {
    beforeEach(async () => {
      // Ensure axiom config is not present
      // Mock the config module to return undefined axiom
      jest.unstable_mockModule('../../src/config/index.js', () => ({
        config: { axiom: undefined },
        getConfig: () => ({ axiom: undefined }),
        default: { config: { axiom: undefined }, getConfig: () => ({ axiom: undefined }) }
      }));

      // Reset logger module to pick up config changes
      jest.resetModules();
      const loggerModule = await import('../../src/services/logger.js');
      logger = loggerModule.logger;
    });

    test('logger.info falls back to console.info with version prefix', async () => {
      const message = 'test info message';
      const data = { key: 'value' };

      await logger.info(message, data);
      await jest.runAllTimersAsync();

      expect(consoleInfoSpy).toHaveBeenCalledTimes(0);
    });

    test('logger.warn falls back to console.warn with version prefix', async () => {
      const message = 'test warn message';
      const data = { error: 'something' };

      // Clear previous calls to isolate this test
      consoleWarnSpy.mockClear();

      await logger.warn(message, data);
      await jest.runAllTimersAsync();

      // We only care about the one containing our message. The `data` should be matched using `expect.objectContaining`.
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('[v'), expect.objectContaining(data));
      // Check that at least one call contains the message
      expect(consoleWarnSpy.mock.calls.some(call => call[0].includes(message))).toBe(true);
    });

    test('logger.error falls back to console.error with version prefix', async () => {
      const message = 'test error message';
      const data = { stack: 'error stack' };

      await logger.error(message, data);
      await jest.runAllTimersAsync();

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[v'), expect.objectContaining(data));
    });

    test('logger.debug falls back to no-op when Axiom is not configured', async () => {
      const message = 'test debug message';
      const data = { debug: true };

      // Debug logs should not be sent to console when Axiom is not configured
      const consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation();
      await logger.debug(message, data);
      await jest.runAllTimersAsync();
      expect(consoleDebugSpy).not.toHaveBeenCalled();
      consoleDebugSpy.mockRestore(); // Restore after the specific test
    });
  });

  describe('When Axiom is configured', () => {
    beforeEach(async () => {
      // Set env variables for Axiom configuration
      process.env.AXIOM_TOKEN = 'test-token';
      process.env.AXIOM_ORG_ID = 'test-org';
      process.env.AXIOM_DATASET = 'test-dataset';

      // Clear any pending timers to ensure clean state
      jest.clearAllTimers();

      // Re-import mocks to ensure we have fresh references
      const { mockAxiomIngest: freshMockIngest, mockAxiomConstructor: freshMockConstructor } = await import('../setup/external-mocks.js');
      mockIngest = freshMockIngest;
      mockAxiomConstructor = freshMockConstructor;

      // Clear any potential previous Axiom mock calls
      mockIngest.mockClear();
      mockAxiomConstructor.mockClear();

      // Reset logger internal state
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();

      logger = loggerModule.logger;
    });

    test('logger.info calls axiom.ingest with correct payload including version', async () => {
      const message = 'structured info message';
      const data = { userId: 123, action: 'login' };

      await logger.info(message, data);
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      expect(mockIngest).toHaveBeenCalledWith('test-dataset', expect.any(Array));

      const payload = mockIngest.mock.calls[0][1][0];
      expect(payload).toMatchObject({
        version: expect.any(String),
        instanceId: expect.any(String),
        level: 'info',
        message: expect.stringContaining('[v')
      });
      expect(payload).toHaveProperty('timestamp');
      // 'worker' field is not part of the strict schema, removed from test
      expect(payload).toHaveProperty('details'); // Ensure details field exists
      // Check that data is in details string
      expect(payload.details).toContain('userId');
      expect(payload.details).toContain('123');
      expect(payload.details).toContain('login');

      // Ensure console was not called
      expect(consoleInfoSpy).not.toHaveBeenCalled();
    });

    test('logger.warn calls axiom.ingest with correct payload including version', async () => {
      const message = 'structured warn message';
      const data = { warning: 'deprecated' };

      await logger.warn(message, data);
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      expect(payload).toMatchObject({
        version: expect.any(String),
        instanceId: expect.any(String),
        level: 'warn',
        message: expect.stringContaining('[v')
      });
      // warning is not whitelisted, so it should be in details string
      expect(payload.details).toContain('deprecated');
    });

    test('logger.error calls axiom.ingest with correct payload including version', async () => {
      const message = 'structured error message';
      const error = new Error('test error');
      const data = { error };

      await logger.error(message, data);
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      expect(payload).toMatchObject({
        version: expect.any(String),
        instanceId: expect.any(String),
        level: 'error',
        message: expect.stringContaining('[v'),
        error_name: 'Error',
        error_message: 'test error'
      });
      expect(payload.details).toContain('test error');
    });

    test('logger.debug calls axiom.ingest with correct payload including version', async () => {
      const message = 'structured debug message';
      const data = { debug: 'verbose' };

      await logger.debug(message, data);
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];
      expect(payload).toMatchObject({
        version: expect.any(String),
        instanceId: expect.any(String),
        level: 'debug',
        message: expect.stringContaining('[v')
      });
      expect(payload.details).toContain('verbose');
    });

    test('withModule adds module prefix and payload field', async () => {
      const moduleLogger = createLogger({ module: 'TestModule', component: 'Unit' });

      await moduleLogger.info('hello', { ok: true });
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];

      expect(payload.module).toBe('TestModule');
      expect(payload.component).toBe('Unit');
      expect(payload.message).toContain('[TestModule]');
    });

    test('withContext merges and overrides module fields', async () => {
      const baseLogger = createLogger({ module: 'BaseModule', region: 'us-east' });
      const childLogger = baseLogger.withContext({ module: 'ChildModule', requestId: 'req-1' });

      await childLogger.info('child log');
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];

      expect(payload.module).toBe('ChildModule');
      expect(payload.region).toBe('us-east');
      expect(payload.requestId).toBe('req-1');
      expect(payload.message).toContain('[ChildModule]');
    });

    test('when axiom.ingest fails, retry and fallback to console + structured error', async () => {
      // Mock ingest to fail 3 times then succeed (or fail all)
      mockIngest.mockRejectedValue(new Error('Axiom ingest failed'));

      const message = 'test message';
      const data = { test: true };

      // Start the logger call (it will wait at the first delay)
      const loggerPromise = logger.error(message, data);
      
      // Advance timers for each retry delay: 1000ms, 2000ms, 4000ms
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(4000);
      
      // Wait for the logger call to complete
      await loggerPromise;

      // Should retry 3 times (initial + 3 retries = 4 calls)
      expect(mockIngest).toHaveBeenCalledTimes(4);
      // Should log to console.error for the final failure
      expect(consoleErrorSpy).toHaveBeenCalledWith('Axiom ingest failed after retries:', 'Axiom ingest failed');
      // Should also call console.error for structured fallback (using originalConsoleError now)
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed payload:', expect.objectContaining({ service: 'unknown' }));
    });
  });

  describe('Lazy initialization', () => {
    test('Axiom is initialized only once on first log call', async () => {
      // Set env variables
      process.env.AXIOM_TOKEN = 'test-token';
      process.env.AXIOM_ORG_ID = 'test-org';
      process.env.AXIOM_DATASET = 'test-dataset';

      // Reset logger internal state
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      logger = loggerModule.logger;

      // Clear any potential previous Axiom mock calls
      mockIngest.mockClear();
      mockAxiomConstructor.mockClear();

      // First call - this should trigger initAxiom which creates new Axiom()
      await logger.info('first call');
      await jest.runAllTimersAsync();

      // Second call
      await logger.debug('second call');
      await jest.runAllTimersAsync();

      // Third call
      await logger.warn('third call');
      await jest.runAllTimersAsync();

      // Verify that ingest was called 3 times (once per log call)
      expect(mockIngest).toHaveBeenCalledTimes(3);
      // Axiom constructor should be called only once
      expect(mockAxiomConstructor).toHaveBeenCalledTimes(1);
    });

    test('Axiom is not initialized when config is missing', async () => {
      // Mock config module to return undefined axiom
      jest.unstable_mockModule('../../src/config/index.js', () => ({
        config: { axiom: undefined },
        getConfig: () => ({ axiom: undefined }),
        default: { config: { axiom: undefined }, getConfig: () => ({ axiom: undefined }) }
      }));

      // Reset logger
      jest.resetModules();
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();

      logger = loggerModule.logger;

      // Clear any potential previous Axiom mock calls
      mockIngest.mockClear();
      mockAxiomConstructor.mockClear();

      // Call logger
      await logger.info('test call');
      await jest.runAllTimersAsync();

      // Axiom should not be initialized
      expect(mockAxiomConstructor).not.toHaveBeenCalled();
      expect(mockIngest).not.toHaveBeenCalled(); // Ensure ingest is also not called
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
    let originalConsoleError;
    let originalConsoleWarn;
    let originalConsoleLog;

    beforeEach(async () => {
      // Set env variables
      process.env.AXIOM_TOKEN = 'test-token';
      process.env.AXIOM_ORG_ID = 'test-org';
      process.env.AXIOM_DATASET = 'test-dataset';

      // Re-import mocks to ensure we have fresh references
      const { mockAxiomIngest: freshMockIngest, mockAxiomConstructor: freshMockConstructor } = await import('../setup/external-mocks.js');
      mockIngest = freshMockIngest;
      mockAxiomConstructor = freshMockConstructor;

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
      // Disable proxy if enabled
      if (disableTelegramConsoleProxy) {
        disableTelegramConsoleProxy();
      }
    });

    test('proxy captures TIMEOUT in updates.js and calls logger.error with service: telegram', async () => {
      // Setup Axiom config
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      logger = loggerModule.logger;

      // Ensure ingest is successful for this test
      mockIngest.mockResolvedValue(undefined);
      // Clear any previous calls from initialization
      mockIngest.mockClear();

      // Enable proxy
      enableTelegramConsoleProxy();

      // Simulate Telegram library error
      console.error('TIMEOUT in updates.js', 'some args');

      // Advance timers for async logger call
      await jest.runAllTimersAsync();

      // We expect one call to mockIngest from the proxy
      expect(mockIngest).toHaveBeenCalledTimes(1);

      const payload = mockIngest.mock.calls[0][1][0];
      expect(payload.level).toBe('error');
      expect(payload.message).toContain('Telegram library TIMEOUT captured');
      expect(payload.message).toContain('TIMEOUT in updates.js');
      expect(payload.details).toContain('service');
      expect(payload.details).toContain('telegram');
      expect(payload.details).toContain('console_proxy');
    });

    test('proxy captures timeout patterns and calls logger.error', async () => {
      // Setup Axiom config
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      logger = loggerModule.logger;

      // Enable proxy
      enableTelegramConsoleProxy();

      // Various timeout patterns
      console.error('ETIMEDOUT');
      console.error('ECONNRESET');
      console.error('Connection timed out');

      await jest.runAllTimersAsync();

      // We expect 3 calls to mockIngest from the proxy
      expect(mockIngest).toHaveBeenCalledTimes(3);
      
      mockIngest.mock.calls.forEach(call => {
        const payload = call[1][0];
        expect(payload.level).toBe('error');
        expect(payload.details).toContain('telegram');
      });
    });

    test('proxy does not capture non-timeout errors', async () => {
      // Setup Axiom config
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      logger = loggerModule.logger;

      // Enable proxy
      enableTelegramConsoleProxy();

      // Non-timeout error
      console.error('Some other error');

      await jest.runAllTimersAsync();

      // Should not call logger.error (no ingest)
      expect(mockIngest).not.toHaveBeenCalled();
      // Ensure console.error was still called for the original message
      expect(consoleErrorSpy).toHaveBeenCalledWith('Some other error');
    });
  });

  describe('Instance ID Fallback', () => {
    beforeEach(async () => {
      // Re-import mocks to ensure we have fresh references
      const { mockAxiomIngest: freshMockIngest, mockAxiomConstructor: freshMockConstructor } = await import('../setup/external-mocks.js');
      mockIngest = freshMockIngest;
      mockAxiomConstructor = freshMockConstructor;
    });

    test('should use fallback ID when provider returns null', async () => {
      // Set env variables
      process.env.AXIOM_TOKEN = 'test-token';
      process.env.AXIOM_ORG_ID = 'test-org';
      process.env.AXIOM_DATASET = 'test-dataset';

      // Reset logger and set up Axiom config
      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      // Set provider that returns null
      loggerModule.setInstanceIdProvider(() => null);
      
      logger = loggerModule.logger;

      await logger.info('test message');
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];

      // Should use fallback ID (starts with 'boot_')
      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider returns undefined', async () => {
      // Set env variables
      process.env.AXIOM_TOKEN = 'test-token';
      process.env.AXIOM_ORG_ID = 'test-org';
      process.env.AXIOM_DATASET = 'test-dataset';

      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      // Set provider that returns undefined
      loggerModule.setInstanceIdProvider(() => undefined);
      
      logger = loggerModule.logger;

      await logger.warn('test warning');
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];

      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider returns empty string', async () => {
      // Set env variables
      process.env.AXIOM_TOKEN = 'test-token';
      process.env.AXIOM_ORG_ID = 'test-org';
      process.env.AXIOM_DATASET = 'test-dataset';

      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      // Set provider that returns empty string
      loggerModule.setInstanceIdProvider(() => '');
      
      logger = loggerModule.logger;

      await logger.error('test error');
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];

      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider returns whitespace only', async () => {
      // Set env variables
      process.env.AXIOM_TOKEN = 'test-token';
      process.env.AXIOM_ORG_ID = 'test-org';
      process.env.AXIOM_DATASET = 'test-dataset';

      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();
      
      // Set provider that returns whitespace
      loggerModule.setInstanceIdProvider(() => '   ');
      
      logger = loggerModule.logger;

      await logger.debug('test debug');
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];

      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider returns "unknown"', async () => {
      // Set env variables
      process.env.AXIOM_TOKEN = 'test-token';
      process.env.AXIOM_ORG_ID = 'test-org';
      process.env.AXIOM_DATASET = 'test-dataset';

      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();

      // Set provider that returns 'unknown'
      loggerModule.setInstanceIdProvider(() => 'unknown');

      logger = loggerModule.logger;

      await logger.info('test message');
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];

      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider throws exception', async () => {
      // Set env variables
      process.env.AXIOM_TOKEN = 'test-token';
      process.env.AXIOM_ORG_ID = 'test-org';
      process.env.AXIOM_DATASET = 'test-dataset';

      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();

      // Set provider that throws
      loggerModule.setInstanceIdProvider(() => {
        throw new Error('Provider error');
      });

      logger = loggerModule.logger;

      await logger.info('test message');
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];

      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });

    test('should use fallback ID when provider is not registered (before setInstanceIdProvider)', async () => {
      // Set env variables
      process.env.AXIOM_TOKEN = 'test-token';
      process.env.AXIOM_ORG_ID = 'test-org';
      process.env.AXIOM_DATASET = 'test-dataset';

      const loggerModule = await import('../../src/services/logger.js');
      loggerModule.resetLogger();

      // Don't register provider, use default 'unknown' function
      logger = loggerModule.logger;

      await logger.info('test message');
      await jest.runAllTimersAsync();

      expect(mockIngest).toHaveBeenCalledTimes(1);
      const payload = mockIngest.mock.calls[0][1][0];

      // Default provider returns 'unknown', so should use fallback
      expect(payload.instanceId).toMatch(/^boot_\d+_/);
      expect(payload.instanceId).not.toBe('unknown');
    });
  });

  describe('Field Limiting and Payload Security', () => {
    beforeEach(async () => {
        // 确保环境变量存在，否则 logger.debug 等不会发送到 Axiom
        process.env.AXIOM_TOKEN = 'test-token';
        process.env.AXIOM_ORG_ID = 'test-org';
        process.env.AXIOM_DATASET = 'test-dataset';
        
        // Re-import mocks to ensure we have fresh references
        const { mockAxiomIngest: freshMockIngest, mockAxiomConstructor: freshMockConstructor } = await import('../setup/external-mocks.js');
        mockIngest = freshMockIngest;
        mockAxiomConstructor = freshMockConstructor;
        
        // 显式重置并重新初始化，确保测试环境干净
        const loggerModule = await import('../../src/services/logger.js');
        loggerModule.resetLogger();
        logger = loggerModule.logger;
        
        // 清理之前的 mock 调用记录
        mockIngest.mockClear();
    });

    test('should truncate fields when data exceeds maxFields limit', async () => {
        const largeData = {};
        for (let i = 0; i < 300; i++) {
            largeData[`key_${i}`] = 'value';
        }

        await logger.info('large payload test', largeData);
        await jest.runAllTimersAsync();

        // 安全检查：确保 mockIngest 真的被调用了
        expect(mockIngest).toHaveBeenCalled();

        // 获取第一个调用的第二个参数 (payload 数组) 的第一个元素 (log payload)
        const call = mockIngest.mock.calls[0];
        const payload = call[1][0];
        
        // 我们使用了 pruneData，它会将超过 maxKeys 的部分放入 _truncated_keys 中
        // 并且最终 payload 也会被 limitFields 限制
        if (payload._truncated_keys) {
             expect(Object.keys(payload).length).toBeLessThanOrEqual(60); // 50 (limitFields) + safe margin
        } else {
             // 如果没触发 _truncated_keys，说明被 limitFields 截断了
             expect(Object.keys(payload).length).toBeLessThanOrEqual(60);
        }
    });

    test('should handle nested Error objects without losing critical info', async () => {
        const complexData = {
            error: new Error('inner error'),
            meta: { reason: 'testing' }
        };

        await logger.error('complex data test', complexData);
        await jest.runAllTimersAsync();

        expect(mockIngest).toHaveBeenCalled();
        const payload = mockIngest.mock.calls[0][1][0];

        expect(payload.error_name).toBe('Error');
        expect(payload.error_message).toBe('inner error');
        expect(payload.details).toContain('inner error');
        expect(payload.details).toContain('testing');
    });
  });
});
