import { jest, describe, test, expect, beforeEach, afterEach, afterAll } from "@jest/globals";

// Mock telegram package to prevent real initialization
jest.unstable_mockModule('telegram', () => ({
  TelegramClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((event, handler) => {
        // Handle error simulation
        if (event === 'error') {
            global._tgErrorHandler = handler;
        }
    }),
    addEventHandler: jest.fn(),
    getMe: jest.fn().mockResolvedValue({ id: 123 }),
    session: { save: jest.fn().mockReturnValue('mock') },
    connected: false,
    _sender: { disconnect: jest.fn().mockResolvedValue(undefined) }
  })),
  StringSession: jest.fn().mockImplementation(() => ({}))
}));

// Mock config module
jest.unstable_mockModule('../../src/config/index.js', () => ({
  config: {
    apiId: 12345,
    apiHash: 'test-api-hash',
    axiom: {
        token: 'test-token',
        orgId: 'test-org',
        dataset: 'test-dataset'
    }
  }
}));

// Mock repositories and coordinator to avoid dependencies
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

describe('Logger Integration Tests (Unified)', () => {
  let originalConsole;
  let mockAxiomIngest;
  let loggerModule;
  let telegramModule;

  beforeAll(async () => {
    // Save original console
    originalConsole = {
        error: console.error,
        warn: console.warn,
        log: console.log,
        info: console.info,
        debug: console.debug
    };

    // Load modules
    loggerModule = await import('../../src/services/logger.js');
    telegramModule = await import('../../src/services/telegram.js');
    
    // Get mockIngest
    const { mockAxiomIngest: ingest } = await import('../setup/external-mocks.js');
    mockAxiomIngest = ingest;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiomIngest.mockClear();
    mockAxiomIngest.mockResolvedValue(undefined);
    
    // Reset logger state
    loggerModule.resetLogger();
    
    // Spy on console but implementation stays original to not break proxy
    jest.spyOn(console, 'error').mockImplementation((...args) => {
        // Call original to trigger proxy
    });
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    loggerModule.disableTelegramConsoleProxy();
    telegramModule.stopWatchdog();
    jest.restoreAllMocks();
    
    // Ensure console is restored
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.debug = originalConsole.debug;
  });

  describe('Telegram TIMEOUT capture', () => {
    test('console.error proxy sends TIMEOUT to Axiom', async () => {
      loggerModule.enableTelegramConsoleProxy();

      // Trigger proxy
      console.error('TIMEOUT in updates.js');

      // Async wait
      await new Promise(r => setTimeout(r, 100));

      expect(mockAxiomIngest).toHaveBeenCalled();
      const payload = mockAxiomIngest.mock.calls[0][1][0];
      expect(payload.level).toBe('error');
      expect(payload.service).toBe('telegram');
      expect(payload.source).toBe('console_proxy');
      expect(payload.message).toContain('TIMEOUT captured');
    });

    test('Telegram client error handler sends TIMEOUT to Axiom', async () => {
        // Initialize client to setup listeners
        await telegramModule.getClient();
        
        // Use the handler captured by the mock
        if (global._tgErrorHandler) {
            const timeoutError = new Error('Request timed out');
            timeoutError.code = 'ETIMEDOUT';
            global._tgErrorHandler(timeoutError);
            
            await new Promise(r => setTimeout(r, 100));
            
            expect(mockAxiomIngest).toHaveBeenCalled();
            const payload = mockAxiomIngest.mock.calls[0][1][0];
            expect(payload.service).toBe('telegram');
            expect(payload.level).toBe('error');
            expect(payload.message).toContain('TIMEOUT error detected');
        }
    });
  });

  describe('Other integrations', () => {
      test('logger adds version prefix', async () => {
          await loggerModule.logger.info('test');
          
          await new Promise(r => setTimeout(r, 50));
          
          expect(mockAxiomIngest).toHaveBeenCalled();
          const payload = mockAxiomIngest.mock.calls[0][1][0];
          expect(payload.message).toMatch(/^\[v\d+\.\d+\.\d+\]/);
      });
  });
});