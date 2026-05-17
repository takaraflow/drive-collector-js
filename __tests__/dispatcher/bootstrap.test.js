const originalNodeEnv = process.env.NODE_ENV;

function createMocks() {
  const mockClient = {
    start: vi.fn(),
    disconnect: vi.fn(),
    addEventHandler: vi.fn()
  };

  return {
    telegram: {
      client: mockClient,
      getClient: vi.fn().mockResolvedValue(mockClient),
      saveSession: vi.fn(),
      clearSession: vi.fn(),
      resetClientSession: vi.fn(),
      setConnectionStatusCallback: vi.fn(),
      startTelegramWatchdog: vi.fn()
    },
    messageHandler: {
      MessageHandler: {
        handleEvent: vi.fn(),
        init: vi.fn()
      }
    },
    instanceCoordinator: {
      instanceCoordinator: {
        acquireLock: vi.fn(),
        hasLock: vi.fn()
      }
    },
    config: {
      config: {
        botToken: 'mock_token',
        ownerId: 'owner_id',
        redis: { url: 'redis://localhost:6379' }
      },
      getConfig: vi.fn().mockReturnValue({
        botToken: 'mock_token',
        ownerId: 'owner_id',
        redis: { url: 'redis://localhost:6379' }
      }),
      initConfig: vi.fn().mockResolvedValue({})
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      withModule: vi.fn().mockReturnThis(),
      withContext: vi.fn().mockReturnThis()
    }
  };
}

async function loadBootstrap() {
  const mocks = createMocks();

  vi.doMock('../../src/services/telegram.js', () => mocks.telegram);
  vi.doMock('../../src/dispatcher/MessageHandler.js', () => mocks.messageHandler);
  vi.doMock('../../src/services/InstanceCoordinator.js', () => mocks.instanceCoordinator);
  vi.doMock('../../src/config/index.js', () => mocks.config);
  vi.doMock('../../src/services/logger/index.js', () => ({
    default: mocks.logger,
    logger: mocks.logger,
    setInstanceIdProvider: vi.fn()
  }));

  const { startDispatcher } = await import('../../src/dispatcher/bootstrap.js');
  return { startDispatcher, ...mocks };
}

