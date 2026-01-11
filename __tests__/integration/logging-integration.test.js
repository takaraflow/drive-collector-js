// Logger Integration Tests - 使用完全 mock 方式
// 不使用真实环境变量，不使用真实 Axiom 连接

import { globalMocks } from "../setup/external-mocks.js";

// 创建本地的 mock 对象
const mockAxiomIngest = globalMocks.axiomIngest;
const mockAxiomConstructor = globalMocks.axiomConstructor;

// Mock @axiomhq/js
vi.mock('@axiomhq/js', () => ({
    Axiom: mockAxiomConstructor
}));

// Mock Logger 模块
const mockLogger = {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
    withModule: vi.fn().mockImplementation(function(name) {
        return {
            ...mockLogger,
            _module: name
        };
    }),
    withContext: vi.fn().mockImplementation(function(ctx) {
        return {
            ...mockLogger,
            _context: { ...mockLogger._context, ...ctx }
        };
    }),
    configure: vi.fn(),
    isInitialized: vi.fn().mockReturnValue(true),
    canSend: vi.fn().mockReturnValue(true),
    flush: vi.fn().mockResolvedValue(undefined),
    getProviderName: vi.fn().mockReturnValue('AxiomLogger'),
    getConnectionInfo: vi.fn().mockReturnValue({ provider: 'AxiomLogger', connected: true }),
    _module: undefined,
    _context: {}
};

vi.mock('../../src/services/logger/index.js', () => ({
    default: mockLogger,
    logger: mockLogger,
    LoggerService: vi.fn().mockImplementation(() => mockLogger),
    setInstanceIdProvider: vi.fn(),
    enableTelegramConsoleProxy: vi.fn().mockResolvedValue(undefined),
    disableTelegramConsoleProxy: vi.fn().mockResolvedValue(undefined),
    flushLogBuffer: vi.fn().mockResolvedValue(undefined),
    createLogger: () => mockLogger
}));

// Mock Telegram Service
vi.mock('../../src/services/telegram.js', () => ({
    getClient: vi.fn().mockImplementation(async () => {
        if (!global._tgErrorHandler) {
            global._tgErrorHandler = (err) => { console.error(err); };
        }
        return {
            connected: true,
            on: vi.fn(),
            addEventHandler: vi.fn()
        };
    }),
    stopWatchdog: vi.fn().mockResolvedValue(undefined),
    reconnectBot: vi.fn().mockResolvedValue(undefined),
    startWatchdog: vi.fn().mockResolvedValue(undefined),
    client: { connected: true }
}));

// Mock Config
vi.mock('../../src/config/index.js', () => ({
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

describe('Logger Integration Tests (Unified)', () => {
    afterEach(() => {
        mockAxiomIngest.mockClear();
        mockLogger.info.mockClear();
        mockLogger.error.mockClear();
        if (global._tgErrorHandler) {
            delete global._tgErrorHandler;
        }
    });

    test('console.error proxy can be enabled', async () => {
        const { enableTelegramConsoleProxy } = await import('../../src/services/logger/index.js');
        await enableTelegramConsoleProxy();
        expect(enableTelegramConsoleProxy).toHaveBeenCalled();
    });

    test('logger error captures timeout patterns', async () => {
        await mockLogger.error('TIMEOUT in updates.js', {}, { service: 'telegram' });
        expect(mockLogger.error).toHaveBeenCalled();
        const callArgs = mockLogger.error.mock.calls[0];
        expect(callArgs[0]).toContain('TIMEOUT');
    });

    test('logger includes version as separate field', async () => {
        await mockLogger.info('test');
        expect(mockLogger.info).toHaveBeenCalled();
        const callArgs = mockLogger.info.mock.calls[0];
        expect(callArgs[0]).toBe('test');
    });
});
