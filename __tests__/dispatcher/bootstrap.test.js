import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.unstable_mockModule('../../src/services/telegram.js', () => ({
  client: {
    start: jest.fn(),
    disconnect: jest.fn(),
    addEventHandler: jest.fn(),
  },
  saveSession: jest.fn(),
  clearSession: jest.fn(),
  resetClientSession: jest.fn(),
  setConnectionStatusCallback: jest.fn(),
}));

jest.unstable_mockModule('../../src/dispatcher/MessageHandler.js', () => ({
  MessageHandler: {
    handleEvent: jest.fn(),
    init: jest.fn(),
  }
}));

jest.unstable_mockModule('../../src/services/InstanceCoordinator.js', () => ({
  instanceCoordinator: {
    acquireLock: jest.fn(),
    hasLock: jest.fn(),
  }
}));

jest.unstable_mockModule('../../src/config/index.js', () => ({
  config: {
    botToken: 'test-bot-token'
  }
}));

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.unstable_mockModule('../../src/services/logger.js', () => ({
  default: mockLogger
}));

const { startDispatcher } = await import('../../src/dispatcher/bootstrap.js');

describe('Dispatcher Bootstrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());
    jest.spyOn(global, 'setInterval').mockImplementation(() => {});
  });

  it('should start successfully when lock acquired', async () => {
    const { instanceCoordinator: mockInstanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    mockInstanceCoordinator.acquireLock.mockResolvedValue(true);

    const mockTelegram = await import('../../src/services/telegram.js');
    mockTelegram.client.start.mockResolvedValue();
    mockTelegram.saveSession.mockResolvedValue();

    const mockMessageHandler = await import('../../src/dispatcher/MessageHandler.js');

    await startDispatcher();

    expect(mockInstanceCoordinator.acquireLock).toHaveBeenCalledWith('telegram_client', 90);
    expect(mockTelegram.client.start).toHaveBeenCalledWith({ botAuthToken: 'test-bot-token' });
    expect(mockTelegram.saveSession).toHaveBeenCalled();
    expect(mockTelegram.client.addEventHandler).toHaveBeenCalled();
    expect(mockMessageHandler.MessageHandler.init).toHaveBeenCalled();
  });

  it('should not start client when lock not acquired', async () => {
    const { instanceCoordinator: mockInstanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
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
    expect(mockTelegram.clearSession).toHaveBeenCalled();
    expect(mockTelegram.resetClientSession).toHaveBeenCalled();
    expect(mockTelegram.client.start).toHaveBeenCalledTimes(2);
  });

  it('should stop retry if lock is lost during AUTH_KEY_DUPLICATED handling', async () => {
    const { instanceCoordinator: mockInstanceCoordinator } = await import('../../src/services/InstanceCoordinator.js');
    mockInstanceCoordinator.acquireLock.mockResolvedValue(true);
    // 立即失去锁
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
    // 不应该调用这些，因为在检查锁时就失败了
    expect(mockTelegram.clearSession).not.toHaveBeenCalled();
    expect(mockTelegram.resetClientSession).not.toHaveBeenCalled();
    // 应该只调用一次 start
    expect(mockTelegram.client.start).toHaveBeenCalledTimes(1);
  });
});