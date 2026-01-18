import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- 1. Mocks Setup ---

// Mock Logger
const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => mockLogger,
    withModule: () => mockLogger
};
vi.mock('../../src/services/logger/index.js', () => ({
    logger: mockLogger
}));

// Mock Config
const mockConfig = { ownerId: '1001' };
vi.mock('../../src/config/index.js', () => ({
    config: mockConfig
}));

// Mock Telegram Client
const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
    invoke: vi.fn(),
    connected: true
};
vi.mock('../../src/services/telegram.js', () => ({
    client: mockClient,
    isClientActive: () => true
}));

// Mock AuthGuard
// 使用 vi.hoisted 确保 mock 变量在 vi.mock 之前被初始化
const mockAuthGuard = vi.hoisted(() => ({
    getRole: vi.fn(),
    can: vi.fn(),
    setRole: vi.fn()
}));

vi.mock('../../src/modules/AuthGuard.js', () => ({
    AuthGuard: mockAuthGuard
}));

// Mock SettingsRepository (控制维护模式)
const mockSettingsRepo = {
    get: vi.fn().mockResolvedValue('public')
};
vi.mock('../../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: mockSettingsRepo
}));

// Mock DriveRepository
const mockDriveRepository = {
    findByUserId: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(null)
};
vi.mock('../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: mockDriveRepository
}));

// Mock DriveConfigFlow (拦截后的业务逻辑)
const mockDriveFlow = {
    sendDriveManager: vi.fn().mockResolvedValue(true),
    handleUnbind: vi.fn().mockResolvedValue(true)
};
vi.mock('../../src/modules/DriveConfigFlow.js', () => ({
    DriveConfigFlow: mockDriveFlow
}));

// Mock Other Dependencies
vi.mock('../../src/modules/SessionManager.js', () => ({ SessionManager: { get: vi.fn().mockResolvedValue(null) } }));
vi.mock('../../src/processor/TaskManager.js', () => ({ TaskManager: {} }));
vi.mock('../../src/processor/LinkParser.js', () => ({ LinkParser: { parse: vi.fn() } }));
vi.mock('../../src/ui/templates.js', () => ({ UIHelper: {} }));
vi.mock('../../src/services/rclone.js', () => ({ CloudTool: {} }));
vi.mock('../../src/utils/common.js', () => ({ 
    safeEdit: vi.fn(),
    escapeHTML: (str) => str // Mock escapeHTML to return string as-is
}));
vi.mock('../../src/utils/limiter.js', () => ({ 
    runBotTaskWithRetry: async (fn) => fn(),
    PRIORITY: { UI: 1 } 
}));
vi.mock('../../src/utils/NetworkDiagnostic.js', () => ({ NetworkDiagnostic: {} }));
vi.mock('../../src/services/InstanceCoordinator.js', () => ({ instanceCoordinator: { hasLock: vi.fn().mockResolvedValue(true), getInstanceId: () => 'test' } }));
vi.mock('../../src/services/CacheService.js', () => ({ cache: {} }));
vi.mock('../../src/services/QueueService.js', () => ({ queueService: {} }));
vi.mock('../../src/services/MediaGroupBuffer.js', () => ({ default: { restore: vi.fn() } }));
vi.mock('fs', () => ({ default: { readFileSync: () => JSON.stringify({ version: '1.0.0' }) } }));
vi.mock('path', () => ({ default: { join: () => '' } }));

// Import Dispatcher
const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');
import { AuthGuard as ImportedAuthGuard } from '../../src/modules/AuthGuard.js';

describe('Dispatcher Permission Guard', () => {
    it('Debug: Ensure mocks are consistent', () => {
        expect(ImportedAuthGuard).toBe(mockAuthGuard);
        expect(ImportedAuthGuard.can).toBe(mockAuthGuard.can);
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.ownerId = '1001';
        // Reset default behaviors
        mockAuthGuard.getRole.mockResolvedValue('user');
        mockAuthGuard.can.mockResolvedValue(true); // Default allow
        mockSettingsRepo.get.mockResolvedValue('public');
    });

    // Helper to create message event
    const createMessageEvent = (userId, text) => ({
        className: 'UpdateNewMessage',
        message: {
            message: text,
            senderId: userId,
            peerId: { userId },
            fromId: { userId }
        }
    });

    describe('Global Blacklist Guard', () => {
        it('should silently ignore messages from BANNED users', async () => {
            mockAuthGuard.getRole.mockResolvedValue('banned');
            
            await Dispatcher.handle(createMessageEvent('999', '/start'));

            expect(mockClient.sendMessage).not.toHaveBeenCalled();
            expect(mockDriveFlow.sendDriveManager).not.toHaveBeenCalled();
        });
    });

    describe('Maintenance Mode Guard', () => {
        it('should block NORMAL user in maintenance mode', async () => {
            mockAuthGuard.getRole.mockResolvedValue('user');
            // user cannot bypass maintenance
            mockAuthGuard.can.mockImplementation(async (uid, perm) => {
                if (perm === 'maintenance:bypass') return false;
                return true;
            });
            mockSettingsRepo.get.mockResolvedValue('private'); // Maintenance Mode

            await Dispatcher.handle(createMessageEvent('999', '/start'));

            expect(mockClient.sendMessage).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    message: expect.stringContaining('维护中')
                })
            );
        });

        it('should allow ADMIN in maintenance mode', async () => {
            mockAuthGuard.getRole.mockResolvedValue('admin');
            // admin CAN bypass maintenance
            mockAuthGuard.can.mockImplementation(async (uid, perm) => {
                return true;
            });
            mockSettingsRepo.get.mockResolvedValue('private');

            await Dispatcher.handle(createMessageEvent('888', '/start'));
            
            expect(mockClient.sendMessage).toHaveBeenCalled();
            const args = mockClient.sendMessage.mock.calls[0];
            console.log('SendMessage Args:', JSON.stringify(args, null, 2));
            
            // Should send welcome message, NOT maintenance message
            expect(args[1].message).toContain('欢迎');
        });
    });

    describe('RBAC Middleware (Command Level)', () => {
        beforeEach(() => {
            mockSettingsRepo.get.mockResolvedValue('public');
            mockAuthGuard.getRole.mockResolvedValue('user');
        });

        it('should allow User to access /drive (drive:edit permission)', async () => {
            // User now has drive:edit permission
            mockAuthGuard.can.mockImplementation(async (uid, perm) => {
                if (perm === 'drive:edit') return true;
                return false;
            });

            await Dispatcher.handle(createMessageEvent('999', '/drive'));

            expect(mockDriveFlow.sendDriveManager).toHaveBeenCalled();
            expect(mockClient.sendMessage).not.toHaveBeenCalled();
        });

        it('should block User from accessing /diagnosis (system:admin permission)', async () => {
            // User does NOT have system:admin
            mockAuthGuard.can.mockImplementation(async (uid, perm) => {
                if (perm === 'system:admin') return false;
                return true;
            });

            await Dispatcher.handle(createMessageEvent('999', '/diagnosis'));

            expect(mockClient.sendMessage).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    message: expect.stringContaining('无权限')
                })
            );
        });

        it('should allow Admin to access /diagnosis', async () => {
            mockAuthGuard.getRole.mockResolvedValue('admin');
            mockAuthGuard.can.mockImplementation(async (uid, perm) => {
                if (perm === 'system:admin') return true;
                return true;
            });

            await Dispatcher.handle(createMessageEvent('888', '/diagnosis'));

            // Should send diagnosis executing message
            expect(mockClient.sendMessage).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    message: expect.stringContaining('正在执行系统诊断')
                })
            );
        });
    });
});