describe('Dispatcher Bootstrap', () => {
  let originalUncaughtExceptionListeners = [];

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    process.env.NODE_ENV = 'test';
    originalUncaughtExceptionListeners = process.listeners('uncaughtException');
  });

  afterEach(() => {
    for (const listener of process.listeners('uncaughtException')) {
      if (!originalUncaughtExceptionListeners.includes(listener)) {
        process.off('uncaughtException', listener);
      }
    }
    vi.doUnmock('../../src/services/telegram.js');
    vi.doUnmock('../../src/dispatcher/MessageHandler.js');
    vi.doUnmock('../../src/services/InstanceCoordinator.js');
    vi.doUnmock('../../src/config/index.js');
    vi.doUnmock('../../src/services/logger/index.js');
    vi.useRealTimers();
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  async function finishStartupTimers() {
    await vi.runOnlyPendingTimersAsync();
  }

  test('should start successfully when lock acquired', async () => {
    const { startDispatcher, telegram, instanceCoordinator, messageHandler } = await loadBootstrap();
    instanceCoordinator.instanceCoordinator.hasLock.mockResolvedValue(false);
    instanceCoordinator.instanceCoordinator.acquireLock.mockResolvedValue(true);
    telegram.client.start.mockResolvedValue();
    telegram.saveSession.mockResolvedValue();

    await startDispatcher();
    await finishStartupTimers();

    expect(instanceCoordinator.instanceCoordinator.acquireLock).toHaveBeenCalledWith(
      'telegram_client',
      90,
      expect.objectContaining({ maxAttempts: 5 })
    );
    expect(telegram.client.start).toHaveBeenCalledWith({ botAuthToken: 'mock_token' });
    expect(telegram.saveSession).toHaveBeenCalled();
    expect(telegram.client.addEventHandler).toHaveBeenCalled();
    expect(messageHandler.MessageHandler.init).toHaveBeenCalled();
  });

  test('should not start client when lock not acquired', async () => {
    const { startDispatcher, telegram, instanceCoordinator } = await loadBootstrap();
    instanceCoordinator.instanceCoordinator.hasLock.mockResolvedValue(false);
    instanceCoordinator.instanceCoordinator.acquireLock.mockResolvedValue(false);

    const result = await startDispatcher();
    await finishStartupTimers();

    expect(result).toBeNull();
    expect(telegram.getClient).not.toHaveBeenCalled();
    expect(telegram.client.start).not.toHaveBeenCalled();
    expect(telegram.client.addEventHandler).not.toHaveBeenCalled();
    expect(telegram.startTelegramWatchdog).not.toHaveBeenCalled();
  });

  test('should schedule bounded startup handoff retries outside tests', async () => {
    process.env.NODE_ENV = 'production';
    const { startDispatcher, telegram, instanceCoordinator, messageHandler } = await loadBootstrap();
    instanceCoordinator.instanceCoordinator.hasLock.mockResolvedValue(false);
    instanceCoordinator.instanceCoordinator.acquireLock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    telegram.client.start.mockResolvedValue();
    telegram.saveSession.mockResolvedValue();

    const result = await startDispatcher();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(result).toBeNull();
    expect(instanceCoordinator.instanceCoordinator.acquireLock).toHaveBeenCalledTimes(2);
    expect(telegram.client.start).toHaveBeenCalledWith({ botAuthToken: 'mock_token' });
    expect(messageHandler.MessageHandler.init).toHaveBeenCalled();
  });

  test('should handle AUTH_KEY_DUPLICATED error by resetting local session and retrying', async () => {
    const { startDispatcher, telegram, instanceCoordinator } = await loadBootstrap();
    instanceCoordinator.instanceCoordinator.acquireLock.mockResolvedValue(true);
    instanceCoordinator.instanceCoordinator.hasLock.mockResolvedValue(true);
    telegram.client.start
      .mockRejectedValueOnce({ code: 406, errorMessage: 'AUTH_KEY_DUPLICATED' })
      .mockResolvedValueOnce();
    telegram.clearSession.mockResolvedValue();
    telegram.resetClientSession.mockResolvedValue();

    await startDispatcher();
    await finishStartupTimers();

    expect(instanceCoordinator.instanceCoordinator.hasLock).toHaveBeenCalledWith(
      'telegram_client',
      expect.objectContaining({ logContention: false })
    );
    expect(telegram.resetClientSession).toHaveBeenCalled();
    expect(telegram.clearSession).not.toHaveBeenCalled();
    expect(telegram.client.start).toHaveBeenCalledTimes(2);
  });

  test('should stop retry if lock is lost during AUTH_KEY_DUPLICATED handling', async () => {
    const { startDispatcher, telegram, instanceCoordinator } = await loadBootstrap();
    instanceCoordinator.instanceCoordinator.acquireLock.mockResolvedValue(true);
    instanceCoordinator.instanceCoordinator.hasLock.mockResolvedValue(false);
    telegram.client.start.mockRejectedValueOnce({ code: 406, errorMessage: 'AUTH_KEY_DUPLICATED' });
    telegram.clearSession.mockResolvedValue();
    telegram.resetClientSession.mockResolvedValue();

    await startDispatcher();
    await finishStartupTimers();

    expect(instanceCoordinator.instanceCoordinator.hasLock).toHaveBeenCalledWith(
      'telegram_client',
      expect.objectContaining({ logContention: false })
    );
    expect(telegram.resetClientSession).not.toHaveBeenCalled();
    expect(telegram.clearSession).not.toHaveBeenCalled();
    expect(telegram.client.start).toHaveBeenCalledTimes(1);
  });

  test('should clear global session after repeated AUTH_KEY_DUPLICATED failures', async () => {
    const { startDispatcher, telegram, instanceCoordinator } = await loadBootstrap();
    instanceCoordinator.instanceCoordinator.acquireLock.mockResolvedValue(true);
    instanceCoordinator.instanceCoordinator.hasLock.mockResolvedValue(true);
    telegram.client.start
      .mockRejectedValueOnce({ code: 406, errorMessage: 'AUTH_KEY_DUPLICATED' })
      .mockRejectedValueOnce({ code: 406, errorMessage: 'AUTH_KEY_DUPLICATED' })
      .mockRejectedValueOnce({ code: 406, errorMessage: 'AUTH_KEY_DUPLICATED' });
    telegram.clearSession.mockResolvedValue();
    telegram.resetClientSession.mockResolvedValue();

    await startDispatcher();
    await finishStartupTimers();

    expect(telegram.resetClientSession).toHaveBeenCalledTimes(3);
    expect(telegram.clearSession).toHaveBeenCalled();
    expect(telegram.client.start).toHaveBeenCalledTimes(3);
  });

  test('should reconnect after connection loss while client is active', async () => {
    const { startDispatcher, telegram, instanceCoordinator } = await loadBootstrap();
    instanceCoordinator.instanceCoordinator.hasLock.mockResolvedValue(false);
    instanceCoordinator.instanceCoordinator.acquireLock.mockResolvedValue(true);
    telegram.client.start.mockResolvedValue();
    telegram.saveSession.mockResolvedValue();

    let connectionCallback;
    telegram.setConnectionStatusCallback.mockImplementation((callback) => {
      connectionCallback = callback;
    });

    await startDispatcher();
    await finishStartupTimers();
    connectionCallback(false);
    await vi.advanceTimersByTimeAsync(3000);

    expect(instanceCoordinator.instanceCoordinator.acquireLock).toHaveBeenCalledTimes(2);
  });

  test('should stop reconnecting after max connection retries', async () => {
    const { startDispatcher, telegram, instanceCoordinator } = await loadBootstrap();
    instanceCoordinator.instanceCoordinator.hasLock.mockResolvedValue(false);
    instanceCoordinator.instanceCoordinator.acquireLock.mockResolvedValue(true);
    telegram.client.start.mockResolvedValue();
    telegram.saveSession.mockResolvedValue();

    let connectionCallback;
    telegram.setConnectionStatusCallback.mockImplementation((callback) => {
      connectionCallback = callback;
    });

    await startDispatcher();
    await finishStartupTimers();

    for (let i = 0; i < 6; i++) {
      connectionCallback(false);
      await vi.advanceTimersByTimeAsync(3000);
    }

    expect(instanceCoordinator.instanceCoordinator.acquireLock).toHaveBeenCalledTimes(6);
  });

  test('should handle "Not connected" uncaught exception', async () => {
    const { startDispatcher, telegram, instanceCoordinator, logger } = await loadBootstrap();
    instanceCoordinator.instanceCoordinator.hasLock.mockResolvedValue(false);
    instanceCoordinator.instanceCoordinator.acquireLock.mockResolvedValue(true);
    telegram.client.start.mockResolvedValue();
    telegram.saveSession.mockResolvedValue();

    await startDispatcher();
    await finishStartupTimers();
    process.emit('uncaughtException', new Error('Not connected'));

    expect(logger.warn).toHaveBeenCalledWith("⚠️ 捕获到 'Not connected' 错误，正在重置客户端状态");
  });

  test('should start Telegram watchdog', async () => {
    const { startDispatcher, telegram, instanceCoordinator, logger } = await loadBootstrap();
    instanceCoordinator.instanceCoordinator.hasLock.mockResolvedValue(false);
    instanceCoordinator.instanceCoordinator.acquireLock.mockResolvedValue(true);
    telegram.client.start.mockResolvedValue();
    telegram.saveSession.mockResolvedValue();

    await startDispatcher();
    await finishStartupTimers();

    expect(telegram.startTelegramWatchdog).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('🐶 Telegram 看门狗已启动');
  });
});
