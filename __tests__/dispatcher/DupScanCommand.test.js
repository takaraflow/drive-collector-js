// --- Mocks ---
const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 555 })
};

const mockDriveRepository = {
    findByUserId: vi.fn().mockResolvedValue([{ id: 'd1', name: 'Mega-a', type: 'mega' }]),
    getDefaultDrive: vi.fn().mockResolvedValue({ id: 'd1', name: 'Mega-a', type: 'mega' })
};

const mockScanner = {
    resolveDrives: vi.fn(),
    scanDrive: vi.fn(),
    readScanState: vi.fn(),
    writeScanState: vi.fn(),
    requestCancel: vi.fn()
};

const mockUIHelper = {
    renderDupScanPage: vi.fn().mockReturnValue({ text: 'dupe list', buttons: [['b']] })
};

const mockSafeEdit = vi.fn();

vi.mock('../../src/services/telegram.js', () => ({
    client: mockClient,
    isClientActive: vi.fn(() => true)
}));

vi.mock('../../src/repositories/DriveRepository.js', () => ({ DriveRepository: mockDriveRepository }));

vi.mock('../../src/services/DuplicateScanner.js', () => ({
    resolveDrives: mockScanner.resolveDrives,
    scanDrive: mockScanner.scanDrive,
    readScanState: mockScanner.readScanState,
    writeScanState: mockScanner.writeScanState,
    requestCancel: mockScanner.requestCancel
}));

vi.mock('../../src/ui/templates.js', () => ({ UIHelper: mockUIHelper }));

vi.mock('../../src/config/index.js', () => ({
    getConfig: vi.fn().mockReturnValue({ nodeEnv: 'test', ownerId: null }),
    config: { nodeEnv: 'test' }
}));

vi.mock('../../src/utils/common.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        safeEdit: mockSafeEdit,
        escapeHTML: (s) => String(s ?? '')
    };
});

const mockPriority = { UI: 10, NORMAL: 0, LOW: -10, BACKGROUND: -20 };
vi.mock('../../src/utils/limiter.js', () => ({
    runBotTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoTask: vi.fn((fn) => fn()),
    runMtprotoTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: mockPriority
}));

const { Dispatcher } = await import('../../src/dispatcher/Dispatcher.js');

const flush = () => new Promise(resolve => setImmediate(resolve));

