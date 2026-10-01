import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDriveRepository = {
    getDefaultDrive: vi.fn(),
    findByUserId: vi.fn()
};

const mockCache = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
};

const mockCloudTool = {
    _getUserConfig: vi.fn(),
    _openUserRemoteRuntime: vi.fn(),
    _runRclone: vi.fn(),
    sanitizeRcloneOutput: vi.fn((s) => s)
};

vi.mock('../../src/repositories/DriveRepository.js', () => ({ DriveRepository: mockDriveRepository }));
vi.mock('../../src/services/CacheService.js', () => ({ cache: mockCache }));
vi.mock('../../src/services/rclone.js', () => ({ CloudTool: mockCloudTool }));

const {
    groupDuplicates,
    scanDrive,
    resolveDrives,
    readScanState,
    writeScanState,
    requestCancel,
    clearScanState
} = await import('../../src/services/DuplicateScanner.js');

describe('groupDuplicates', () => {
    it('groups identical content by hash', () => {
        const result = groupDuplicates([
            { Name: 'a.jpg', Path: 'a.jpg', Size: 100, Hashes: { MD5: 'h1' } },
            { Name: 'copy/a.jpg', Path: 'copy/a.jpg', Size: 100, Hashes: { MD5: 'h1' } },
            { Name: 'b.jpg', Path: 'b.jpg', Size: 100, Hashes: { MD5: 'h2' } }
        ]);

        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].basis).toBe('hash');
        expect(result.groups[0].paths.sort()).toEqual(['a.jpg', 'copy/a.jpg']);
        expect(result.hashAvailable).toBe(true);
    });

    // 这是最关键的一条:后端不支持哈希时,绝不能谎称"未发现重复"
    it('falls back to size grouping and reports hashes are unavailable', () => {
        const result = groupDuplicates([
            { Name: 'a.mp4', Path: 'a.mp4', Size: 500, Hashes: {} },
            { Name: 'sub/a.mp4', Path: 'sub/a.mp4', Size: 500, Hashes: {} }
        ]);

        expect(result.hashAvailable).toBe(false);
        expect(result.hashed).toBe(0);
        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].basis).toBe('size');
        expect(result.groups[0].algo).toBeNull();
    });

    it('ignores directories and zero-byte files', () => {
        const result = groupDuplicates([
            { Name: 'dir', IsDir: true, Size: 100 },
            { Name: 'a', Size: 0, Hashes: { MD5: 'z' } },
            { Name: 'b', Size: 0, Hashes: { MD5: 'z' } },
            { Name: 'real', Size: 5, Hashes: { MD5: 'q' } }
        ]);

        expect(result.groups).toHaveLength(0);
        expect(result.total).toBe(1);
    });

    it('keeps single-occurrence hashes out of the results', () => {
        const result = groupDuplicates([
            { Name: 'a', Size: 10, Hashes: { MD5: 'unique' } }
        ]);
        expect(result.groups).toHaveLength(0);
    });
});

describe('scanDrive', () => {
    let dispose;

    beforeEach(() => {
        vi.clearAllMocks();
        dispose = vi.fn().mockResolvedValue(undefined);
        mockCloudTool._openUserRemoteRuntime.mockResolvedValue({
            connectionString: ':mega,user="u":',
            configArgs: ['--config', '/dev/null'],
            dispose
        });
        mockCloudTool._getUserConfig.mockResolvedValue({ type: 'mega' });
    });

    it('lists the whole drive recursively and always disposes the runtime', async () => {
        mockCloudTool._runRclone.mockResolvedValue({
            code: 0,
            stdout: JSON.stringify([
                { Name: 'a', Path: 'a', Size: 10, Hashes: { MD5: 'h' } },
                { Name: 'b', Path: 'b', Size: 10, Hashes: { MD5: 'h' } }
            ])
        });

        const res = await scanDrive('u1', { id: 'd1', type: 'mega' });

        const args = mockCloudTool._runRclone.mock.calls[0][0];
        expect(args).toContain('-R');
        expect(args).toContain('--hash');
        expect(args[args.length - 1]).toBe(':mega,user="u":');
        expect(res.ok).toBe(true);
        expect(res.result.groups).toHaveLength(1);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    // 漏掉 dispose = 泄漏临时目录 + 永久持有 Proton session mutex
    it('disposes the runtime even when rclone times out', async () => {
        mockCloudTool._runRclone.mockResolvedValue({ code: -1, stdout: '', stderr: 'TIMEOUT' });

        const res = await scanDrive('u1', { id: 'd1', type: 'proton' });

        expect(res.ok).toBe(false);
        expect(res.reason).toContain('超时');
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('disposes the runtime when the listing fails', async () => {
        mockCloudTool._runRclone.mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' });

        const res = await scanDrive('u1', { id: 'd1', type: 'mega' });

        expect(res.ok).toBe(false);
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('passes the target drive through so non-default drives use their own credentials', async () => {
        mockCloudTool._runRclone.mockResolvedValue({ code: 0, stdout: '[]' });
        const driveRow = { id: 'd2', type: 'proton' };

        await scanDrive('u1', driveRow);

        expect(mockCloudTool._getUserConfig).toHaveBeenCalledWith('u1', driveRow);
        expect(mockCloudTool._openUserRemoteRuntime).toHaveBeenCalledWith('u1', expect.anything(), driveRow);
    });
});

describe('resolveDrives', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns only the default drive for the default scope', async () => {
        const drive = { id: 'd1' };
        mockDriveRepository.getDefaultDrive.mockResolvedValue(drive);

        expect(await resolveDrives('u1', 'default')).toEqual([drive]);
        expect(mockDriveRepository.findByUserId).not.toHaveBeenCalled();
    });

    it('returns every drive for the all scope', async () => {
        mockDriveRepository.findByUserId.mockResolvedValue([{ id: 'd1' }, { id: 'd2' }]);

        expect(await resolveDrives('u1', 'all')).toHaveLength(2);
    });
});

describe('scan state (Redis)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCache.set.mockResolvedValue(true);
        mockCache.delete.mockResolvedValue(true);
    });

    it('merges patches instead of clobbering existing state', async () => {
        mockCache.get.mockResolvedValue({ status: 'running', cancelRequested: false });

        const next = await writeScanState('u1', { msgId: 42 });

        expect(next).toMatchObject({ status: 'running', msgId: 42 });
    });

    it('marks cancelRequested only when a scan is actually running', async () => {
        mockCache.get.mockResolvedValue({ status: 'running' });
        expect(await requestCancel('u1')).toBe(true);
        expect(mockCache.set).toHaveBeenCalledWith(
            expect.stringContaining('dupscan:u1'),
            expect.objectContaining({ cancelRequested: true }),
            expect.any(Number)
        );

        mockCache.get.mockResolvedValue({ status: 'done' });
        expect(await requestCancel('u1')).toBe(false);
    });

    it('survives cache read failures', async () => {
        mockCache.get.mockRejectedValue(new Error('redis down'));
        expect(await readScanState('u1')).toBeNull();
        await expect(clearScanState('u1')).resolves.toBeUndefined();
    });
});
