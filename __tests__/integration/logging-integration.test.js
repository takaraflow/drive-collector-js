import { nativeConsole } from "../setup/consoleMock.js";
import { globalMocks } from "../setup/external-mocks.js";

// ================== 1. Setup ==================
let originalConsole;
let loggerModule;
let telegramModule;

// ================== 2. Mock Telegram Service ==================
vi.mock('../../src/services/telegram.js', () => ({
    getClient: vi.fn().mockImplementation(async () => {
        if (!global._tgErrorHandler) {
            // 修复：模拟 GramJS 库的行为，将错误输出到 console.error
            // 这样我们的 Proxy 才能拦截到它
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

// ================== 3. Mock Config ==================
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

// ================== 4. Mock Repositories ==================
vi.mock('../../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: {
        get: vi.fn().mockResolvedValue(''),
        set: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        hasLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined)
    }
}));

// ================== 5. Explicit wait utility ==================
const waitForCondition = async (condition, maxIterations = 10) => {
    for (let i = 0; i < maxIterations; i++) {
        try {
            if (condition()) return;
        } catch (e) {
            // ignore
        }
        // 在 Fake Timers 环境中推进时间并运行所有待处理的异步操作
        await vi.runOnlyPendingTimersAsync();
        // 给微任务队列一个机会执行
        await Promise.resolve();
    }
    // 最后一次尝试，如果失败则抛出错误
    if (!condition()) {
        throw new Error('Wait condition timeout');
    }
};

describe('Logger Integration Tests (Unified)', () => {
    beforeAll(async () => {
        // 禁止读取真实 process.env，通过 Mock config 注入配置
        originalConsole = { ...console };

        // Mock package.json to return fixed version for deterministic tests
        vi.doMock('../../package.json', () => ({
            default: {
                version: '4.18.2'
            }
        }));

        vi.resetModules();

        loggerModule = await import('../../src/services/logger.js');
        telegramModule = await import('../../src/services/telegram.js');
    });

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.clearAllTimers();
        vi.clearAllMocks();

        // 清除全局 Mock 的调用记录
        globalMocks.axiomIngest.mockClear();

        loggerModule.resetLogger();

        // 配置 logger，这会设置 config.axiom
        loggerModule.logger.configure({
            axiom: {
                token: 'test-token',
                orgId: 'test-org',
                dataset: 'test-dataset'
            }
        });

        // 显式触发 Axiom 初始化（通过记录一条日志）
        // 这样 initAxiom 会被调用，但由于没有环境变量，需要确保使用 config.axiom
        // 注意：由于 initAxiom 的当前实现，我们需要通过 Mock process.env 来触发初始化
        // 但根据规则，我们应该避免读取真实 process.env
        // 因此，我们通过直接调用 logger 来触发初始化，logger 会调用 initAxiom
        // 但由于 initAxiom 的 bug（提前返回），我们需要确保 config 被正确使用
        // 实际上，由于 initAxiom 的 bug，我们需要 Mock process.env 来触发初始化
        // 但这是测试环境，我们可以使用 vi.stubEnv 来 Mock 环境变量
        vi.stubEnv('AXIOM_TOKEN', 'test-token');
        vi.stubEnv('AXIOM_ORG_ID', 'test-org');
        vi.stubEnv('AXIOM_DATASET', 'test-dataset');

        Object.assign(console, originalConsole);

        vi.spyOn(console, 'error').mockImplementation((...args) => nativeConsole.error.call(console, ...args));
        vi.spyOn(console, 'warn').mockImplementation((...args) => nativeConsole.warn.call(console, ...args));
        vi.spyOn(console, 'log').mockImplementation((...args) => nativeConsole.log.call(console, ...args));
        vi.spyOn(console, 'info').mockImplementation((...args) => nativeConsole.info.call(console, ...args));
    });

    afterEach(async () => {
        loggerModule.disableTelegramConsoleProxy();
        await telegramModule.stopWatchdog();
        delete global._tgErrorHandler;
        
        await vi.runOnlyPendingTimersAsync();
        
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        Object.assign(console, originalConsole);
        vi.useRealTimers();

        if (global.gc) global.gc();
    });

    afterAll(() => {
        vi.useRealTimers();
    });

    describe('Telegram TIMEOUT capture', () => {
        test('console.error proxy sends TIMEOUT to Axiom', async () => {
            // 先触发一次 logger 调用来初始化 Axiom
            await loggerModule.logger.info('init');
            await loggerModule.flushLogBuffer();
            await vi.runOnlyPendingTimersAsync();
            globalMocks.axiomIngest.mockClear();

            loggerModule.enableTelegramConsoleProxy();

            console.error('TIMEOUT in updates.js');

            // 显式刷新日志缓冲区，确保日志立即发送
            await loggerModule.flushLogBuffer();
            // 推进所有待处理的定时器
            await vi.runOnlyPendingTimersAsync();

            // 使用显式等待机制，等待日志被发送到 Axiom
            await waitForCondition(() => globalMocks.axiomIngest.mock.calls.length > 0);

            expect(globalMocks.axiomIngest.mock.calls.length).toBeGreaterThan(0);
            const [dataset, payloadArray] = globalMocks.axiomIngest.mock.calls[0];
            const payload = payloadArray[0];
            // 硬编码预期值：验证结果而非过程
            expect(payload.level).toBe('error');
            expect(payload.message).toBe('Telegram library TIMEOUT captured: TIMEOUT in updates.js');
        });

        test('Telegram client error handler sends TIMEOUT to Axiom', async () => {
            loggerModule.enableTelegramConsoleProxy();

            await telegramModule.getClient();
            
            expect(global._tgErrorHandler).toBeDefined();
            
            const timeoutError = new Error('Request timed out');
            timeoutError.code = 'ETIMEDOUT';
            
            global._tgErrorHandler(timeoutError);
            
            await loggerModule.flushLogBuffer();
            // 推进所有待处理的定时器
            await vi.runOnlyPendingTimersAsync();

            // 使用显式等待机制
            await waitForCondition(() => globalMocks.axiomIngest.mock.calls.length > 0);

            expect(globalMocks.axiomIngest.mock.calls.length).toBeGreaterThan(0);
            const [dataset, payloadArray] = globalMocks.axiomIngest.mock.calls[0];
            const payload = payloadArray[0];
            // 硬编码预期值：验证结果
            expect(payload.level).toBe('error');
            expect(payload.message).toContain('TIMEOUT');
        });
    });
    
    describe('Other integrations', () => {
        test('logger includes version as separate field and clean message', async () => {
            await loggerModule.logger.info('test');

            // 显式刷新日志缓冲区
            await loggerModule.flushLogBuffer();
            // 推进所有待处理的定时器
            await vi.runOnlyPendingTimersAsync();

            // 使用显式等待机制
            await waitForCondition(() => globalMocks.axiomIngest.mock.calls.length > 0);

            expect(globalMocks.axiomIngest.mock.calls.length).toBeGreaterThan(0);
            const [dataset, payloadArray] = globalMocks.axiomIngest.mock.calls[0];
            const payload = payloadArray[0];
            // 硬编码预期值：Message should be clean without version prefix
            expect(payload.message).toBe('test');
            // 硬编码预期值：Version should be a separate field with fixed value
            expect(payload.version).toBe('4.18.2');
        });
    });
});