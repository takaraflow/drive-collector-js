// Mock dependencies
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

const { AuthGuard } = await import('../../src/modules/AuthGuard.js');

describe('AuthGuard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        AuthGuard.roleCache.clear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
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

    describe('setRole', () => {
        it('should call d1.run with correct params and clear cache', async () => {
            mockD1.run.mockResolvedValue({ success: true });
            AuthGuard.roleCache.set('testUser', { role: 'user', ts: Date.now() });

            await AuthGuard.setRole('testUser', 'admin');

            expect(mockD1.run).toHaveBeenCalledWith(
                "INSERT OR REPLACE INTO user_roles (user_id, role) VALUES (?, ?)",
                ['testUser', 'admin']
            );
            expect(AuthGuard.roleCache.has('testUser')).toBe(false);
        });

        it('should return false if userId is missing', async () => {
             const result = await AuthGuard.setRole(null, 'admin');
             expect(result).toBe(false);
        });

        it('should throw error if d1 fails', async () => {
             mockD1.run.mockRejectedValue(new Error('DB Error'));
             await expect(AuthGuard.setRole('testUser', 'admin')).rejects.toThrow('DB Error');
        });
    });

    describe('removeRole', () => {
        it('should call d1.run with correct params and clear cache', async () => {
            mockD1.run.mockResolvedValue({ success: true });
            AuthGuard.roleCache.set('testUser', { role: 'admin', ts: Date.now() });

            await AuthGuard.removeRole('testUser');

            expect(mockD1.run).toHaveBeenCalledWith(
                "DELETE FROM user_roles WHERE user_id = ?",
                ['testUser']
            );
            expect(AuthGuard.roleCache.has('testUser')).toBe(false);
        });

        it('should return false if userId is missing', async () => {
             const result = await AuthGuard.removeRole(null);
             expect(result).toBe(false);
        });

        it('should throw error if d1 fails', async () => {
             mockD1.run.mockRejectedValue(new Error('DB Error'));
             await expect(AuthGuard.removeRole('testUser')).rejects.toThrow('DB Error');
        });
    });
});