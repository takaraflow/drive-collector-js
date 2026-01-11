import { EventEmitter } from 'events';

// --- Mocks Definitions ---
const mockFindByUserId = vi.fn();
const mockSpawn = vi.fn();
const mockSpawnSync = vi.fn();
const mockCache = new Map();
const mockCacheService = {
    get: vi.fn((key) => mockCache.get(key)),
    set: vi.fn((key, val) => mockCache.set(key, val)),
};

// --- Module Mocks ---
vi.mock('../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: {
        findByUserId: mockFindByUserId
    }
}));

vi.mock('child_process', () => ({
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
    execSync: vi.fn()
}));

vi.mock('../../src/config/index.js', () => ({
    config: {
        remoteFolder: 'test-folder'
    }
}));

const mockKv = {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(true)
};

vi.mock('../../src/services/CacheService.js', () => ({
    cache: mockKv
}));

// --- Import under test ---
const { CloudTool } = await import('../../src/services/rclone.js');

// --- Helper: 创建自动触发事件的 Mock 进程 ---
// 模拟真实 child_process 事件顺序：data -> end -> exit -> close
const createAutoProcess = (onSpawn) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.kill = vi.fn();

    if (onSpawn) {
        setTimeout(() => onSpawn(proc), 0);
    }

    return proc;
};

