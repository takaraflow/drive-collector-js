import { CloudTool } from '../src/services/rclone';

// Mock external dependencies
jest.mock('child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(),
  execSync: jest.fn()
}));

jest.mock('fs', () => ({
  existsSync: jest.fn(() => false) // Default: rclone not in /app/rclone/
}));

jest.mock('../src/config/index.js', () => ({
  config: {}
}));

jest.mock('../src/repositories/DriveRepository.js', () => ({
  DriveRepository: {
    findByUserId: jest.fn()
  }
}));

jest.mock('../src/locales/zh-CN.js', () => ({
  STRINGS: {
    drive: {
      user_id_required: 'User ID required',
      no_drive_found: 'No drive found'
    }
  }
}));

describe('CloudTool', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    CloudTool.cache = { data: null, time: 0, loading: false };
  });

  describe('_getUserConfig', () => {
    test('throws error for missing userId', async () => {
      await expect(CloudTool._getUserConfig(null)).rejects.toThrow('User ID required');
    });

    test('throws error when no drive found', async () => {
      const mockRepo = require('../src/repositories/DriveRepository.js').DriveRepository;
      mockRepo.findByUserId.mockResolvedValue(null);

      await expect(CloudTool._getUserConfig(123)).rejects.toThrow('No drive found');
    });

    test('returns config for mega drive with obscured password', async () => {
      const mockRepo = require('../src/repositories/DriveRepository.js').DriveRepository;
      const mockSpawnSync = require('child_process').spawnSync;

      mockRepo.findByUserId.mockResolvedValue({
        config_data: JSON.stringify({ user: 'test@example.com', pass: 'password123' }),
        type: 'mega'
      });

      mockSpawnSync.mockReturnValue({
        stdout: Buffer.from('obscured_password'),
        stderr: Buffer.from(''),
        status: 0
      });

      const config = await CloudTool._getUserConfig(123);

      expect(config).toEqual({
        type: 'mega',
        user: 'test@example.com',
        pass: 'obscured_password'
      });

      expect(mockSpawnSync).toHaveBeenCalledWith('rclone', ['obscure', 'password123'], expect.any(Object));
    });

    test('returns config for non-mega drive without obscuring', async () => {
      const mockRepo = require('../src/repositories/DriveRepository.js').DriveRepository;

      mockRepo.findByUserId.mockResolvedValue({
        config_data: JSON.stringify({ user: 'test@example.com', pass: 'password123' }),
        type: 'gdrive'
      });

      const config = await CloudTool._getUserConfig(123);

      expect(config).toEqual({
        type: 'gdrive',
        user: 'test@example.com',
        pass: 'password123'
      });
    });
  });

  describe('_obscure', () => {
    test('obscures password using rclone', () => {
      const mockSpawnSync = require('child_process').spawnSync;
      mockSpawnSync.mockReturnValue({
        stdout: Buffer.from('obscured_123'),
        stderr: Buffer.from(''),
        status: 0
      });

      const result = CloudTool._obscure('password');

      expect(result).toBe('obscured_123');
      expect(mockSpawnSync).toHaveBeenCalledWith('rclone', ['obscure', 'password'], expect.any(Object));
    });

    test('throws error on rclone obscure failure', () => {
      const mockSpawnSync = require('child_process').spawnSync;
      mockSpawnSync.mockReturnValue({
        stdout: Buffer.from(''),
        stderr: Buffer.from('rclone error'),
        status: 1
      });

      expect(() => CloudTool._obscure('password')).toThrow();
    });
  });

  describe('listRemoteFiles', () => {
    test('uses cache when available and not expired', async () => {
      CloudTool.cache = {
        data: ['file1.txt', 'file2.txt'],
        time: Date.now(),
        loading: false
      };

      const result = await CloudTool.listRemoteFiles(123);

      expect(result).toEqual(['file1.txt', 'file2.txt']);
      // Should not call rclone since cache is used
    });

    test('fetches from rclone when cache expired', async () => {
      const mockSpawn = require('child_process').spawn;
      const mockRepo = require('../src/repositories/DriveRepository.js').DriveRepository;

      mockRepo.findByUserId.mockResolvedValue({
        config_data: JSON.stringify({ user: 'test@example.com', pass: 'pass' }),
        type: 'mega'
      });

      const mockChildProcess = {
        stdout: {
          on: jest.fn((event, callback) => {
            if (event === 'data') callback(Buffer.from('file1.txt\nfile2.txt\n'));
          })
        },
        stderr: { on: jest.fn() },
        on: jest.fn((event, callback) => {
          if (event === 'close') callback(0);
        })
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      const result = await CloudTool.listRemoteFiles(123);

      expect(result).toEqual(['file1.txt', 'file2.txt']);
      expect(CloudTool.cache.data).toEqual(['file1.txt', 'file2.txt']);
    });
  });

  describe('uploadFile', () => {
    test('uploads file to remote', async () => {
      const mockSpawn = require('child_process').spawn;
      const mockRepo = require('../src/repositories/DriveRepository.js').DriveRepository;

      mockRepo.findByUserId.mockResolvedValue({
        config_data: JSON.stringify({ user: 'test@example.com', pass: 'pass' }),
        type: 'mega'
      });

      const mockChildProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn((event, callback) => {
          if (event === 'close') callback(0);
        })
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      const result = await CloudTool.uploadFile(123, '/local/file.mp4', 'remote/file.mp4');

      expect(result).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith('rclone', expect.arrayContaining(['copyto']), expect.any(Object));
    });

    test('throws error on upload failure', async () => {
      const mockSpawn = require('child_process').spawn;
      const mockRepo = require('../src/repositories/DriveRepository.js').DriveRepository;

      mockRepo.findByUserId.mockResolvedValue({
        config_data: JSON.stringify({ user: 'test@example.com', pass: 'pass' }),
        type: 'mega'
      });

      const mockChildProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn((event, callback) => {
          if (event === 'data') callback(Buffer.from('Upload failed'));
        }) },
        on: jest.fn((event, callback) => {
          if (event === 'close') callback(1); // Non-zero exit code
        })
      };
      mockSpawn.mockReturnValue(mockChildProcess);

      await expect(CloudTool.uploadFile(123, '/local/file.mp4', 'remote/file.mp4'))
        .rejects.toThrow();
    });
  });
});