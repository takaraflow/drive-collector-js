import { AuthGuard } from '../src/modules/AuthGuard';

// Mock external dependencies
jest.mock('../src/config/index.js', () => ({
  config: {
    ownerId: 12345
  }
}));

jest.mock('../src/services/d1.js', () => ({
  d1: {
    fetchOne: jest.fn()
  }
}));

describe('AuthGuard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear cache
    AuthGuard.roleCache?.clear();
  });

  describe('getRole', () => {
    test('returns default role for null/undefined userId', async () => {
      const role = await AuthGuard.getRole(null);
      expect(role).toBe('user');

      const role2 = await AuthGuard.getRole(undefined);
      expect(role2).toBe('user');
    });

    test('returns owner role for configured ownerId', async () => {
      const role = await AuthGuard.getRole(12345);
      expect(role).toBe('owner');
    });

    test('returns cached role if not expired', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockResolvedValue({ role: 'vip' });

      // First call
      const role1 = await AuthGuard.getRole(999);
      expect(role1).toBe('vip');
      expect(mockD1.fetchOne).toHaveBeenCalledTimes(1);

      // Second call (should use cache)
      const role2 = await AuthGuard.getRole(999);
      expect(role2).toBe('vip');
      expect(mockD1.fetchOne).toHaveBeenCalledTimes(1); // Still 1
    });

    test('fetches from database when cache expired', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockResolvedValue({ role: 'admin' });

      // Mock expired cache by setting old timestamp
      AuthGuard.roleCache?.set('999', { role: 'vip', ts: Date.now() - 10 * 60 * 1000 });

      const role = await AuthGuard.getRole(999);
      expect(role).toBe('admin');
      expect(mockD1.fetchOne).toHaveBeenCalledTimes(1);
    });

    test('returns default role when no database record', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockResolvedValue(null);

      const role = await AuthGuard.getRole(999);
      expect(role).toBe('user');
    });

    test('handles database errors gracefully', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockRejectedValue(new Error('DB error'));

      const role = await AuthGuard.getRole(999);
      expect(role).toBe('user');
    });
  });

  describe('can', () => {
    test('returns true for actions with no ACL restrictions', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockResolvedValue({ role: 'user' });

      const result = await AuthGuard.can(999, 'nonexistent_action');
      expect(result).toBe(true);
    });

    test('checks role hierarchy correctly', async () => {
      const mockD1 = require('../src/services/d1.js').d1;

      // Test admin can do maintenance:bypass
      mockD1.fetchOne.mockResolvedValue({ role: 'admin' });
      const result1 = await AuthGuard.can(999, 'maintenance:bypass');
      expect(result1).toBe(true);

      // Test user cannot do maintenance:bypass
      mockD1.fetchOne.mockResolvedValue({ role: 'user' });
      const result2 = await AuthGuard.can(999, 'maintenance:bypass');
      expect(result2).toBe(false);

      // Test vip can do task:cancel:any
      mockD1.fetchOne.mockResolvedValue({ role: 'vip' });
      const result3 = await AuthGuard.can(999, 'task:cancel:any');
      expect(result3).toBe(false); // vip rank 1, needs admin(2) or owner(3)
    });

    test('owner has all permissions', async () => {
      const result = await AuthGuard.can(12345, 'maintenance:bypass');
      expect(result).toBe(true);

      const result2 = await AuthGuard.can(12345, 'task:cancel:any');
      expect(result2).toBe(true);
    });
  });
});