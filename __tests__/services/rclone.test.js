import { EventEmitter } from 'events';
import { vi } from 'vitest';

// --- Mocks Definitions ---
const mockFindByUserId = vi.fn();
const mockGetDefaultDrive = vi.fn();

// Mock spawnSync reference for use in DriveProviderFactory mock
const mockSpawnSyncRef = vi.fn();

// 使用 vi.hoisted 将 mockSpawnSync 引用提升到模块作用域顶部
const { mockSpawnSyncForProvider } = vi.hoisted(() => {
    // 创建一个可以被 mock 工厂函数访问的引用
    let spawnSyncMock = null;
    return {
        mockSpawnSyncForProvider: {
            setMock: (mock) => { spawnSyncMock = mock; },
            call: (pass) => {
                if (spawnSyncMock) {
                    const result = spawnSyncMock('rclone', ['--config', '/dev/null', 'obscure', pass], { encoding: 'utf-8' });
                    if (result && result.status === 0 && result.stdout) {
                        return result.stdout.trim();
                    }
                }
                return pass;
            }
        }
    };
});

// Mock DriveProviderFactory to handle different drive types in tests
vi.mock('../../src/services/drives/DriveProviderFactory.js', () => ({
    DriveProviderFactory: {
        getProvider: vi.fn((type) => {
            if (type === 'mega') {
                return {
                    type: 'mega',
                    name: 'Mega',
                    // For mega, processPassword uses the hoisted mock reference
                    processPassword: (pass, config = {}) => {
                        if (config.pass_format === 'rclone_obscured') return pass;
                        if (config.pass_format === 'legacy_unknown') return pass;
                        return mockSpawnSyncForProvider.call(pass);
                    },
                    getConnectionString: (config) => {
                        const user = (config.user || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                        const pass = (config.pass || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                        return `:mega,user="${user}",pass="${pass}":`;
                    },
                    getValidationCommand: () => 'about',
                    getInfo: () => ({ type: 'mega', name: 'Mega' })
                };
            }
            // Default: drive type
            return {
                type: 'drive',
                name: 'Google Drive',
                processPassword: (pass) => pass,
                getConnectionString: (config) => {
                    const user = (config.user || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    const pass = (config.pass || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    return `:drive,user="${user}",pass="${pass}":`;
                },
                getValidationCommand: () => 'about',
                getInfo: () => ({ type: 'drive', name: 'Google Drive' })
            };
        }),
        isSupported: vi.fn(() => true),
        getSupportedTypes: vi.fn(() => ['drive', 'mega'])
    }
}));
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
        findByUserId: mockFindByUserId,
        getDefaultDrive: mockGetDefaultDrive,
        updateConfigData: vi.fn()
    }
}));

vi.mock('child_process', () => ({
    spawn: mockSpawn,
    spawnSync: mockSpawnSync,
    execSync: vi.fn()
}));

