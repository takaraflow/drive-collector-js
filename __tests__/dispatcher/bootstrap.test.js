vi.mock('../../src/services/telegram.js', () => {
  const mockClient = {
    start: vi.fn(),
    disconnect: vi.fn(),
    addEventHandler: vi.fn(),
  };
  
  return {
    client: mockClient,
    getClient: vi.fn().mockResolvedValue(mockClient),
    saveSession: vi.fn(),
    clearSession: vi.fn(),
    resetClientSession: vi.fn(),
    setConnectionStatusCallback: vi.fn(),
  };
});

vi.mock('../../src/dispatcher/MessageHandler.js', () => ({
  MessageHandler: {
    handleEvent: vi.fn(),
    init: vi.fn(),
  }
}));

vi.mock('../../src/services/InstanceCoordinator.js', () => ({
  instanceCoordinator: {
    acquireLock: vi.fn(),
    hasLock: vi.fn(),
  }
}));

vi.mock('../../src/config/index.js', () => ({
  config: {
    botToken: 'test-bot-token'
  }
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  withModule: vi.fn().mockReturnThis(),
  withContext: vi.fn().mockReturnThis()
};

vi.mock('../../src/services/logger/index.js', () => ({
   default: mockLogger,
   logger: mockLogger
}));

// Mock config/index.js explicitly
vi.mock('../../src/config/index.js', () => ({
  config: {
    botToken: 'mock_token',
    ownerId: 'owner_id',
    redis: {
      url: 'redis://localhost:6379'
    }
  },
  getConfig: vi.fn().mockReturnValue({
    botToken: 'mock_token',
    ownerId: 'owner_id',
    redis: {
      url: 'redis://localhost:6379'
    }
  }),
  initConfig: vi.fn().mockResolvedValue({})
}));

const { startDispatcher } = await import('../../src/dispatcher/bootstrap.js');

describe('Dispatcher Bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());
    vi.spyOn(global, 'setInterval').mockImplementation(() => {});
  });

  it('should start successfully when lock acquired', async () => {
    const { instanceCoordinator: mockInstanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    mockInstanceCoordinator.hasLock.mockResolvedValue(false);
    mockInstanceCoordinator.acquireLock.mockResolvedValue(true);

    const mockTelegram = await import('../../src/services/telegram.js');
    mockTelegram.client.start.mockResolvedValue();
    mockTelegram.saveSession.mockResolvedValue();

    const mockMessageHandler = await import('../../src/dispatcher/MessageHandler.js');

    await startDispatcher();

    expect(mockInstanceCoordinator.acquireLock).toHaveBeenCalledWith('telegram_client', 90, expect.objectContaining({ maxAttempts: 5 }));
    expect(mockTelegram.client.start).toHaveBeenCalledWith({ botAuthToken: 'mock_token' });
    expect(mockTelegram.saveSession).toHaveBeenCalled();
    expect(mockTelegram.client.addEventHandler).toHaveBeenCalled();
    expect(mockMessageHandler.MessageHandler.init).toHaveBeenCalled();
  });

  it('should not start client when lock not acquired', async () => {
    const { instanceCoordinator: mockInstanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    mockInstanceCoordinator.hasLock.mockResolvedValue(false);
    mockInstanceCoordinator.acquireLock.mockResolvedValue(false);

    const mockTelegram = await import('../../src/services/telegram.js');

    await startDispatcher();

    expect(mockTelegram.client.start).not.toHaveBeenCalled();
  });

  it('should handle AUTH_KEY_DUPLICATED error by clearing session and retry', async () => {
    const { instanceCoordinator: mockInstanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    mockInstanceCoordinator.acquireLock.mockResolvedValue(true);
    mockInstanceCoordinator.hasLock.mockResolvedValue(true);

    const mockTelegram = await import('../../src/services/telegram.js');
    mockTelegram.client.start
      .mockRejectedValueOnce({
        code: 406,
        errorMessage: 'AUTH_KEY_DUPLICATED'
      })
      .mockResolvedValueOnce();

    mockTelegram.clearSession.mockResolvedValue();
    mockTelegram.resetClientSession.mockResolvedValue();

    await startDispatcher();

    expect(mockInstanceCoordinator.hasLock).toHaveBeenCalledWith("telegram_client");
    // resetClientSession 应该被调用（本地重置）
    expect(mockTelegram.resetClientSession).toHaveBeenCalled();
    // clearSession 在第一次重试成功时不应该被调用
    expect(mockTelegram.clearSession).not.toHaveBeenCalled();
    expect(mockTelegram.client.start).toHaveBeenCalledTimes(2);
  });

  it('should stop retry if lock is lost during AUTH_KEY_DUPLICATED handling', async () => {
    const { instanceCoordinator: mockInstanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    mockInstanceCoordinator.acquireLock.mockResolvedValue(true);
    // 在检查锁时立即失去锁
    mockInstanceCoordinator.hasLock.mockResolvedValue(false);

    const mockTelegram = await import('../../src/services/telegram.js');
    mockTelegram.client.start
      .mockRejectedValueOnce({
        code: 406,
        errorMessage: 'AUTH_KEY_DUPLICATED'
      });

    mockTelegram.clearSession.mockResolvedValue();
    mockTelegram.resetClientSession.mockResolvedValue();

    await startDispatcher();

    expect(mockInstanceCoordinator.hasLock).toHaveBeenCalledWith("telegram_client");
    // 在检查锁时就失败了，不应该调用 resetClientSession
    expect(mockTelegram.resetClientSession).not.toHaveBeenCalled();
    expect(mockTelegram.clearSession).not.toHaveBeenCalled();
    // 应该只调用一次 start
    expect(mockTelegram.client.start).toHaveBeenCalledTimes(1);
  });

  it('should clear global session after multiple AUTH_KEY_DUPLICATED failures', async () => {
    const { instanceCoordinator: mockInstanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    mockInstanceCoordinator.acquireLock.mockResolvedValue(true);
    mockInstanceCoordinator.hasLock.mockResolvedValue(true);

    const mockTelegram = await import('../../src/services/telegram.js');
    // 模拟三次失败
    mockTelegram.client.start
      .mockRejectedValueOnce({
        code: 406,
        errorMessage: 'AUTH_KEY_DUPLICATED'
      })
      .mockRejectedValueOnce({
        code: 406,
        errorMessage: 'AUTH_KEY_DUPLICATED'
      })
      .mockRejectedValueOnce({
        code: 406,
        errorMessage: 'AUTH_KEY_DUPLICATED'
      });

    mockTelegram.clearSession.mockResolvedValue();
    mockTelegram.resetClientSession.mockResolvedValue();

    await startDispatcher();

    expect(mockInstanceCoordinator.hasLock).toHaveBeenCalledWith("telegram_client");
    // resetClientSession 应该被调用三次（每次失败都调用）
    expect(mockTelegram.resetClientSession).toHaveBeenCalledTimes(3);
    // clearSession 应该在第三次重试失败后被调用（retryCount = 3，达到 maxRetries）
    expect(mockTelegram.clearSession).toHaveBeenCalled();
    // 三次失败后，retryCount = 3，不满足 retryCount < maxRetries，循环退出
    expect(mockTelegram.client.start).toHaveBeenCalledTimes(3);
  });
});