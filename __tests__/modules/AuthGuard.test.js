import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock dependencies
const mockD1 = {
    fetchOne: jest.fn()
};
jest.unstable_mockModule('../../src/services/d1.js', () => ({
    d1: mockD1
}));

const mockConfig = { ownerId: null };
jest.unstable_mockModule('../../src/config/index.js', () => ({
    config: mockConfig
}));

const { AuthGuard } = await import('../../src/modules/AuthGuard.js');

describe('AuthGuard', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        AuthGuard.roleCache.clear();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('getRole', () => {
        it('should return DEFAULT_ROLE for null userId', async () => {
            const result = await AuthGuard.getRole(null);
            expect(result).toBe('user');
        });

        it('should return DEFAULT_ROLE for undefined userId', async () => {
            const result = await AuthGuard.getRole(undefined);
            expect(result).toBe('user');
        });

        it('should return owner role for ownerId', async () => {
            mockConfig.ownerId = '123456789';

            const result = await AuthGuard.getRole('123456789');
            expect(result).toBe('owner');

            mockConfig.ownerId = null; // reset
        });

        it('should return cached role if not expired', async () => {
            const now = Date.now();
            AuthGuard.roleCache.set('testUser', { role: 'vip', ts: now });

            const result = await AuthGuard.getRole('testUser');
            expect(result).toBe('vip');
            expect(mockD1.fetchOne).not.toHaveBeenCalled();
        });

        it('should fetch from database if not cached', async () => {
            mockD1.fetchOne.mockResolvedValue({ role: 'admin' });

            const result = await AuthGuard.getRole('testUser');
            expect(result).toBe('admin');
            expect(mockD1.fetchOne).toHaveBeenCalledWith("SELECT role FROM user_roles WHERE user_id = ?", ['testUser']);
        });

        it('should return DEFAULT_ROLE if database returns null', async () => {
            mockD1.fetchOne.mockResolvedValue(null);

            const result = await AuthGuard.getRole('testUser');
            expect(result).toBe('user');
        });

        it('should cache the fetched role', async () => {
            mockD1.fetchOne.mockResolvedValue({ role: 'vip' });

            await AuthGuard.getRole('testUser');
            expect(AuthGuard.roleCache.has('testUser')).toBe(true);
            expect(AuthGuard.roleCache.get('testUser').role).toBe('vip');
        });

        it('should return DEFAULT_ROLE on database error', async () => {
            mockD1.fetchOne.mockRejectedValue(new Error('DB Error'));

            const result = await AuthGuard.getRole('testUser');
            expect(result).toBe('user');
        });
    });

    describe('can', () => {
        it('should return false for null userId (user role lacks permission)', async () => {
            const result = await AuthGuard.can(null, 'task:cancel:any');
            expect(result).toBe(false); // user role doesn't have this permission
        });

        it('should return true for allowed role', async () => {
            mockD1.fetchOne.mockResolvedValue({ role: 'admin' });

            const result = await AuthGuard.can('testUser', 'task:cancel:any');
            expect(result).toBe(true);
        });

        it('should return false for disallowed role', async () => {
            mockD1.fetchOne.mockResolvedValue({ role: 'user' });

            const result = await AuthGuard.can('testUser', 'task:cancel:any');
            expect(result).toBe(false);
        });

        it('should return true for action with no restrictions', async () => {
            const result = await AuthGuard.can('testUser', 'some:action');
            expect(result).toBe(true); // ACL doesn't define this action
        });

        it('should return true for owner role', async () => {
            mockConfig.ownerId = 'owner123';

            const result = await AuthGuard.can('owner123', 'task:cancel:any');
            expect(result).toBe(true);

            mockConfig.ownerId = null; // reset
        });

        it('should allow admin to bypass maintenance mode', async () => {
            mockD1.fetchOne.mockResolvedValue({ role: 'admin' });

            const result = await AuthGuard.can('adminUser', 'maintenance:bypass');
            expect(result).toBe(true);
        });

        it('should not allow user to bypass maintenance mode', async () => {
            mockD1.fetchOne.mockResolvedValue({ role: 'user' });

            const result = await AuthGuard.can('regularUser', 'maintenance:bypass');
            expect(result).toBe(false);
        });
    });
});