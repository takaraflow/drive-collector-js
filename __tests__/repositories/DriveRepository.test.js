import { DriveRepository } from '../src/repositories/DriveRepository';

// Mock external dependencies
jest.mock('../src/services/d1.js', () => ({
  d1: {
    fetchOne: jest.fn(),
    run: jest.fn()
  }
}));

describe('DriveRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('findByUserId', () => {
    test('returns null for null/undefined/empty userId', async () => {
      const result1 = await DriveRepository.findByUserId(null);
      expect(result1).toBeNull();

      const result2 = await DriveRepository.findByUserId(undefined);
      expect(result2).toBeNull();

      const result3 = await DriveRepository.findByUserId('');
      expect(result3).toBeNull();
    });

    test('returns drive data for valid userId', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      const mockDrive = { id: 1, user_id: '123', name: 'test-drive', type: 'mega' };
      mockD1.fetchOne.mockResolvedValue(mockDrive);

      const result = await DriveRepository.findByUserId(123);

      expect(mockD1.fetchOne).toHaveBeenCalledWith(
        "SELECT * FROM user_drives WHERE user_id = ? AND status = 'active'",
        ['123']
      );
      expect(result).toEqual(mockDrive);
    });

    test('returns null when no drive found', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockResolvedValue(null);

      const result = await DriveRepository.findByUserId(123);

      expect(result).toBeNull();
    });

    test('handles database errors gracefully', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockRejectedValue(new Error('DB error'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = await DriveRepository.findByUserId(123);

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith('DriveRepository.findByUserId error for 123:', expect.any(Error));

      consoleSpy.mockRestore();
    });
  });

  describe('create', () => {
    test('throws error for missing required parameters', async () => {
      await expect(DriveRepository.create(null, 'name', {})).rejects.toThrow('Missing required parameters');
      await expect(DriveRepository.create(123, null, {})).rejects.toThrow('Missing required parameters');
      await expect(DriveRepository.create(123, 'name', null)).rejects.toThrow('Missing required parameters');
    });

    test('creates drive successfully', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockResolvedValue();

      const configData = { user: 'test@example.com', pass: 'password' };
      const result = await DriveRepository.create(123, 'Mega Drive', 'mega', configData);

      expect(mockD1.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_drives'),
        expect.arrayContaining(['123', 'Mega Drive', 'mega', JSON.stringify(configData)])
      );
      expect(result).toBe(true);
    });

    test('handles database errors', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockRejectedValue(new Error('DB error'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(DriveRepository.create(123, 'name', 'type', {}))
        .rejects.toThrow('DB error');

      expect(consoleSpy).toHaveBeenCalledWith('DriveRepository.create failed for 123:', expect.any(Error));

      consoleSpy.mockRestore();
    });
  });

  describe('update', () => {
    test('updates drive configuration', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockResolvedValue();

      const configData = { user: 'updated@example.com' };
      const result = await DriveRepository.update(123, configData);

      expect(mockD1.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_drives SET'),
        ['{"user":"updated@example.com"}', '123']
      );
      expect(result).toBe(true);
    });
  });

  describe('delete', () => {
    test('marks drive as inactive', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockResolvedValue();

      const result = await DriveRepository.delete(123);

      expect(mockD1.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE user_drives SET status = \'inactive\''),
        ['123']
      );
      expect(result).toBe(true);
    });
  });
});