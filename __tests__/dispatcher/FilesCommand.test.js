// --- Mocks ---
const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
};
const mockCloudTool = {
    listRemoteFiles: vi.fn(),
    isLoading: vi.fn().mockReturnValue(false)
};
const mockDriveRepository = {
    findByUserId: vi.fn().mockResolvedValue({ id: 1, type: 'mega' })
};
const mockUIHelper = {
    renderFilesPage: vi.fn().mockResolvedValue({ text: 'file list', buttons: [] })
};
const mockSafeEdit = vi.fn();
const mockCacheService = {
    get: vi.fn(),
    set: vi.fn()
};

vi.mock('../../src/services/telegram.js', () => ({
  client: mockClient,
  isClientActive: vi.fn(() => true),
  getUpdateHealth: vi.fn(() => ({
    lastUpdate: 1699970000000,
    timeSince: 30000
  }))
}));
vi.mock('../../src/services/rclone.js', () => ({ CloudTool: mockCloudTool }));
vi.mock('../../src/repositories/DriveRepository.js', () => ({ DriveRepository: mockDriveRepository }));
vi.mock('../../src/ui/templates.js', () => ({ UIHelper: mockUIHelper }));
vi.mock('../../src/config/index.js', () => ({
    getConfig: vi.fn().mockReturnValue({ nodeEnv: 'test' }),
    config: { nodeEnv: 'test' }
}));
vi.mock('../../src/utils/common.js', () => ({
    safeEdit: mockSafeEdit,
    escapeHTML: (t) => t,
    getMediaInfo: vi.fn(),
    updateStatus: vi.fn()
}));
const mockPriority = { UI: 10, NORMAL: 0, LOW: -10, BACKGROUND: -20 };
global.PRIORITY = mockPriority; // 注入全局变量
vi.mock('../../src/utils/limiter.js', () => ({
    runBotTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoTask: vi.fn((fn) => fn()),
    runMtprotoTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: mockPriority
}));

// --- Import under test ---
const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');

describe('Dispatcher /files command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDriveRepository.findByUserId.mockResolvedValue([{ id: 1, type: 'mega' }]);
        mockCloudTool.isLoading.mockReturnValue(false);
        Dispatcher.filesRefreshTimes.clear();
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
        expect(mockUIHelper.renderFilesPage).toHaveBeenCalledWith(mockFiles, 0, 6, false, userId);
        expect(mockSafeEdit).toHaveBeenCalledWith(target, 123, 'file list', [], userId);
    });

    it('should handle errors gracefully in async block', async () => {
        const target = "chat123";
        const userId = "user456";
        mockCloudTool.listRemoteFiles.mockRejectedValue(new Error("Network error"));

        await Dispatcher._handleFilesCommand(target, userId);

        await new Promise(resolve => setImmediate(resolve));

        expect(mockSafeEdit).toHaveBeenCalledWith(target, 123, expect.stringContaining("无法获取"), expect.any(Array), userId);
        const buttons = mockSafeEdit.mock.calls[0][3];
        expect(buttons[0][0].text).toContain("重新加载");
        expect(buttons[0][0].data.toString()).toBe("files_refresh_0");
    });

    it('should send bind hint when no drive found', async () => {
        const target = "chat123";
        const userId = "user456";
        mockDriveRepository.findByUserId.mockResolvedValue(null);

        await Dispatcher._handleFilesCommand(target, userId);

        // Wait for async operations to complete
        await new Promise(resolve => setImmediate(resolve));

        expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
        expect(mockSafeEdit).toHaveBeenCalledWith(target, 123, expect.stringContaining("网盘"), expect.any(Array), userId);
        const buttons = mockSafeEdit.mock.calls[0][3];
        expect(buttons[0][0].text).toContain("绑定网盘");
        expect(buttons[0][0].data.toString()).toBe("drive_select_type");
        expect(mockCloudTool.listRemoteFiles).not.toHaveBeenCalled();
    });

    it('should refresh a file page and keep rate limiting scoped by user and message', async () => {
        const target = "chat123";
        const userId = "user456";
        const answer = vi.fn();
        mockCloudTool.listRemoteFiles.mockResolvedValue([{ Name: 'movie.mp4', Size: 1, ModTime: '2024-01-01T00:00:00Z' }]);

        await Dispatcher._handleFilesCallback(
            { userId: target, msgId: 321 },
            'files_refresh_1',
            userId,
            answer
        );

        expect(mockCloudTool.listRemoteFiles).toHaveBeenCalledWith(userId, true);
        expect(mockUIHelper.renderFilesPage).toHaveBeenCalledWith(expect.any(Array), 1, 6, false, userId);
        expect(mockSafeEdit).toHaveBeenLastCalledWith(target, 321, 'file list', [], userId);
        expect(answer).toHaveBeenLastCalledWith('刷新成功');

        await Dispatcher._handleFilesCallback(
            { userId: target, msgId: 321 },
            'files_refresh_1',
            userId,
            answer
        );

        expect(mockCloudTool.listRemoteFiles).toHaveBeenCalledTimes(1);
        expect(answer).toHaveBeenLastCalledWith(expect.stringContaining('刷新太快'));

        await Dispatcher._handleFilesCallback(
            { userId: target, msgId: 322 },
            'files_refresh_1',
            userId,
            answer
        );

        expect(mockCloudTool.listRemoteFiles).toHaveBeenCalledTimes(2);
    });
});