vi.mock('../../src/config/index.js', () => ({
    getConfig: () => ({
        remoteFolder: 'test-folder'
    })
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
const { DriveRepository: MockDriveRepository } = await import('../../src/repositories/DriveRepository.js');

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

const createClosedProcess = ({ stdout = '', stderr = '', code = 0 } = {}) => createAutoProcess((p) => {
    if (stdout) p.stdout.emit('data', Buffer.from(stdout));
    if (stderr) p.stderr.emit('data', Buffer.from(stderr));
    p.stdout.emit('end');
    p.stdout.emit('close');
    p.stderr.emit('end');
    p.stderr.emit('close');
    p.emit('exit', code);
    p.emit('close', code);
});

describe('CloudTool', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
        mockCache.clear();
        mockKv.get.mockClear();
        mockKv.set.mockClear();
        CloudTool.loading = false;
        mockSpawnSync.mockReturnValue({ status: 0, stdout: 'obscured\n', stderr: '' });
        // 将 mockSpawnSync 注册到 hoisted 引用，使 DriveProviderFactory mock 可以访问
        mockSpawnSyncForProvider.setMock(mockSpawnSync);
        mockKv.get.mockResolvedValue(null);
        mockSpawn.mockReset();
        mockGetDefaultDrive.mockReset();
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
            mockGetDefaultDrive.mockResolvedValue(null);
            await expect(CloudTool._getUserConfig('user123')).rejects.toThrow();
        });

        it('should return cleaned config for non-mega drive', async () => {
            mockGetDefaultDrive.mockResolvedValue({
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

        it('should verify and persist legacy plain password for mega drive', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                id: 'drive-mega',
                user_id: 'user123',
                type: 'mega',
                config_data: JSON.stringify({ user: 'testuser', pass: 'rawpass', pass_format: 'plain' })
            });
            mockSpawn
                .mockImplementationOnce(() => createClosedProcess({ stdout: 'obscuredpass\n' }))
                .mockImplementationOnce(() => createClosedProcess({ stdout: '[]' }));

            const result = await CloudTool._getUserConfig('user123');
            expect(result.pass).toBe('obscuredpass');
            expect(result.pass_format).toBe('rclone_obscured');
            expect(result.config_schema_version).toBe(1);
            expect(result.credential_verified).toBe(true);
            expect(result.credential_verification_version).toBe(1);
            expect(mockSpawn.mock.calls[0][1]).toEqual(['--config', '/dev/null', 'obscure', '--', 'rawpass']);
            expect(mockSpawn.mock.calls[1][1]).toEqual(['--config', '/dev/null', 'lsjson', '--max-depth', '1', ':mega,user="testuser",pass="obscuredpass":']);
            expect(MockDriveRepository.updateConfigData).toHaveBeenCalledWith('user123', 'drive-mega', expect.objectContaining({
                user: 'testuser',
                pass: 'obscuredpass',
                pass_format: 'rclone_obscured',
                config_schema_version: 1,
                credential_verified: true,
                credential_verification_version: 1,
                credential_migration_source: 'plain'
            }));
        });

        it('should not re-probe verified canonical rclone password configs', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                id: 'drive-mega',
                user_id: 'user123',
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'testuser',
                    pass: 'stored-obscured',
                    pass_format: 'rclone_obscured',
                    config_schema_version: 1,
                    credential_verified: true,
                    credential_verification_version: 1
                })
            });

            const result = await CloudTool._getUserConfig('user123');

            expect(result.pass).toBe('stored-obscured');
            expect(result.pass_format).toBe('rclone_obscured');
            expect(mockSpawn).not.toHaveBeenCalled();
            expect(MockDriveRepository.updateConfigData).not.toHaveBeenCalled();
        });

        it('should verify and canonicalize legacy unknown passwords when the stored credential works', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                id: 'drive-mega',
                user_id: 'user123',
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'testuser',
                    pass: 'stored-obscured',
                    pass_format: 'legacy_unknown',
                    config_schema_version: 1
                })
            });
            mockSpawn.mockImplementationOnce(() => createClosedProcess({ stdout: '[]' }));

            const result = await CloudTool._getUserConfig('user123');

            expect(result.pass).toBe('stored-obscured');
            expect(result.pass_format).toBe('rclone_obscured');
            expect(result.credential_verified).toBe(true);
            expect(mockSpawn.mock.calls[0][1]).toEqual(['--config', '/dev/null', 'lsjson', '--max-depth', '1', ':mega,user="testuser",pass="stored-obscured":']);
            expect(mockSpawn.mock.calls.some(call => call[1]?.includes('obscure'))).toBe(false);
            expect(MockDriveRepository.updateConfigData).toHaveBeenCalledWith('user123', 'drive-mega', expect.objectContaining({
                user: 'testuser',
                pass: 'stored-obscured',
                pass_format: 'rclone_obscured',
                config_schema_version: 1,
                credential_verified: true,
                credential_verification_version: 1,
                credential_migration_source: 'stored_legacy_unknown'
            }));
        });

        it('should repair historical canonical passwords that were actually stored as plain text', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                id: 'drive-mega',
                user_id: 'user123',
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'testuser',
                    pass: 'rawpass',
                    pass_format: 'rclone_obscured',
                    config_schema_version: 1
                })
            });
            mockSpawn
                .mockImplementationOnce(() => createClosedProcess({
                    stderr: `CRITICAL | Failed to create file system for ":mega,user="testuser",pass="rawpass":": couldn't login\n`,
                    code: 1
                }))
                .mockImplementationOnce(() => createClosedProcess({ stdout: 'repaired-obscured\n' }))
                .mockImplementationOnce(() => createClosedProcess({ stdout: '[]' }));

            const result = await CloudTool._getUserConfig('user123');

            expect(result.pass).toBe('repaired-obscured');
            expect(result.pass_format).toBe('rclone_obscured');
            expect(result.credential_verified).toBe(true);
            expect(mockSpawn.mock.calls[0][1]).toEqual(['--config', '/dev/null', 'lsjson', '--max-depth', '1', ':mega,user="testuser",pass="rawpass":']);
            expect(mockSpawn.mock.calls[1][1]).toEqual(['--config', '/dev/null', 'obscure', '--', 'rawpass']);
            expect(mockSpawn.mock.calls[2][1]).toEqual(['--config', '/dev/null', 'lsjson', '--max-depth', '1', ':mega,user="testuser",pass="repaired-obscured":']);
            expect(MockDriveRepository.updateConfigData).toHaveBeenCalledWith('user123', 'drive-mega', expect.objectContaining({
                pass: 'repaired-obscured',
                pass_format: 'rclone_obscured',
                credential_verified: true,
                credential_verification_version: 1,
                credential_migration_source: 'stored_plain_repaired_from_misclassified_rclone_obscured'
            }));
        });

        it('should not mutate credentials when the verification probe fails transiently', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                id: 'drive-mega',
                user_id: 'user123',
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'testuser',
                    pass: 'stored-obscured',
                    pass_format: 'rclone_obscured',
                    config_schema_version: 1
                })
            });
            mockSpawn.mockImplementationOnce(() => createClosedProcess({ stderr: 'TIMEOUT', code: -1 }));

            await expect(CloudTool._getUserConfig('user123')).rejects.toMatchObject({
                errorCode: 'RCLONE_TRANSIENT'
            });

            expect(mockSpawn).toHaveBeenCalledTimes(1);
            expect(MockDriveRepository.updateConfigData).not.toHaveBeenCalled();
        });
    });

    describe('_obscure', () => {
        it('should return obscured password on success', async () => {
            // mock spawn 行为来模拟 rclone obscure 成功
            mockSpawn.mockImplementation((cmd, args) => {
                const proc = createAutoProcess((p) => {
                    p.stdout.emit('data', 'obscured\n');
                    p.stdout.emit('end');
                    p.stderr.emit('end');
                    p.emit('close', 0);
                });
                return proc;
            });

            const result = await CloudTool._obscure('plain');
            expect(result).toBe('obscured');
        });

        it('should return original password on failure', async () => {
            // mock spawn 行为来模拟 rclone obscure 失败
            mockSpawn.mockImplementation((cmd, args) => {
                const proc = createAutoProcess((p) => {
                    p.stderr.emit('data', 'error\n');
                    p.stdout.emit('end');
                    p.stderr.emit('end');
                    p.emit('close', 1);  // 非 0 退出码
                });
                return proc;
            });

            const result = await CloudTool._obscure('plain');
            expect(result).toBe('plain');
        });

        it('should handle spawn error', async () => {
            // mock spawn 抛出错误
            mockSpawn.mockImplementation((cmd, args) => {
                const proc = createAutoProcess((p) => {
                    p.emit('error', new Error('spawn error'));
                });
                return proc;
            });

            const result = await CloudTool._obscure('plain');
            expect(result).toBe('plain');
        });

        it('should throw when required password obscure fails', async () => {
            mockSpawn.mockImplementation((cmd, args) => createAutoProcess((p) => {
                p.stderr.emit('data', 'error\n');
                p.stdout.emit('end');
                p.stderr.emit('end');
                p.emit('close', 1);
            }));

            await expect(CloudTool._obscureRequired('plain')).rejects.toThrow('error');
        });
    });

    describe('normalizePasswordForRclone', () => {
        it('should obscure raw passwords', async () => {
            mockSpawn
                .mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                    p.stderr.emit('data', 'input is not obscured\n');
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('close', 1);
                }))
                .mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                    p.stdout.emit('data', 'obscured-raw\n');
                    p.stdout.emit('end');
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.emit('close', 0);
                }));

            const result = await CloudTool.normalizePasswordForRclone('raw-secret');

            expect(result).toBe('obscured-raw');
            expect(mockSpawn.mock.calls[0][1]).toEqual(['--config', '/dev/null', 'reveal', '--', 'raw-secret']);
            expect(mockSpawn.mock.calls[1][1]).toEqual(['--config', '/dev/null', 'obscure', '--', 'raw-secret']);
        });

        it('should respect explicit plain password format instead of guessing from reveal', async () => {
            mockSpawn.mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                p.stdout.emit('data', 'obscured-via-explicit-format\n');
                p.stdout.emit('end');
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.emit('close', 0);
            }));

            const result = await CloudTool.normalizePasswordForRclone('legacy-plain-secret', { format: 'plain' });

            expect(result).toBe('obscured-via-explicit-format');
            expect(mockSpawn.mock.calls[0][1]).toEqual(['--config', '/dev/null', 'obscure', '--', 'legacy-plain-secret']);
        });

        it('should keep explicit rclone obscured passwords unchanged', async () => {
            const result = await CloudTool.normalizePasswordForRclone('already-obscured-token', { format: 'rclone_obscured' });

            expect(result).toBe('already-obscured-token');
            expect(mockSpawn).not.toHaveBeenCalled();
        });

        it('should not obscure passwords that rclone can already reveal', async () => {
            mockSpawn.mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                p.stdout.emit('data', 'plain-secret\n');
                p.stdout.emit('end');
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.emit('close', 0);
            }));

            const result = await CloudTool.normalizePasswordForRclone('already-obscured');

            expect(result).toBe('already-obscured');
            expect(mockSpawn).toHaveBeenCalledTimes(1);
            expect(mockSpawn.mock.calls[0][1]).toEqual(['--config', '/dev/null', 'reveal', '--', 'already-obscured']);
        });

        it('should preserve legacy unknown passwords that rclone can reveal', async () => {
            mockSpawn.mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                p.stdout.emit('data', 'plain-secret\n');
                p.stdout.emit('end');
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.emit('close', 0);
            }));

            const result = await CloudTool.normalizePasswordForRclone('already-obscured', { format: 'legacy_unknown' });

            expect(result).toBe('already-obscured');
            expect(mockSpawn).toHaveBeenCalledTimes(1);
            expect(mockSpawn.mock.calls[0][1]).toEqual(['--config', '/dev/null', 'reveal', '--', 'already-obscured']);
        });

        it('should pass password arguments after option terminator', async () => {
            mockSpawn
                .mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                    p.stderr.emit('data', 'input is not obscured\n');
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('close', 1);
                }))
                .mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                    p.stdout.emit('data', 'obscured-leading-dash\n');
                    p.stdout.emit('end');
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.emit('close', 0);
                }));

            const result = await CloudTool.normalizePasswordForRclone('-starts-with-dash');

            expect(result).toBe('obscured-leading-dash');
            expect(mockSpawn.mock.calls[0][1]).toEqual(['--config', '/dev/null', 'reveal', '--', '-starts-with-dash']);
            expect(mockSpawn.mock.calls[1][1]).toEqual(['--config', '/dev/null', 'obscure', '--', '-starts-with-dash']);
        });
    });

    describe('_isRetryableRcloneError', () => {
        it('should classify known transient rclone startup failures as retryable', () => {
            expect(CloudTool._isRetryableRcloneError('CRITICAL: Failed to create file system for ":mega,user="[REDACTED]",pass="[REDACTED]":folder": unexpected end of JSON input')).toBe(true);
            expect(CloudTool._isRetryableRcloneError('read tcp 1.2.3.4: connection reset by peer')).toBe(true);
            expect(CloudTool._isRetryableRcloneError('TLS handshake timeout')).toBe(true);
        });

        it('should not retry generic parse or EOF errors without transient context', () => {
            expect(CloudTool._isRetryableRcloneError('unexpected end of JSON input')).toBe(false);
            expect(CloudTool._isRetryableRcloneError('EOF')).toBe(false);
            expect(CloudTool._isRetryableRcloneError('authentication failed')).toBe(false);
        });

        it('should classify MEGA object-not-found login failures as remote-not-found guidance', () => {
            const result = CloudTool.classifyRcloneError(`CRITICAL | Failed to create file system for ":mega,user="[REDACTED]":folder": couldn't login: Object (typically, node or user) not found`);

            expect(result).toMatchObject({
                code: 'DRIVE_REMOTE_NOT_FOUND',
                retryable: false,
                userRetryable: true
            });
            expect(CloudTool._isRetryableRcloneError(`couldn't login: Object (typically, node or user) not found`)).toBe(false);
        });
    });

    describe('validateConfig', () => {
        it('should resolve success true when rclone returns 0', async () => {
            mockSpawn.mockImplementation((cmd, args) => {
                const proc = createAutoProcess((p) => {
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                });
                return proc;
            });
            const result = await CloudTool.validateConfig('mega', { user: 'u', pass: 'p', pass_format: 'rclone_obscured' });
            // 调试输出
            if (!result.success) {
                console.error('validateConfig failed:', result);
            }
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
            const result = await CloudTool.validateConfig('mega', { user: 'u', pass: 'p', pass_format: 'rclone_obscured' });
            expect(result.success).toBe(false);
            expect(result.reason).toBe('2FA');
        });

        it('should redact rclone stderr details when validation fails', async () => {
            mockSpawn.mockImplementation(() => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from(`CRITICAL: Failed to create file system for ":mega,user="user@example.com",pass="secret-pass":": couldn't login\n`));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));

            const result = await CloudTool.validateConfig('mega', { user: 'user@example.com', pass: 'secret-pass', pass_format: 'rclone_obscured' });

            expect(result.success).toBe(false);
            expect(result.details).toContain('user="[REDACTED]"');
            expect(result.details).toContain('pass="[REDACTED]"');
            expect(result.details).toContain("couldn't login");
            expect(result.details).not.toContain('user@example.com');
            expect(result.details).not.toContain('secret-pass');
        });

        it('should handle unexpected errors', async () => {
            mockSpawn.mockImplementation(() => { throw new Error('Unexpected'); });
            const result = await CloudTool.validateConfig('mega', { user: 'u', pass: 'p', pass_format: 'rclone_obscured' });
            expect(result.success).toBe(false);
            expect(result.reason).toBe('ERROR');
        });
    });

    describe('uploadFile', () => {
        let retryDelaySpy;

        beforeEach(() => {
            mockGetDefaultDrive.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });
            retryDelaySpy = vi.spyOn(CloudTool, '_retryDelay').mockResolvedValue(true);
        });

        afterEach(() => {
            retryDelaySpy?.mockRestore();
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

        it('should retain rclone JSON error logs as upload failure reason', async () => {
            mockSpawn.mockImplementationOnce(() => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from(JSON.stringify({
                    level: 'error',
                    msg: 'Failed to copy',
                    object: 'movie.mp4',
                    error: 'could not create file: quota exceeded'
                }) + '\n'));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));

            const result = await CloudTool.uploadFile('/local/path', { userId: 'user123' });

            expect(result.success).toBe(false);
            expect(result.error).toContain('Failed to copy');
            expect(result.error).toContain('quota exceeded');
            expect(result.error).not.toBe('Rclone exited with code 1');
        });

        it('should flush trailing stderr without newline before resolving upload failure', async () => {
            mockSpawn.mockImplementationOnce(() => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from('CRITICAL: upload failed without newline'));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));

            const result = await CloudTool.uploadFile('/local/path', { userId: 'user123' });

            expect(result.success).toBe(false);
            expect(result.error).toContain('upload failed without newline');
        });

        it('should redact sensitive rclone stderr from upload failures', async () => {
            mockSpawn.mockImplementation(() => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from(`CRITICAL: Failed to create file system for ":mega,user="user@example.com",pass="secret-pass":folder": unexpected end of JSON input\n`));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));

            const result = await CloudTool.uploadFile('/local/path', { userId: 'user123' });

            expect(result.success).toBe(false);
            expect(result.error).toContain('user="[REDACTED]"');
            expect(result.error).toContain('pass="[REDACTED]"');
            expect(result.error).toContain('unexpected end of JSON input');
            expect(result.error).not.toContain('user@example.com');
            expect(result.error).not.toContain('secret-pass');
            expect(mockSpawn).toHaveBeenCalledTimes(3);
        });

        it('should preserve remote-not-found metadata and skip process retries for permanent MEGA node failures', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'user@example.com',
                    pass: 'secret-pass',
                    pass_format: 'rclone_obscured',
                    config_schema_version: 1,
                    credential_verified: true,
                    credential_verification_version: 1
                })
            });
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="user@example.com",pass="secret-pass":folder": couldn't login: Object (typically, node or user) not found\n`));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stdout.emit('data', Buffer.from('[]'));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }));

            const result = await CloudTool.uploadFile('/local/path', { userId: 'user123' });

            expect(result).toMatchObject({
                success: false,
                retryable: false,
                userRetryable: true,
                errorCode: 'DRIVE_REMOTE_NOT_FOUND'
            });
            expect(result.userMessage).toContain('保存目录');
            expect(result.error).toContain('user="[REDACTED]"');
            expect(result.error).toContain('pass="[REDACTED]"');
            expect(result.error).not.toContain('user@example.com');
            expect(result.error).not.toContain('secret-pass');
            expect(mockSpawn).toHaveBeenCalledTimes(2);
        });

        it('should retry transient rclone filesystem creation failures before returning upload success', async () => {
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from('CRITICAL: Failed to create file system: unexpected end of JSON input\n'));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('data', Buffer.from('[]'));
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }));

            const result = await CloudTool.uploadFile('/local/path', { userId: 'user123' });

            expect(result.success).toBe(true);
            expect(mockSpawn).toHaveBeenCalledTimes(3);
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

    describe('stream upload helpers', () => {
        beforeEach(() => {
            mockGetDefaultDrive.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' }),
                remote_folder: '/Stream'
            });
        });

        it('should sanitize remote filenames to their basename', () => {
            expect(CloudTool.sanitizeRemoteFileName('../unsafe/path/movie.mkv')).toBe('movie.mkv');
            expect(CloudTool.sanitizeRemoteFileName('')).toBe('unnamed.bin');
        });

        it('should upload a local staging file with copyto under the sanitized remote name', async () => {
            mockSpawn.mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 0);
                p.emit('close', 0);
            }));
            mockSpawn.mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 0);
                p.emit('close', 0);
            }));

            const result = await CloudTool.uploadLocalFileToRemote('/tmp/task.part', '../movie.mkv', 'user123');

            expect(result).toEqual({ success: true, fileName: 'movie.mkv' });
            expect(mockSpawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['mkdir', expect.stringContaining('Stream')]));
            expect(mockSpawn.mock.calls[1]).toEqual([
                expect.any(String),
                expect.arrayContaining(['copyto', '/tmp/task.part', expect.stringContaining('Stream/movie.mkv')]),
                expect.any(Object)
            ]);
        });

        it('should cancel the copyto process when the abort signal fires', async () => {
            const controller = new AbortController();
            const proc = createAutoProcess();
            mockSpawn
                .mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }))
                .mockReturnValueOnce(proc);

            const uploadPromise = CloudTool.uploadLocalFileToRemote(
                '/tmp/task.part',
                'movie.mkv',
                'user123',
                undefined,
                { signal: controller.signal }
            );

            await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalledTimes(2));
            controller.abort();

            await expect(uploadPromise).resolves.toEqual({ success: false, error: 'Upload cancelled' });
            expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
        });

        it('should not spawn copyto when abort fires while preparing upload config', async () => {
            const controller = new AbortController();
            mockGetDefaultDrive.mockImplementationOnce(() => new Promise(resolve => {
                setTimeout(() => resolve({
                    type: 'drive',
                    config_data: JSON.stringify({ user: 'u', pass: 'p' }),
                    remote_folder: '/Stream'
                }), 20);
            }));

            const uploadPromise = CloudTool.uploadLocalFileToRemote(
                '/tmp/task.part',
                'movie.mkv',
                'user123',
                undefined,
                { signal: controller.signal }
            );
            controller.abort();

            await expect(uploadPromise).resolves.toEqual({ success: false, error: 'Upload cancelled' });
            await new Promise(resolve => setTimeout(resolve, 40));
            expect(mockSpawn).not.toHaveBeenCalled();
        });

        it('should delete a sanitized remote stream file', async () => {
            mockSpawn.mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 0);
                p.emit('close', 0);
            }));

            const result = await CloudTool.deleteRemoteFile('../movie.mkv', 'user123');

            expect(result).toEqual({ success: true });
            expect(mockSpawn).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining(['deletefile', expect.stringContaining('Stream/movie.mkv')]),
                expect.any(Object)
            );
        });

        it('should treat missing remote stream files as already deleted', async () => {
            mockSpawn.mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from('object not found\n'));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));

            await expect(CloudTool.deleteRemoteFile('missing.mkv', 'user123')).resolves.toEqual({ success: true });
        });

        it('should return failure when remote stream deletion fails for non-idempotent errors', async () => {
            mockSpawn.mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from('permission denied\n'));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));

            const result = await CloudTool.deleteRemoteFile('denied.mkv', 'user123');

            expect(result).toMatchObject({ success: false });
            expect(result.error).toContain('permission denied');
        });

        it('should redact sensitive rclone stderr from remote cleanup failures', async () => {
            mockSpawn.mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from(`CRITICAL: Failed to create file system for ":mega,user="user@example.com",pass="secret-pass":Stream/denied.mkv": couldn't login\n`));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));

            const result = await CloudTool.deleteRemoteFile('denied.mkv', 'user123');

            expect(result).toMatchObject({ success: false });
            expect(result.error).toContain('user="[REDACTED]"');
            expect(result.error).toContain('pass="[REDACTED]"');
            expect(result.error).not.toContain('user@example.com');
            expect(result.error).not.toContain('secret-pass');
        });

        it('should preserve failure metadata for external local-file uploads', async () => {
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="user@example.com",pass="secret-pass":Stream": couldn't login: Object (typically, node or user) not found\n`));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stdout.emit('data', Buffer.from('[]'));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }));

            const result = await CloudTool.uploadLocalFileToRemote('/tmp/task.part', 'movie.mkv', 'user123');

            expect(result).toMatchObject({
                success: false,
                retryable: false,
                userRetryable: true,
                errorCode: 'DRIVE_REMOTE_NOT_FOUND'
            });
            expect(result.userMessage).toContain('保存目录');
            expect(result.error).not.toContain('user@example.com');
            expect(result.error).not.toContain('secret-pass');
            expect(mockSpawn).toHaveBeenCalledTimes(2);
        });

        it('should create missing upload folders before external local-file uploads', async () => {
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }));

            const result = await CloudTool.uploadLocalFileToRemote('/tmp/task.part', 'movie.mkv', 'user123');

            expect(result).toEqual({ success: true, fileName: 'movie.mkv' });
            expect(mockSpawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['mkdir', expect.stringContaining('Stream')]));
            expect(mockSpawn.mock.calls[1][1]).toEqual(expect.arrayContaining(['copyto', '/tmp/task.part', expect.stringContaining('Stream/movie.mkv')]));
        });

        it('should classify mkdir object-not-found as remote folder guidance', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'u',
                    pass: 'p',
                    pass_format: 'rclone_obscured',
                    config_schema_version: 1,
                    credential_verified: true,
                    credential_verification_version: 1
                }),
                remote_folder: '/Stream'
            });
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="[REDACTED]":Stream": couldn't login: Object (typically, node or user) not found\n`));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stdout.emit('data', Buffer.from('[]'));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }));

            const result = await CloudTool.uploadLocalFileToRemote('/tmp/task.part', 'movie.mkv', 'user123');

            expect(result).toMatchObject({
                success: false,
                errorCode: 'DRIVE_REMOTE_NOT_FOUND',
                userRetryable: true
            });
            expect(result.userMessage).toContain('保存目录');
            expect(mockSpawn).toHaveBeenCalledTimes(2);
            expect(mockSpawn.mock.calls[1][1]).toEqual(expect.arrayContaining(['lsjson', '--max-depth', '1', expect.stringContaining(':mega')]));
        });

        it('should classify mkdir object-not-found as auth failure when the remote root is unavailable', async () => {
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="[REDACTED]":Stream": couldn't login: Object (typically, node or user) not found\n`));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="[REDACTED]":": couldn't login: Object (typically, node or user) not found\n`));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }));

            const result = await CloudTool.uploadLocalFileToRemote('/tmp/task.part', 'movie.mkv', 'user123');

            expect(result).toMatchObject({
                success: false,
                errorCode: 'DRIVE_AUTH_INVALID',
                userRetryable: false,
                retryable: false
            });
            expect(result.userMessage).toContain('无法登录');
            expect(mockSpawn).toHaveBeenCalledTimes(2);
        });

        it('should attempt to create the configured folder when MEGA reports node not found while listing files', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'u',
                    pass: 'p',
                    pass_format: 'rclone_obscured',
                    config_schema_version: 1,
                    credential_verified: true,
                    credential_verification_version: 1
                }),
                remote_folder: '/Stream'
            });
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="u",pass="p":Stream": couldn't login: Object (typically, node or user) not found\n`));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stdout.emit('data', Buffer.from('[]'));
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }));

            const files = await CloudTool.listRemoteFiles('user-node-missing', true);

            expect(files).toEqual([]);
            expect(mockSpawn).toHaveBeenCalledTimes(4);
            expect(mockSpawn.mock.calls[1][1]).toEqual(expect.arrayContaining(['lsjson', '--max-depth', '1', expect.stringContaining(':mega')]));
            expect(mockSpawn.mock.calls[2][1]).toEqual(expect.arrayContaining(['mkdir']));
        });

        it('should create rcat stream with an exact size hint when provided', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                type: 'drive',
                config_data: JSON.stringify({ user: 'u', pass: 'p' })
            });
            const proc = createAutoProcess();
            mockSpawn
                .mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }))
                .mockReturnValueOnce(proc);

            const result = await CloudTool.createRcatStream('../movie.mkv', 'user123', { size: 12345 });

            expect(result.fileName).toBe('movie.mkv');
            const args = mockSpawn.mock.calls[1][1];
            expect(args).toContain('rcat');
            expect(args).toContain('--size');
            expect(args).toContain('12345');
            expect(args).toEqual(expect.arrayContaining([expect.stringContaining('test-folder/movie.mkv')]));
        });

        it('should surface upload directory failures before opening rcat', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'u',
                    pass: 'p',
                    pass_format: 'rclone_obscured',
                    config_schema_version: 1,
                    credential_verified: true,
                    credential_verification_version: 1
                }),
                remote_folder: '/Missing'
            });
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="u",pass="p":Missing": couldn't login: Object (typically, node or user) not found\n`));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stdout.emit('data', Buffer.from('[]'));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }));

            await expect(CloudTool.createRcatStream('movie.mkv', 'user123')).rejects.toMatchObject({
                errorCode: 'DRIVE_REMOTE_NOT_FOUND',
                userRetryable: true,
                retryable: false
            });
            expect(mockSpawn).toHaveBeenCalledTimes(2);
        });

        it('should surface auth failures before opening rcat when mkdir and root probe both fail', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'u',
                    pass: 'p',
                    pass_format: 'rclone_obscured',
                    config_schema_version: 1,
                    credential_verified: true,
                    credential_verification_version: 1
                }),
                remote_folder: '/Missing'
            });
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="u",pass="p":Missing": couldn't login: Object (typically, node or user) not found\n`));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="u",pass="p":": couldn't login: Object (typically, node or user) not found\n`));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }));

            await expect(CloudTool.createRcatStream('movie.mkv', 'user123')).rejects.toMatchObject({
                errorCode: 'DRIVE_AUTH_INVALID',
                userRetryable: false,
                retryable: false
            });
            expect(mockSpawn).toHaveBeenCalledTimes(2);
        });

        it('should move a sanitized remote staging file to the final remote name', async () => {
            mockSpawn.mockImplementationOnce((cmd, args) => createAutoProcess((p) => {
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 0);
                p.emit('close', 0);
            }));

            const result = await CloudTool.moveRemoteFile('../stage.part', '../movie.mkv', 'user123');

            expect(result).toEqual({ success: true, fileName: 'movie.mkv' });
            expect(mockSpawn).toHaveBeenCalledWith(
                expect.any(String),
                expect.arrayContaining([
                    'moveto',
                    expect.stringContaining('Stream/stage.part'),
                    expect.stringContaining('Stream/movie.mkv')
                ]),
                expect.any(Object)
            );
        });
    });

    describe('listRemoteFiles', () => {
        beforeEach(() => {
            mockCacheService.get.mockReturnValue(null);
            mockGetDefaultDrive.mockResolvedValue({
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
            mockGetDefaultDrive.mockResolvedValue({
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

        it('should return null for a missing file only after the remote root is available', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'u',
                    pass: 'p',
                    pass_format: 'rclone_obscured',
                    config_schema_version: 1,
                    credential_verified: true,
                    credential_verification_version: 1
                }),
                remote_folder: '/Missing'
            });
            mockSpawn
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="u",pass="p":Missing/movie.mkv": couldn't login: Object (typically, node or user) not found\n`));
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.emit('exit', 1);
                    p.emit('close', 1);
                }))
                .mockImplementationOnce(() => createAutoProcess((p) => {
                    p.stdout.emit('data', Buffer.from('[]'));
                    p.stdout.emit('end');
                    p.stdout.emit('close');
                    p.stderr.emit('end');
                    p.stderr.emit('close');
                    p.emit('exit', 0);
                    p.emit('close', 0);
                }));

            const info = await CloudTool.getRemoteFileInfo('movie.mkv', 'user123', 1, true);

            expect(info).toBeNull();
            expect(mockSpawn).toHaveBeenCalledTimes(2);
            expect(mockSpawn.mock.calls[1][1]).toEqual(expect.arrayContaining([
                'lsjson',
                '--max-depth',
                '1',
                expect.stringContaining(':mega')
            ]));
        });

        it('should throw an actionable auth error when MEGA object-not-found also affects the remote root', async () => {
            mockGetDefaultDrive.mockResolvedValue({
                type: 'mega',
                config_data: JSON.stringify({
                    user: 'u',
                    pass: 'p',
                    pass_format: 'rclone_obscured',
                    config_schema_version: 1,
                    credential_verified: true,
                    credential_verification_version: 1
                }),
                remote_folder: '/Movies'
            });
            mockSpawn.mockImplementation(() => createAutoProcess((p) => {
                p.stderr.emit('data', Buffer.from(`CRITICAL | Failed to create file system for ":mega,user="u",pass="p":": couldn't login: Object (typically, node or user) not found\n`));
                p.stderr.emit('end');
                p.stderr.emit('close');
                p.stdout.emit('end');
                p.stdout.emit('close');
                p.emit('exit', 1);
                p.emit('close', 1);
            }));

            await expect(CloudTool.getRemoteFileInfo('movie.mkv', 'user123', 1, true)).rejects.toMatchObject({
                errorCode: 'DRIVE_AUTH_INVALID',
                userRetryable: false,
                retryable: false
            });
            expect(mockSpawn).toHaveBeenCalledTimes(2);
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
    
                it('should return false for path traversal attempts', () => {
                    expect(CloudTool._validatePath('/share/../etc/passwd')).toBe(false);
                    expect(CloudTool._validatePath('/share/..//etc/passwd')).toBe(false);
                    expect(CloudTool._validatePath('/../etc/passwd')).toBe(false);
                    expect(CloudTool._validatePath('/share/..')).toBe(false);
                    expect(CloudTool._validatePath('/share/./secret')).toBe(false);
                    expect(CloudTool._validatePath('/..')).toBe(false);
                });
    
                it('should return false for URL encoded path traversal', () => {
                    expect(CloudTool._validatePath('/share/%2e%2e/etc/passwd')).toBe(false);
                    expect(CloudTool._validatePath('/share/%2e./etc/passwd')).toBe(false);
                    expect(CloudTool._validatePath('/share/.%2e/etc/passwd')).toBe(false);
                    expect(CloudTool._validatePath('/%2e%2e/etc/passwd')).toBe(false);
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

            describe('_joinRemotePath', () => {
                it('should preserve colon-root remotes', () => {
                    expect(CloudTool._joinRemotePath(':drive,token="t":', 'Movies/', 'file.mkv'))
                        .toBe(':drive,token="t":Movies/file.mkv');
                });

                it('should insert slash when the connection string already includes a bucket root', () => {
                    expect(CloudTool._joinRemotePath(':s3,provider="Other":bucket', 'Movies/', 'file.mkv'))
                        .toBe(':s3,provider="Other":bucket/Movies/file.mkv');
                });

                it('should handle root upload path without duplicating separators', () => {
                    expect(CloudTool._joinRemotePath(':s3,provider="Other":bucket', '/', 'file.mkv'))
                        .toBe(':s3,provider="Other":bucket/file.mkv');
                });
            });
    
            describe('_getUploadPath', () => {
                it('should return custom path if set in D1', async () => {
                    mockGetDefaultDrive.mockResolvedValue({
                        remote_folder: '/Custom/Path'
                    });
                    const path = await CloudTool._getUploadPath('user123');
                    expect(path).toBe('Custom/Path/');
                });
    
                it('should return default path if not set in D1', async () => {
                    mockGetDefaultDrive.mockResolvedValue({
                        remote_folder: null
                    });
                    const path = await CloudTool._getUploadPath('user123');
                    expect(path).toBe('test-folder/');
                });
    
                it('should return default path if D1 query fails', async () => {
                    mockGetDefaultDrive.mockRejectedValue(new Error('DB Error'));
                    const path = await CloudTool._getUploadPath('user123');
                    expect(path).toBe('test-folder/');
                });
            });
        });
    });
});
