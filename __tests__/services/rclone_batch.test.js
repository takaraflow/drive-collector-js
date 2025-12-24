import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudTool } from '../../src/services/rclone.js';
import { spawn } from 'child_process';
import path from 'path';

vi.mock('child_process');
vi.mock('../../src/repositories/DriveRepository.js');
vi.mock('../../src/services/kv.js');
vi.mock('../../src/config/index.js', () => ({
    config: {
        downloadDir: '/tmp/downloads',
        remoteFolder: 'test-remote'
    }
}));

describe('CloudTool Batch Upload', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should call rclone with correct batch arguments', async () => {
        const mockProc = {
            stderr: { on: vi.fn() },
            on: vi.fn((event, cb) => {
                if (event === 'close') {
                    // 模拟异步关闭
                    process.nextTick(() => cb(0));
                }
            }),
            stdin: {
                write: vi.fn(),
                end: vi.fn()
            },
            stdout: { on: vi.fn() }
        };
        vi.mocked(spawn).mockReturnValue(mockProc);

        const tasks = [
            { id: '1', userId: 'user1', localPath: '/tmp/downloads/file1.mp4' },
            { id: '2', userId: 'user1', localPath: '/tmp/downloads/file2.mp4' }
        ];

        // 模拟 _getUserConfig
        vi.spyOn(CloudTool, '_getUserConfig').mockResolvedValue({
            type: 'onedrive',
            user: 'test',
            pass: 'pass'
        });

        const promise = CloudTool.uploadBatch(tasks);
        
        // 显式等待 spawn 被调用 (因为 uploadBatch 是 async 的)
        await vi.waitFor(() => {
            expect(spawn).toHaveBeenCalled();
        });

        expect(spawn).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([
            'copy',
            '/tmp/downloads',
            expect.stringContaining(':onedrive,user="test",pass="pass":test-remote/'),
            '--files-from-raw', '-',
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
                on: vi.fn((event, cb) => {
                    if (event === 'data') progressCallback = cb;
                }) 
            },
            on: vi.fn((event, cb) => {
                if (event === 'close') {
                    process.nextTick(() => cb(0));
                }
            }),
            stdin: { write: vi.fn(), end: vi.fn() }
        };
        vi.mocked(spawn).mockReturnValue(mockProc);

        const tasks = [
            { id: 'task-1', userId: 'u1', localPath: '/tmp/downloads/movie.mp4' }
        ];

        vi.spyOn(CloudTool, '_getUserConfig').mockResolvedValue({ type: 'drive', user: 'u', pass: 'p' });

        const onProgress = vi.fn();
        const uploadPromise = CloudTool.uploadBatch(tasks, onProgress);

        // 等待 stderr.on('data') 被注册
        await vi.waitFor(() => {
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