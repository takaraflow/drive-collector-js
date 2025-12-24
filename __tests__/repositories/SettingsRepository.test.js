import { SettingsRepository } from '../src/repositories/SettingsRepository';

// Mock external dependencies
jest.mock('../src/services/d1.js', () => ({
  d1: {
    fetchOne: jest.fn(),
    fetchAll: jest.fn(),
    run: jest.fn()
  }
}));

describe('SettingsRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('get', () => {
    test('gets setting value for user', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockResolvedValue({ value: 'setting_value' });

      const result = await SettingsRepository.get(123, 'setting_key');

      expect(mockD1.fetchOne).toHaveBeenCalledWith(
        'SELECT value FROM user_settings WHERE user_id = ? AND key = ?',
        [123, 'setting_key']
      );
      expect(result).toBe('setting_value');
    });

    test('returns null when setting not found', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockResolvedValue(null);

      const result = await SettingsRepository.get(123, 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    test('sets setting value for user', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockResolvedValue();

      const result = await SettingsRepository.set(123, 'setting_key', 'new_value');

      expect(mockD1.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO user_settings'),
        [123, 'setting_key', 'new_value', expect.any(Number)]
      );
      expect(result).toBe(true);
    });
  });

  describe('getAll', () => {
    test('gets all settings for user', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      const mockSettings = [
        { key: 'setting1', value: 'value1' },
        { key: 'setting2', value: 'value2' }
      ];
      mockD1.fetchAll.mockResolvedValue(mockSettings);

      const result = await SettingsRepository.getAll(123);

      expect(mockD1.fetchAll).toHaveBeenCalledWith(
        'SELECT key, value FROM user_settings WHERE user_id = ?',
        [123]
      );
      expect(result).toEqual({
        setting1: 'value1',
        setting2: 'value2'
      });
    });

    test('returns empty object when no settings', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchAll.mockResolvedValue([]);

      const result = await SettingsRepository.getAll(123);

      expect(result).toEqual({});
    });
  });

  describe('delete', () => {
    test('deletes setting for user', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockResolvedValue();

      const result = await SettingsRepository.delete(123, 'setting_key');

      expect(mockD1.run).toHaveBeenCalledWith(
        'DELETE FROM user_settings WHERE user_id = ? AND key = ?',
        [123, 'setting_key']
      );
      expect(result).toBe(true);
    });
  });

  describe('getGlobal', () => {
    test('gets global setting', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockResolvedValue({ value: 'global_value' });

      const result = await SettingsRepository.getGlobal('global_key');

      expect(mockD1.fetchOne).toHaveBeenCalledWith(
        'SELECT value FROM global_settings WHERE key = ?',
        ['global_key']
      );
      expect(result).toBe('global_value');
    });
  });

  describe('setGlobal', () => {
    test('sets global setting', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockResolvedValue();

      const result = await SettingsRepository.setGlobal('global_key', 'global_value');

      expect(mockD1.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT OR REPLACE INTO global_settings'),
        ['global_key', 'global_value', expect.any(Number)]
      );
      expect(result).toBe(true);
    });
  });
});