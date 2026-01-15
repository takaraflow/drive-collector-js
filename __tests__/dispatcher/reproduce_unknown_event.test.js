// Mock config
await vi.doMock('../../src/config/index.js', () => ({
    config: {
        ownerId: '12345'
    }
}));

// Mock telegram.js
await vi.doMock('../../src/services/telegram.js', () => ({
    client: {
        session: { save: () => '' },
        getMe: vi.fn().mockResolvedValue({ id: 'bot123' }),
        invoke: vi.fn().mockResolvedValue({}),
        connected: true
    },
    isClientActive: () => true
}));

// Mock Dispatcher
await vi.doMock('../../src/dispatcher/Dispatcher.js', () => ({
    Dispatcher: {
        handle: vi.fn().mockResolvedValue(true)
    }
}));

// Mock InstanceCoordinator
await vi.doMock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        acquireLock: vi.fn().mockResolvedValue(true)
    }
}));

// Mock logger to verify output
await vi.doMock('../../src/services/logger/index.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        logger: {
            info: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            withModule: vi.fn().mockReturnThis(),
            withContext: vi.fn().mockReturnThis()
        }
    };
});

const { MessageHandler } = await import('../../src/dispatcher/MessageHandler.js');
const { logger } = await import('../../src/services/logger/index.js');

describe('Reproduce Unknown Event Logging', () => {
    let mockClient;

    beforeEach(() => {
        vi.clearAllMocks();
        MessageHandler.botId = 'bot123';
        mockClient = {
            session: { save: () => 'mock_session' },
            getMe: vi.fn().mockResolvedValue({ id: 'bot123' }),
            invoke: vi.fn().mockResolvedValue({}),
            connected: true
        };
    });

    it('should log "unknown" for events without id, queryId, and className', async () => {
        const event = {
            someRandomField: 'random'
        };

        await MessageHandler.handleEvent(event, mockClient);

        // Verify PERF log shows unknown (now logged as debug)
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('消息 unknown 分发完成'));

        // Verify debug log contains details
        expect(logger.debug).toHaveBeenCalledWith("收到未知类型事件，详细内容:", expect.objectContaining({
            keys: expect.arrayContaining(['someRandomField'])
        }));
    });

    it('should log className if available but no ID', async () => {
        const event = {
            className: 'UpdateUserStatus',
            userId: 'user123',
            status: { className: 'UserStatusOnline' }
        };

        await MessageHandler.handleEvent(event, mockClient);

        // Verify PERF log shows [UpdateUserStatus]
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('消息 [UpdateUserStatus] 分发完成'));
        
        // Should NOT trigger unknown debug log
        const debugCalls = logger.debug.mock.calls.filter(call => call[0] === "收到未知类型事件，详细内容:");
        expect(debugCalls.length).toBe(0);
    });
});
