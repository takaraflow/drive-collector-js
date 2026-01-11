import { vi } from 'vitest';

const createMockLogger = () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withModule: vi.fn().mockImplementation(function() { return this; }),
    withContext: vi.fn().mockImplementation(function() { return this; }),
    configure: vi.fn(),
    isInitialized: vi.fn().mockReturnValue(true),
    canSend: vi.fn().mockReturnValue(true),
    flush: vi.fn().mockResolvedValue(undefined),
    getProviderName: vi.fn().mockReturnValue('MockLogger'),
    getConnectionInfo: vi.fn().mockReturnValue({ provider: 'MockLogger', connected: true })
});

const mockLogger = createMockLogger();

vi.mock('./src/services/logger/index.js', () => ({
    default: mockLogger,
    logger: mockLogger,
    LoggerService: class MockLoggerService {
        getInstance() { return mockLogger; }
        info() {}
        warn() {}
        error() {}
        debug() {}
        withModule() { return mockLogger; }
        withContext() { return mockLogger; }
    },
    setInstanceIdProvider: vi.fn(),
    enableTelegramConsoleProxy: vi.fn(),
    disableTelegramConsoleProxy: vi.fn(),
    flushLogBuffer: vi.fn().mockResolvedValue(undefined),
    createLogger: () => mockLogger,
    BaseLogger: class MockBaseLogger {},
    AxiomLogger: class MockAxiomLogger {},
    ConsoleLogger: class MockConsoleLogger {},
    DatadogLogger: class MockDatadogLogger {}
}));