describe('CloudTool', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        mockCache.clear();
        mockKv.get.mockClear();
        mockKv.set.mockClear();
        CloudTool.loading = false;
        mockSpawnSync.mockReturnValue({ status: 0, stdout: 'obscured\n', stderr: '' });
        mockKv.get.mockResolvedValue(null);
        mockSpawn.mockReset();
    });

    afterEach(() => {
        // 核弹级清理：所有模拟进程的监听器
        mockSpawn.mock.instances.forEach((proc) => {
            if (proc) {
                proc.removeAllListeners();
                proc.stdout?.removeAllListeners();
                proc.stderr?.removeAllListeners();
                proc.stdin?.write?.mockClear(); // stdin 是对象，不需要 remove listeners
            }
        });
        vi.useRealTimers();
    });

    describe('_getUserConfig', () => {
        it('should throw error if userId is missing', async () => {
            await expect(CloudTool._getUserConfig(null)).rejects.toThrow();
        });

        it('should throw error if no drive is found', async () => {
            mockFindByUserId.mockResolvedValue(null);
            await expect(CloudTool._getUserConfig('user123')).rejects.toThrow();
        });

        it('should return cleaned config for non-mega drive', async () => {
            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'testuser', pass: 'testpass' })
            });

            const result = await CloudTool._getUserConfig('user123');
            expect(result).toEqual({
                type: 'drive',
                user: 'testuser',
                pass: 'testpass'
            });
        });

        it('should obscure password for mega drive', async () => {
            mockFindByUserId.mockResolvedValue({
                type: 'mega',
                config_data: JSON.stringify({ user: 'testuser', pass: 'rawpass' })
            });
            mockSpawnSync.mockReturnValue({ status: 0, stdout: 'obscuredpass\n', stderr: '' });

            const result = await CloudTool._getUserConfig('user123');
            expect(result.pass).toBe('obscuredpass');
        });
    });

    describe('_obscure', () => {
        it('should return obscured password on success', () => {
            mockSpawnSync.mockReturnValue({ status: 0, stdout: 'obscured\n' });
            expect(CloudTool._obscure('plain')).toBe('obscured');
        });

        it('should return original password on failure', () => {
            mockSpawnSync.mockReturnValue({ status: 1, stderr: 'error' });
            expect(CloudTool._obscure('plain')).toBe('plain');
        });

        it('should handle spawn error', () => {
            mockSpawnSync.mockReturnValue({ error: new Error('spawn error') });
            expect(CloudTool._obscure('plain')).toBe('plain');
        });
    });

    describe('validateConfig', () => {
        it('should resolve success true when rclone returns 0', async () => {
            mockSpawn.mockImplementation(() => createAutoProcess((p) => {
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.emit('exit', 0);
                p.emit('close', 0);
            }));
            const result = await CloudTool.validateConfig('mega', { user: 'u', pass: 'p' });
            expect(result.success).toBe(true);
        });

        it('should resolve success false with reason 2FA on specific error', async () => {
            mockSpawn.mockImplementation(() => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from('Multi-factor authentication required\n'));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));
            const result = await CloudTool.validateConfig('mega', { user: 'u', pass: 'p' });
            expect(result.success).toBe(false);
            expect(result.reason).toBe('2FA');
        });

        it('should handle unexpected errors', async () => {
            mockSpawn.mockImplementation(() => { throw new Error('Unexpected'); });
            const result = await CloudTool.validateConfig('mega', { user: 'u', pass: 'p' });
            expect(result.success).toBe(false);
            expect(result.reason).toBe('ERROR');
        });
    });

    describe('uploadFile', () => {
        beforeEach(() => {
            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });
        });

        it('should handle successful upload', async () => {
            mockSpawn.mockImplementation(() => createAutoProcess((p) => {
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.emit('exit', 0);
                p.emit('close', 0);
            }));
            const task = { userId: 'user123' }; // 移除 id，避免潜在全局存储
            const result = await CloudTool.uploadFile('/local/path', task);
            expect(result.success).toBe(true);
            expect(task.proc).toBeDefined();
        });

        it('should handle upload failure and return error log', async () => {
            mockSpawn.mockImplementationOnce(() => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from('Upload failed because of disk full\n'));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));
            const result = await CloudTool.uploadFile('/local/path', { userId: 'user123' });
            expect(result.success).toBe(false);
            expect(result.error).toContain('disk full');
        });

        it('should trigger onProgress callback', async () => {
            mockSpawn.mockImplementation(() => createAutoProcess((p) => {
                const log = { msg: "Status update", stats: { transferring: [{ name: "path", percentage: 10 }] } };
                p.stderr.emit('data', Buffer.from(JSON.stringify(log) + '\n'));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 0);
                p.emit('close', 0);
            }));
            const onProgress = vi.fn();
            const task = { userId: 'user123', localPath: '/local/path' }; // 移除 id
            await CloudTool.uploadFile('/local/path', task, onProgress);
            expect(onProgress).toHaveBeenCalled();
        });
    });

    describe('listRemoteFiles', () => {
        beforeEach(() => {
            mockCacheService.get.mockReturnValue(null);
            mockFindByUserId.mockResolvedValue({
                type: 'drive', config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });
        });

        it('should return files and cache them (Multi-level KV)', async () => {
            mockKv.get.mockResolvedValue(null);
            const mockFiles = [{ Name: 'file1.txt', IsDir: false, ModTime: '2023-01-01T00:00:00Z' }];

            mockSpawn.mockImplementationOnce(() => createAutoProcess((p) => {
                p.stdout.emit('data', Buffer.from(JSON.stringify(mockFiles)));
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.emit('exit', 0);
                p.emit('close', 0);
            }));

            const files = await CloudTool.listRemoteFiles('user123');
            expect(files).toEqual(mockFiles);
            expect(mockKv.set).toHaveBeenCalled();
        });

        it('should use KV cache if memory cache is empty', async () => {
            const mockFiles = [{ Name: 'kv-file.txt', IsDir: false, ModTime: '2023-01-01T00:00:00Z' }];
            mockKv.get.mockResolvedValue({ files: mockFiles });
            const files = await CloudTool.listRemoteFiles('user124');
            expect(files).toEqual(mockFiles);
            expect(mockSpawn).not.toHaveBeenCalled();
        });

        it('should force refresh when requested', async () => {
            mockSpawn.mockImplementation(() => createAutoProcess((p) => {
                p.stdout.emit('data', Buffer.from('[]'));
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.emit('exit', 0);
                p.emit('close', 0);
            }));
            await CloudTool.listRemoteFiles('user125');
            mockKv.get.mockReturnValue([]);
            await CloudTool.listRemoteFiles('user125', true);
            expect(mockSpawn).toHaveBeenCalledTimes(2);
        });

        it('should handle rclone error and return empty array', async () => {
            mockSpawn.mockImplementation(() => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from('error listing\n'));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));
            const files = await CloudTool.listRemoteFiles('user126');
            expect(files).toEqual([]);
        });
    });

    describe('getRemoteFileInfo', () => {
        beforeEach(() => {
            mockFindByUserId.mockResolvedValue({
                type: 'drive', config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });
        });

        it('should return file info if file exists', async () => {
            const mockFileInfo = { Name: 'test.txt', Size: 100 };
            mockSpawn.mockImplementationOnce(() => createAutoProcess((p) => {
                p.stdout.emit('data', Buffer.from(JSON.stringify([mockFileInfo])));
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.emit('exit', 0);
                p.emit('close', 0);
            }));
            const info = await CloudTool.getRemoteFileInfo('test.txt', 'user123');
            expect(info.Name).toBe('test.txt');
        });

        it('should retry on failure and eventually return info (Verification of Retry Logic)', async () => {
            const mockFileInfo = { Name: 'retry.txt', Size: 200 };
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from('error1\n'));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from('error2\n'));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stdout.emit('data', Buffer.from(JSON.stringify([mockFileInfo])));
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }));

            vi.useFakeTimers();

            const infoPromise = CloudTool.getRemoteFileInfo('retry.txt', 'user123', 3);

            vi.runAllTicks();

            for (let i = 0; i < 50; i++) {
                vi.advanceTimersByTime(10000);
                vi.runAllTicks();
                await Promise.resolve();
                await Promise.resolve();
            }

            const info = await infoPromise;

            expect(info.Name).toBe('retry.txt');
            expect(mockSpawn).toHaveBeenCalledTimes(3);

            vi.useRealTimers();
        });

        it('should return null after all retries fail', async () => {
            mockSpawn.mockImplementation(() => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from('error\n'));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));

            vi.useFakeTimers();

            const infoPromise = CloudTool.getRemoteFileInfo('missing.txt', 'user123', 2);

            vi.runAllTicks();

            for (let i = 0; i < 50; i++) {
                vi.advanceTimersByTime(10000);
                vi.runAllTicks();
                await Promise.resolve();
                await Promise.resolve();
            }

            const info = await infoPromise;

            expect(info).toBeNull();

            vi.useRealTimers();
        });

        it('should handle JSON parsing errors and retry', async () => {
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stdout.emit('data', Buffer.from('invalid-json\n'));
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stdout.emit('data', Buffer.from(JSON.stringify([{ Name: 'ok.txt' }])));
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }));

            vi.useFakeTimers();

            const infoPromise = CloudTool.getRemoteFileInfo('ok.txt', 'user123', 2);

            for (let i = 0; i < 50; i++) {
                vi.advanceTimersByTime(10000);
                vi.runAllTicks();
                await Promise.resolve();
                await Promise.resolve();
            }

            const info = await infoPromise;

            expect(info.Name).toBe('ok.txt');

            vi.useRealTimers();
        });
    });

    describe('isLoading and killTask', () => {
        it('should return loading state', () => {
            CloudTool.loading = true;
            expect(CloudTool.isLoading()).toBe(true);
        });

        it('should have killTask method (empty implementation)', async () => {
            await expect(CloudTool.killTask('task1')).resolves.toBeUndefined();
        });
    
        describe('Custom Upload Path', () => {
            describe('_validatePath', () => {
                it('should return true for valid paths', () => {
                    expect(CloudTool._validatePath('/Movies')).toBe(true);
                    expect(CloudTool._validatePath('/Movies/2024')).toBe(true);
                    expect(CloudTool._validatePath('/My.Files_2024-01')).toBe(true);
                });
    
                it('should return false for paths not starting with /', () => {
                    expect(CloudTool._validatePath('Movies')).toBe(false);
                });
    
                it('should return false for paths ending with /', () => {
                    expect(CloudTool._validatePath('/Movies/')).toBe(false);
                });
    
                it('should return false for paths with double slashes', () => {
                    expect(CloudTool._validatePath('/Movies//2024')).toBe(false);
                });
    
                it('should return false for invalid characters', () => {
                    expect(CloudTool._validatePath('/Movies$')).toBe(false);
                    expect(CloudTool._validatePath('/Movies?')).toBe(false);
                });
    
                it('should return false for too long paths', () => {
                    expect(CloudTool._validatePath('/' + 'a'.repeat(256))).toBe(false);
                });
            });
    
            describe('_normalizePath', () => {
                it('should remove leading slashes and add trailing slash', () => {
                    expect(CloudTool._normalizePath('/Movies')).toBe('Movies/');
                    expect(CloudTool._normalizePath('///Movies')).toBe('Movies/');
                });
    
                it('should handle root directory', () => {
                    expect(CloudTool._normalizePath('/')).toBe('/');
                    expect(CloudTool._normalizePath('')).toBe('/');
                });
    
                it('should ensure trailing slash', () => {
                    expect(CloudTool._normalizePath('/Movies/2024')).toBe('Movies/2024/');
                });
            });
    
            describe('_getUploadPath', () => {
                it('should return custom path if set in D1', async () => {
                    mockFindByUserId.mockResolvedValue({
                        remote_folder: '/Custom/Path'
                    });
                    const path = await CloudTool._getUploadPath('user123');
                    expect(path).toBe('Custom/Path/');
                });
    
                it('should return default path if not set in D1', async () => {
                    mockFindByUserId.mockResolvedValue({
                        remote_folder: null
                    });
                    const path = await CloudTool._getUploadPath('user123');
                    expect(path).toBe('test-folder/');
                });
    
                it('should return default path if D1 query fails', async () => {
                    mockFindByUserId.mockRejectedValue(new Error('DB Error'));
                    const path = await CloudTool._getUploadPath('user123');
                    expect(path).toBe('test-folder/');
                });
            });
        });
    });
});