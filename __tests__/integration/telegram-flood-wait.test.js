import { jest, describe, it, expect, beforeEach, afterEach, beforeAll } from '@jest/globals';

// --- 1. Define Mock Data ---

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
};

const mockConfig = {
    botToken: 'fake-token',
    apiId: 12345,
    apiHash: 'fake-hash',
    _isMock: true
};

const mockInstanceCoordinator = {
    hasLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(true)
};

const mockSettingsRepository = {
    get: jest.fn().mockResolvedValue(''),
    set: jest.fn().mockResolvedValue(true)
};

const mockClient = {
    connect: jest.fn(),
    start: jest.fn(),
    disconnect: jest.fn(),
    session: {
        save: jest.fn().mockReturnValue('mock-session')
    },
    connected: false,
    on: jest.fn(),
    addEventHandler: jest.fn(),
    getMe: jest.fn()
};

// --- 2. Register Mocks (Before Imports) ---

jest.unstable_mockModule('../../src/services/logger.js', () => ({
    default: mockLogger,
    logger: mockLogger,
    enableTelegramConsoleProxy: jest.fn()
}));

jest.unstable_mockModule('../../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: mockSettingsRepository
}));

jest.unstable_mockModule('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: mockInstanceCoordinator
}));

jest.unstable_mockModule('../../src/config/index.js', () => ({
    getConfig: jest.fn(() => mockConfig),
    initConfig: jest.fn().mockResolvedValue(mockConfig),
    config: mockConfig,
    isInitialized: true,
    validateConfig: jest.fn().mockReturnValue(true),
    getRedisConnectionConfig: jest.fn().mockReturnValue({ url: '', options: {} })
}));

jest.unstable_mockModule('telegram', () => ({
    TelegramClient: jest.fn(() => mockClient)
}));

jest.unstable_mockModule('telegram/sessions/index.js', () => ({
    StringSession: jest.fn()
}));

// --- 3. Import Variables ---
let connectAndStart, getCircuitBreakerState, resetCircuitBreaker, TelegramErrorClassifier;

beforeAll(async () => {
    // Set Env Vars
    process.env.API_ID = '12345';
    process.env.API_HASH = 'fake-hash';
    process.env.BOT_TOKEN = 'fake-token';
    process.env.NODE_ENV = 'test';

    // Import Config first
    const configModule = await import('../../src/config/index.js');
    await configModule.initConfig();

    // Verify Mock
    const config = configModule.getConfig();
    if (!config._isMock) {
        console.warn('[Test Setup] WARNING: Real config detected. Mock may have failed.');
    }

    // Import Telegram Service
    const telegramModule = await import('../../src/services/telegram.js');
    connectAndStart = telegramModule.connectAndStart;
    getCircuitBreakerState = telegramModule.getCircuitBreakerState;
    resetCircuitBreaker = telegramModule.resetCircuitBreaker;

    // Import Error Classifier
    const classifierModule = await import('../../src/services/telegram-error-classifier.js');
    TelegramErrorClassifier = classifierModule.TelegramErrorClassifier;
});

describe('Telegram Flood Wait Handling', () => {
    beforeEach(async () => {
        jest.useFakeTimers();
        jest.clearAllMocks();

        // Reset Client State
        mockClient.connected = false;
        mockClient.connect.mockReset();
        mockClient.start.mockReset();

        // Reset Circuit Breaker
        if (resetCircuitBreaker) {
            resetCircuitBreaker();
        }
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it('should handle FloodWaitError during connect/start', async () => {
        // Ensure dependencies are loaded
        expect(connectAndStart).toBeDefined();
        expect(getCircuitBreakerState).toBeDefined();

        const floodError = new Error('A wait of 100 seconds is required');
        floodError.code = 420;
        floodError.seconds = 100;
        floodError.errorMessage = 'FLOOD';

        // Setup rejection logic inside the test
        mockClient.connect.mockRejectedValueOnce(floodError);

        // The function should reject
        await expect(connectAndStart()).rejects.toThrow();

        // Verify error was logged correctly
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.stringContaining('Telegram Flood Wait Detected during connect/start'),
            expect.objectContaining({ waitSeconds: 100 })
        );

        // Verify Circuit Breaker opened
        const state = getCircuitBreakerState();
        expect(state.state).toBe('OPEN');
        expect(state.errorStats[TelegramErrorClassifier.ERROR_TYPES.FLOOD]).toBe(1);
    });

    it('should handle FloodWaitError during start (authorization) phase', async () => {
        const floodError = new Error('FLOOD_WAIT during start');
        floodError.code = 420;
        floodError.seconds = 60;
        floodError.errorMessage = 'FLOOD';

        // 1. 连接成功，但在 start 阶段报错
        mockClient.connect.mockResolvedValueOnce(undefined);
        mockClient.start.mockRejectedValueOnce(floodError);

        // 2. 验证抛出错误
        await expect(connectAndStart()).rejects.toThrow();

        // 3. 验证熔断器打开
        const state = getCircuitBreakerState();
        expect(state.state).toBe('OPEN');
        expect(state.errorStats[TelegramErrorClassifier.ERROR_TYPES.FLOOD]).toBe(1);
    });

    it('should calculate correct wait time based on error.seconds', async () => {
        const floodError = new Error('A wait of 50 seconds is required');
        floodError.code = 420;
        floodError.seconds = 50;

        mockClient.connect.mockRejectedValueOnce(floodError);

        await expect(connectAndStart()).rejects.toThrow();

        const state = getCircuitBreakerState();
        expect(state.state).toBe('OPEN');

        // Fast forward time past the wait duration (50s + buffer)
        jest.advanceTimersByTime(55000);

        // Verify it attempts recovery
        expect(mockLogger.info).toHaveBeenCalledWith(
            expect.stringContaining('Circuit breaker: Attempting recovery')
        );
    });

    it('should recover successfully and reset state to CLOSED after wait time', async () => {
        const floodError = new Error('Flood');
        floodError.code = 420;
        floodError.seconds = 30;

        // 1. 首次调用失败，熔断器打开
        mockClient.connect.mockRejectedValueOnce(floodError);
        await expect(connectAndStart()).rejects.toThrow();
        
        expect(getCircuitBreakerState().state).toBe('OPEN');

        // 2. 快进时间超过等待时间 (30s + buffer)
        jest.advanceTimersByTime(35000);

        // 3. 此时重试应该成功（Mock 恢复正常）
        mockClient.connect.mockResolvedValueOnce(undefined);
        // 确保 start 也不报错
        mockClient.start.mockResolvedValueOnce(undefined); 

        await expect(connectAndStart()).resolves.not.toThrow();

        // 4. 【关键验证】验证熔断器状态已重置为 CLOSED
        expect(getCircuitBreakerState().state).toBe('CLOSED');
    });

    it('should prevent immediate retry when circuit breaker is OPEN due to Flood', async () => {
        const floodError = new Error('Flood Wait');
        floodError.code = 420;
        floodError.seconds = 300;
        mockClient.connect.mockRejectedValueOnce(floodError);

        // First call opens the breaker
        await expect(connectAndStart()).rejects.toThrow();

        // Second immediate call should fail due to OPEN breaker
        await expect(connectAndStart()).rejects.toThrow(/Circuit breaker OPEN/);
        
        // Ensure we only tried to connect once (the breaker blocked the second)
        expect(mockClient.connect).toHaveBeenCalledTimes(1);
    });
});
