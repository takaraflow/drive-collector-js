import { jest } from '@jest/globals';

// Mock config
await jest.unstable_mockModule('../../src/config/index.js', () => ({
    config: {
        ownerId: '12345'
    }
}));

// Mock telegram.js
await jest.unstable_mockModule('../../src/services/telegram.js', () => ({
    client: {
        session: { save: () => '' },
        getMe: jest.fn().mockResolvedValue({ id: 'bot123' }),
        invoke: jest.fn().mockResolvedValue({}),
        connected: true
    },
    isClientActive: () => true
}));

// Mock Dispatcher
await jest.unstable_mockModule('../../src/dispatcher/Dispatcher.js', () => ({
    Dispatcher: {
        handle: jest.fn().mockResolvedValue(true)
    }
}));

// Mock InstanceCoordinator
await jest.unstable_mockModule('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        acquireLock: jest.fn().mockResolvedValue(true)
    }
}));

// Mock logger to verify output
await jest.unstable_mockModule('../../src/services/logger.js', () => ({
    logger: {
        info: jest.fn(),
        debug: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}));

const { MessageHandler } = await import('../../src/dispatcher/MessageHandler.js');
const { logger } = await import('../../src/services/logger.js');

describe('Reproduce Unknown Event Logging', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        MessageHandler.botId = 'bot123';
        mockClient = {
            session: { save: () => 'mock_session' },
            getMe: jest.fn().mockResolvedValue({ id: 'bot123' }),
            invoke: jest.fn().mockResolvedValue({}),
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
        expect(logger.debug).toHaveBeenCalledWith("[MessageHandler] 收到未知类型事件，详细内容:", expect.objectContaining({
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
        const debugCalls = logger.debug.mock.calls.filter(call => call[0] === "[MessageHandler] 收到未知类型事件，详细内容:");
        expect(debugCalls.length).toBe(0);
    });
});
