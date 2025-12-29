import { jest } from '@jest/globals';

const mockSpawn = jest.fn();

jest.unstable_mockModule('child_process', () => ({
    spawn: mockSpawn,
    spawnSync: jest.fn(),
    execSync: jest.fn()
}));

jest.unstable_mockModule('../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: {
        findByUserId: jest.fn()
    }
}));

jest.unstable_mockModule('../../src/services/kv.js', () => ({
    kv: jest.fn()
}));

jest.unstable_mockModule('../../src/config/index.js', () => ({
    config: {
        downloadDir: '/tmp/downloads',
        remoteFolder: 'test-remote'
    }
}));

const { CloudTool } = await import('../../src/services/rclone.js');

const waitFor = async (callback, timeout = 200, interval = 10) => {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        try {
            const result = callback();
            if (result !== false) return;
        } catch (e) {
            // ignore
        }
        await new Promise(r => setTimeout(r, interval));
    }
    callback(); // run one last time to throw if still failing
};

describe('CloudTool Batch Upload', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should call rclone with correct batch arguments', async () => {
        const mockProc = {
            stderr: { on: jest.fn() },
            on: jest.fn((event, cb) => {
                if (event === 'close') {
                    // 模拟异步关闭
                    process.nextTick(() => cb(0));
                }
            }),
            stdin: {
                write: jest.fn(),
                end: jest.fn()
            },
            stdout: { on: jest.fn() }
        };
        mockSpawn.mockReturnValue(mockProc);

        const tasks = [
            { id: '1', userId: 'user1', localPath: '/tmp/downloads/file1.mp4' },
            { id: '2', userId: 'user1', localPath: '/tmp/downloads/file2.mp4' }
        ];

        // 模拟 _getUserConfig
        jest.spyOn(CloudTool, '_getUserConfig').mockResolvedValue({
            type: 'onedrive',
            user: 'test',
            pass: 'pass'
        });

        const promise = CloudTool.uploadBatch(tasks);
        
        // 显式等待 spawn 被调用 (因为 uploadBatch 是 async 的)
        await waitFor(() => {
            expect(mockSpawn).toHaveBeenCalled();
        });

        expect(mockSpawn).toHaveBeenCalledWith('rclone', expect.arrayContaining([
            '--config', '/dev/null',
            'copy',
            expect.stringContaining('downloads'),
            expect.stringContaining(':onedrive,user="test",pass="pass":test-remote/'),
            '--files-from-raw', '-',
            '--progress',
            '--use-json-log'
        ]), expect.any(Object));

        const result = await promise;
        expect(result.success).toBe(true);
        expect(mockProc.stdin.write).toHaveBeenCalledWith('file1.mp4\nfile2.mp4');
    });

    it('should parse JSON progress and trigger callback', async () => {
        let progressCallback;
        const mockProc = {
            stderr: { 
                on: jest.fn((event, cb) => {
                    if (event === 'data') progressCallback = cb;
                }) 
            },
            on: jest.fn((event, cb) => {
                if (event === 'close') {
                    process.nextTick(() => cb(0));
                }
            }),
            stdin: { write: jest.fn(), end: jest.fn() }
        };
        mockSpawn.mockReturnValue(mockProc);

        const tasks = [
            { id: 'task-1', userId: 'u1', localPath: '/tmp/downloads/movie.mp4' }
        ];

        jest.spyOn(CloudTool, '_getUserConfig').mockResolvedValue({ type: 'drive', user: 'u', pass: 'p' });

        const onProgress = jest.fn();
        const uploadPromise = CloudTool.uploadBatch(tasks, onProgress);

        // 等待 stderr.on('data') 被注册
        await waitFor(() => {
            if (!progressCallback) throw new Error("Callback not set");
        });

        // 模拟 rclone 输出进度日志
        const mockStatus = JSON.stringify({
            msg: "Status update",
            stats: {
                transferring: [{
                    name: "movie.mp4",
                    percentage: 50,
                    bytes: 500,
                    size: 1000,
                    speed: 100,
                    eta: 5
                }]
            }
        });

        progressCallback(Buffer.from(mockStatus + '\n'));

        await new Promise(r => setTimeout(r, 50));
        expect(onProgress).toHaveBeenCalledWith('task-1', expect.objectContaining({
            percentage: 50,
            bytes: 500
        }));
    });
});