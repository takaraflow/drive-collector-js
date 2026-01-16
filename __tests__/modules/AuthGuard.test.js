import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 1. 设置 Mocks (必须在 import 被测试模块之前)
const mockD1 = {
    fetchOne: vi.fn(),
    run: vi.fn()
};

vi.mock('../../src/services/d1.js', () => ({
    d1: mockD1
}));

const mockConfig = { ownerId: null };
vi.mock('../../src/config/index.js', () => ({
    config: mockConfig
}));

// Mock logger
vi.mock('../../src/services/logger/index.js', () => ({
    logger: {
        withModule: () => ({
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn()
        })
    }
}));

// 2. 动态导入被测试模块
const { AuthGuard } = await import('../../src/modules/AuthGuard.js');

describe('AuthGuard Core Logic', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        AuthGuard.roleCache.clear();
        mockConfig.ownerId = null;
    });

    describe('Role Hierarchy & Permissions', () => {
        // 定义测试用例矩阵：角色 vs 权限点 -> 预期结果
        const matrix = [
            // Banned User: 应该没有任何权限
            { role: 'banned', permission: 'file:view', expected: false },
            { role: 'banned', permission: 'drive:edit', expected: false },
            
            // User (默认): 可以看文件，可以管理自己的网盘，不能管理他人，不能用系统命令
            { role: 'user', permission: 'file:view', expected: true },
            { role: 'user', permission: 'drive:edit', expected: true }, // 下放后的权限
            { role: 'user', permission: 'task:manage', expected: false },
            { role: 'user', permission: 'system:admin', expected: false },

            // Trusted: 同 User + 潜在的高级功能
            { role: 'trusted', permission: 'drive:edit', expected: true },

            // Admin: 几乎所有权限
            { role: 'admin', permission: 'drive:edit', expected: true },
            { role: 'admin', permission: 'task:manage', expected: true },
            { role: 'admin', permission: 'system:admin', expected: true },
            { role: 'admin', permission: 'user:manage', expected: true },

            // Owner: 所有权限
            { role: 'owner', permission: 'system:admin', expected: true }
        ];

        matrix.forEach(({ role, permission, expected }) => {
            it(`Role [${role}] should ${expected ? 'have' : 'NOT have'} permission [${permission}]`, async () => {
                if (role === 'owner') {
                    // 模拟 Owner: 设置 config.ownerId
                    mockConfig.ownerId = '1001';
                    const result = await AuthGuard.can('1001', permission);
                    expect(result).toBe(expected);
                } else {
                    // 模拟其他角色: Mock DB 返回
                    mockD1.fetchOne.mockResolvedValue({ role });
                    const result = await AuthGuard.can('999', permission);
                    expect(result).toBe(expected);
                }
            });
        });
    });

    describe('getRole()', () => {
        it('should return "owner" for config.ownerId', async () => {
            mockConfig.ownerId = '1001';
            const role = await AuthGuard.getRole('1001');
            expect(role).toBe('owner');
            expect(mockD1.fetchOne).not.toHaveBeenCalled();
        });

        it('should return "user" (default) when DB returns null', async () => {
            mockD1.fetchOne.mockResolvedValue(null);
            const role = await AuthGuard.getRole('123');
            expect(role).toBe('user');
        });

        it('should return cached role without DB query', async () => {
            // First call: DB hit
            mockD1.fetchOne.mockResolvedValue({ role: 'admin' });
            await AuthGuard.getRole('888');
            expect(mockD1.fetchOne).toHaveBeenCalledTimes(1);

            // Second call: Cache hit
            const role = await AuthGuard.getRole('888');
            expect(role).toBe('admin');
            expect(mockD1.fetchOne).toHaveBeenCalledTimes(1); // Call count remains 1
        });

        it('should return "user" on DB error', async () => {
            mockD1.fetchOne.mockRejectedValue(new Error('DB Error'));
            const role = await AuthGuard.getRole('999');
            expect(role).toBe('user');
        });
    });

    describe('setRole()', () => {
        it('should write to DB and clear cache', async () => {
            mockD1.run.mockResolvedValue({ success: true });
            // Pre-fill cache
            AuthGuard.roleCache.set('123', { role: 'user', ts: Date.now() });

            await AuthGuard.setRole('123', 'admin');

            expect(mockD1.run).toHaveBeenCalledWith(
                expect.stringContaining('INSERT OR REPLACE'),
                ['123', 'admin']
            );
            // Cache should be cleared
            expect(AuthGuard.roleCache.has('123')).toBe(false);
        });
    });
});
