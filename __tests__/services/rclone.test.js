import { jest } from '@jest/globals';
import { EventEmitter } from 'events';

// --- Mocks Definitions ---
const mockFindByUserId = jest.fn();
const mockSpawn = jest.fn();
const mockSpawnSync = jest.fn();
const mockCache = new Map();
const mockCacheService = {
    get: jest.fn((key) => mockCache.get(key)),
    set: jest.fn((key, val) => mockCache.set(key, val)),
};

// --- Module Mocks ---
jest.unstable_mockModule('../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: {
        findByUserId: mockFindByUserId
    }
}));

jest.unstable_mockModule('child_process', () => ({
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
    execSync: jest.fn()
}));

jest.unstable_mockModule('../../src/config/index.js', () => ({
    config: {
        remoteFolder: 'test-folder'
    }
}));

jest.unstable_mockModule('../../src/utils/CacheService.js', () => ({
    cacheService: mockCacheService
}));

jest.unstable_mockModule('../../src/services/redis.js', () => ({
    redis: {
        enabled: true,
        get: jest.fn(),
        set: jest.fn().mockResolvedValue('OK')
    }
}));

// --- Import under test ---
const { CloudTool } = await import('../../src/services/rclone.js');

describe('CloudTool', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockCache.clear();
        CloudTool.loading = false;
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

            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: 'obscuredpass\n',
                stderr: ''
            });

            const result = await CloudTool._getUserConfig('user123');
            expect(result.pass).toBe('obscuredpass');
            expect(mockSpawnSync).toHaveBeenCalled();
        });
    });

    describe('_obscure', () => {
        it('should return obscured password on success', () => {
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: 'obscured\n'
            });

            const result = CloudTool._obscure('plain');
            expect(result).toBe('obscured');
        });

        it('should return original password on failure', () => {
            mockSpawnSync.mockReturnValue({
                status: 1,
                stderr: 'error'
            });

            const result = CloudTool._obscure('plain');
            expect(result).toBe('plain');
        });

        it('should handle spawn error', () => {
            mockSpawnSync.mockReturnValue({
                error: new Error('spawn error')
            });

            const result = CloudTool._obscure('plain');
            expect(result).toBe('plain');
        });
    });

    describe('validateConfig', () => {
        it('should resolve success true when rclone returns 0', async () => {
            const mockProc = new EventEmitter();
            mockProc.stderr = new EventEmitter();
            mockSpawn.mockReturnValue(mockProc);

            const promise = CloudTool.validateConfig('mega', { user: 'u', pass: 'p' });
            
            setTimeout(() => {
                mockProc.emit('close', 0);
            }, 10);

            const result = await promise;
            expect(result.success).toBe(true);
        });

        it('should resolve success false with reason 2FA on specific error', async () => {
            const mockProc = new EventEmitter();
            mockProc.stderr = new EventEmitter();
            mockSpawn.mockReturnValue(mockProc);

            const promise = CloudTool.validateConfig('mega', { user: 'u', pass: 'p' });
            
            setTimeout(() => {
                mockProc.stderr.emit('data', Buffer.from('Multi-factor authentication required'));
                mockProc.emit('close', 1);
            }, 10);

            const result = await promise;
            expect(result.success).toBe(false);
            expect(result.reason).toBe('2FA');
        });

        it('should handle unexpected errors', async () => {
            mockSpawn.mockImplementation(() => {
                throw new Error('Unexpected');
            });

            const result = await CloudTool.validateConfig('mega', { user: 'u', pass: 'p' });
            expect(result.success).toBe(false);
            expect(result.reason).toBe('ERROR');
        });
    });

    describe('uploadFile', () => {
        it('should handle successful upload', async () => {
            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });

            const mockProc = new EventEmitter();
            mockProc.stderr = new EventEmitter();
            mockSpawn.mockReturnValue(mockProc);

            const task = { userId: 'user123', id: 'task1' };
            const promise = CloudTool.uploadFile('/local/path', task);

            setTimeout(() => {
                mockProc.emit('close', 0);
            }, 10);

            const result = await promise;
            expect(result.success).toBe(true);
            expect(task.proc).toBeDefined();
        });

        it('should handle upload failure and return error log', async () => {
            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });

            const mockProc = new EventEmitter();
            mockProc.stderr = new EventEmitter();
            mockSpawn.mockReturnValue(mockProc);

            const promise = CloudTool.uploadFile('/local/path', { userId: 'user123' });

            setTimeout(() => {
                mockProc.stderr.emit('data', Buffer.from('Upload failed because of disk full'));
                mockProc.emit('close', 1);
            }, 10);

            const result = await promise;
            expect(result.success).toBe(false);
            expect(result.error).toContain('disk full');
        });

        it('should trigger onProgress callback', async () => {
            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });

            const mockProc = new EventEmitter();
            mockProc.stderr = new EventEmitter();
            mockSpawn.mockReturnValue(mockProc);

            const onProgress = jest.fn();
            const promise = CloudTool.uploadFile('/local/path', { userId: 'user123' }, onProgress);

            setTimeout(() => {
                mockProc.stderr.emit('data', Buffer.from('Transferred: 10%'));
                mockProc.emit('close', 0);
            }, 10);

            await promise;
            expect(onProgress).toHaveBeenCalled();
        });
    });

    describe('listRemoteFiles', () => {
        beforeEach(() => {
            mockCacheService.get.mockReturnValue(null);
        });

        it('should return files and cache them (Multi-level)', async () => {
            const { redis } = await import('../../src/services/redis.js');
            redis.get.mockResolvedValue(null);

            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });

            const mockFiles = [{ name: 'file1.txt', IsDir: false, ModTime: '2023-01-01T00:00:00Z' }];
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: JSON.stringify(mockFiles)
            });

            const files = await CloudTool.listRemoteFiles('user123');
            expect(files).toEqual(mockFiles);
            expect(mockCacheService.set).toHaveBeenCalled();
            expect(redis.set).toHaveBeenCalled();
            
            // Mock memory cache for next call
            mockCacheService.get.mockReturnValue(mockFiles);
            await CloudTool.listRemoteFiles('user123');
            expect(mockSpawnSync).toHaveBeenCalledTimes(1);
        });

        it('should use Redis cache if memory cache is empty', async () => {
            const { redis } = await import('../../src/services/redis.js');
            const mockFiles = [{ name: 'redis-file.txt', IsDir: false, ModTime: '2023-01-01T00:00:00Z' }];
            redis.get.mockResolvedValue(JSON.stringify(mockFiles));

            const files = await CloudTool.listRemoteFiles('user124');
            expect(files).toEqual(mockFiles);
            expect(mockSpawnSync).not.toHaveBeenCalled();
        });

        it('should force refresh when requested', async () => {
            const { redis } = await import('../../src/services/redis.js');
            redis.get.mockResolvedValue(null);
            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });
            mockSpawnSync.mockReturnValue({ status: 0, stdout: '[]' });

            await CloudTool.listRemoteFiles('user125');
            mockCacheService.get.mockReturnValue([]);
            await CloudTool.listRemoteFiles('user125', true);
            expect(mockSpawnSync).toHaveBeenCalledTimes(2);
        });

        it('should handle rclone error and return empty array', async () => {
            const { redis } = await import('../../src/services/redis.js');
            redis.get.mockResolvedValue(null);
            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });
            mockSpawnSync.mockReturnValue({ status: 1, stderr: 'error' });

            const files = await CloudTool.listRemoteFiles('user126');
            expect(files).toEqual([]);
        });
    });

    describe('getRemoteFileInfo', () => {
        it('should return file info if file exists', async () => {
            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });

            const mockFileInfo = { name: 'test.txt', Size: 100 };
            mockSpawnSync.mockReturnValue({
                status: 0,
                stdout: JSON.stringify([mockFileInfo])
            });

            const info = await CloudTool.getRemoteFileInfo('test.txt', 'user123');
            expect(info).toEqual(mockFileInfo);
        });

        it('should return null if file does not exist or error occurs', async () => {
            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });
            mockSpawnSync.mockReturnValue({ status: 1 });

            const info = await CloudTool.getRemoteFileInfo('missing.txt', 'user123');
            expect(info).toBeNull();
        });

        it('should return null if userId is missing', async () => {
            const info = await CloudTool.getRemoteFileInfo('file.txt', null);
            expect(info).toBeNull();
        });

        it('should return null if JSON parsing fails', async () => {
            mockFindByUserId.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });
            mockSpawnSync.mockReturnValue({ status: 0, stdout: 'invalid-json' });

            const info = await CloudTool.getRemoteFileInfo('file.txt', 'user123');
            expect(info).toBeNull();
        });
    });

    describe('isLoading and killTask', () => {
        it('should return loading state', () => {
            CloudTool.loading = true;
            expect(CloudTool.isLoading()).toBe(true);
            CloudTool.loading = false;
            expect(CloudTool.isLoading()).toBe(false);
        });

        it('should have killTask method (empty implementation)', async () => {
            await expect(CloudTool.killTask('task1')).resolves.toBeUndefined();
        });
    });
});