describe('Dispatcher /scan_dup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockDriveRepository.findByUserId.mockResolvedValue([{ id: 'd1', name: 'Mega-a', type: 'mega' }]);
        mockDriveRepository.getDefaultDrive.mockResolvedValue({ id: 'd1', name: 'Mega-a', type: 'mega' });
        mockScanner.resolveDrives.mockResolvedValue([{ id: 'd1', name: 'Mega-a', type: 'mega' }]);
        mockScanner.readScanState.mockResolvedValue(null);
        mockScanner.writeScanState.mockResolvedValue({});
        mockUIHelper.renderDupScanPage.mockReturnValue({ text: 'dupe list', buttons: [['b']] });
    });

    it('offers a scope choice and promises not to delete', async () => {
        await Dispatcher._handleDupScanCommand('chat1', 'user1');

        const [target, payload] = mockClient.sendMessage.mock.calls[0];
        expect(target).toBe('chat1');
        expect(payload.message).toContain('不会删除');

        const buttonData = payload.buttons[0].map(b => b.data.toString());
        expect(buttonData).toEqual(['dupscan_scope_default', 'dupscan_scope_all']);
    });

    it('refuses to start a second scan for the same user', async () => {
        mockScanner.readScanState.mockResolvedValue({ status: 'running' });
        const answer = vi.fn();

        await Dispatcher._handleDupScanCallback(
            { userId: 'user1', msgId: 7 }, 'dupscan_scope_default', 'user1', answer
        );

        expect(mockScanner.scanDrive).not.toHaveBeenCalled();
        expect(mockSafeEdit).toHaveBeenCalledWith(
            'user1', 7, expect.stringContaining('已有扫描在进行中'), null, 'user1'
        );
        expect(answer).toHaveBeenCalled();
    });

    it('scans and renders results in the background', async () => {
        mockScanner.scanDrive.mockResolvedValue({
            ok: true,
            result: { groups: [{ basis: 'hash', algo: 'md5', size: 10, paths: ['a', 'b'] }], hashed: 2, total: 2, hashAvailable: true }
        });
        const answer = vi.fn();

        await Dispatcher._handleDupScanCallback(
            { userId: 'user1', msgId: 7 }, 'dupscan_scope_default', 'user1', answer
        );
        await flush();

        // 状态按 userId 存 Redis,不是 chatId —— 群聊里两者不同
        expect(mockScanner.writeScanState).toHaveBeenCalledWith('user1', expect.objectContaining({ status: 'running' }));
        expect(mockScanner.scanDrive).toHaveBeenCalledWith('user1', expect.objectContaining({ id: 'd1' }));
        expect(mockUIHelper.renderDupScanPage).toHaveBeenCalledWith('Mega-a', expect.anything(), 0);
        expect(mockSafeEdit).toHaveBeenLastCalledWith('user1', 7, 'dupe list', [['b']], 'user1');
    });

    it('stops the scan when cancel was requested between drives', async () => {
        mockScanner.readScanState
            .mockResolvedValueOnce(null)          // 已有扫描检查
            .mockResolvedValueOnce({ cancelRequested: true }); // 循环里的取消检查
        const answer = vi.fn();

        await Dispatcher._handleDupScanCallback(
            { userId: 'user1', msgId: 7 }, 'dupscan_scope_default', 'user1', answer
        );
        await flush();

        expect(mockScanner.scanDrive).not.toHaveBeenCalled();
        expect(mockSafeEdit).toHaveBeenCalledWith(
            'user1', 7, expect.stringContaining('扫描已停止'), null, 'user1'
        );
    });

    it('keeps scanning after one drive fails and says so', async () => {
        mockScanner.resolveDrives.mockResolvedValue([
            { id: 'd1', name: 'Mega-a', type: 'mega' },
            { id: 'd2', name: 'Dropbox-b', type: 'dropbox' }
        ]);
        mockScanner.scanDrive
            .mockResolvedValueOnce({ ok: false, reason: '认证失败' })
            .mockResolvedValueOnce({
                ok: true,
                result: { groups: [], hashed: 1, total: 1, hashAvailable: true }
            });
        const answer = vi.fn();

        await Dispatcher._handleDupScanCallback(
            { userId: 'user1', msgId: 7 }, 'dupscan_scope_all', 'user1', answer
        );
        await flush();

        expect(mockScanner.scanDrive).toHaveBeenCalledTimes(2);
        expect(mockSafeEdit).toHaveBeenCalledWith(
            'user1', 7, expect.stringContaining('认证失败'), expect.any(Array), 'user1'
        );
    });

    it('rejects a cancel when nothing is running', async () => {
        mockScanner.requestCancel.mockResolvedValue(false);
        const answer = vi.fn();

        await Dispatcher._handleDupScanCallback(
            { userId: 'user1', msgId: 7 }, 'dupscan_cancel', 'user1', answer
        );

        expect(answer).toHaveBeenCalledWith(expect.any(String));
    });

    it('ignores page callbacks when no scan result is stored', async () => {
        mockScanner.readScanState.mockResolvedValue({ status: 'running' });
        const answer = vi.fn();

        await Dispatcher._handleDupScanCallback(
            { userId: 'user1', msgId: 7 }, 'dupscan_page_2', 'user1', answer
        );

        expect(mockUIHelper.renderDupScanPage).not.toHaveBeenCalled();
        expect(answer).toHaveBeenCalled();
    });
});
