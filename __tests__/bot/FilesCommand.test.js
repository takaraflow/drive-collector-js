import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// --- Mocks ---
const mockClient = {
    sendMessage: jest.fn().mockResolvedValue({ id: 123 }),
};
const mockCloudTool = {
    listRemoteFiles: jest.fn(),
    isLoading: jest.fn().mockReturnValue(false)
};
const mockDriveRepository = {
    findByUserId: jest.fn().mockResolvedValue({ id: 1, type: 'mega' })
};
const mockUIHelper = {
    renderFilesPage: jest.fn().mockReturnValue({ text: 'file list', buttons: [] })
};
const mockSafeEdit = jest.fn();
const mockCacheService = {
    get: jest.fn(),
    set: jest.fn()
};

jest.unstable_mockModule('../../src/services/telegram.js', () => ({ client: mockClient }));
jest.unstable_mockModule('../../src/services/rclone.js', () => ({ CloudTool: mockCloudTool }));
jest.unstable_mockModule('../../src/repositories/DriveRepository.js', () => ({ DriveRepository: mockDriveRepository }));
jest.unstable_mockModule('../../src/ui/templates.js', () => ({ UIHelper: mockUIHelper }));
jest.unstable_mockModule('../../src/utils/common.js', () => ({
    safeEdit: mockSafeEdit,
    escapeHTML: (t) => t,
    getMediaInfo: jest.fn(),
    updateStatus: jest.fn()
}));
const mockPriority = { UI: 10, NORMAL: 0, LOW: -10, BACKGROUND: -20 };
global.PRIORITY = mockPriority; // 注入全局变量
jest.unstable_mockModule('../../src/utils/limiter.js', () => ({
    runBotTask: jest.fn((fn) => fn()),
    runBotTaskWithRetry: jest.fn((fn) => fn()),
    runMtprotoTask: jest.fn((fn) => fn()),
    runMtprotoTaskWithRetry: jest.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: jest.fn((fn) => fn()),
    PRIORITY: mockPriority
}));

// --- Import under test ---
const { Dispatcher } = await import('../../src/bot/Dispatcher.js');

describe('Dispatcher /files command', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should show loading immediately and then update with file list', async () => {
        const target = "chat123";
        const userId = "user456";
        const mockFiles = [{ name: 'file.txt' }];
        mockCloudTool.listRemoteFiles.mockResolvedValue(mockFiles);

        // 执行命令
        await Dispatcher._handleFilesCommand(target, userId);

        // 验证立即发送了加载消息
        expect(mockClient.sendMessage).toHaveBeenCalledWith(target, expect.objectContaining({
            message: expect.stringContaining("加载")
        }));

        // 验证异步获取了文件列表 (使用 setImmediate 确保异步任务运行)
        await new Promise(resolve => setImmediate(resolve));

        expect(mockCloudTool.listRemoteFiles).toHaveBeenCalledWith(userId);
        expect(mockUIHelper.renderFilesPage).toHaveBeenCalledWith(mockFiles, 0, 6, false);
        expect(mockSafeEdit).toHaveBeenCalledWith(target, 123, 'file list', [], userId);
    });

    it('should handle errors gracefully in async block', async () => {
        const target = "chat123";
        const userId = "user456";
        mockCloudTool.listRemoteFiles.mockRejectedValue(new Error("Network error"));

        await Dispatcher._handleFilesCommand(target, userId);

        await new Promise(resolve => setImmediate(resolve));

        expect(mockSafeEdit).toHaveBeenCalledWith(target, 123, expect.stringContaining("无法获取"), null, userId);
    });

    it('should send bind hint when no drive found', async () => {
        const target = "chat123";
        const userId = "user456";
        mockDriveRepository.findByUserId.mockResolvedValue(null);

        await Dispatcher._handleFilesCommand(target, userId);

        expect(mockClient.sendMessage).toHaveBeenCalledWith(target, expect.objectContaining({
            message: expect.stringContaining("网盘")
        }));
        expect(mockCloudTool.listRemoteFiles).not.toHaveBeenCalled();
    });
});