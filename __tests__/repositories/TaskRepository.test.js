import { TaskRepository } from '../src/repositories/TaskRepository';

// Mock external dependencies
jest.mock('../src/services/d1.js', () => ({
  d1: {
    fetchOne: jest.fn(),
    fetchAll: jest.fn(),
    run: jest.fn()
  }
}));

describe('TaskRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    test('creates a new task', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockResolvedValue();

      const taskData = {
        userId: 123,
        chatId: 456,
        msgId: 789,
        fileName: 'test.mp4',
        status: 'pending'
      };

      const result = await TaskRepository.create(taskData);

      expect(mockD1.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO tasks'),
        expect.arrayContaining([123, 456, 789, 'test.mp4', 'pending'])
      );
      expect(result).toBe(true);
    });
  });

  describe('findById', () => {
    test('finds task by id', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      const mockTask = { id: 'task1', status: 'completed' };
      mockD1.fetchOne.mockResolvedValue(mockTask);

      const result = await TaskRepository.findById('task1');

      expect(mockD1.fetchOne).toHaveBeenCalledWith(
        'SELECT * FROM tasks WHERE id = ?',
        ['task1']
      );
      expect(result).toEqual(mockTask);
    });

    test('returns null when task not found', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.fetchOne.mockResolvedValue(null);

      const result = await TaskRepository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByMsgId', () => {
    test('finds tasks by message id', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      const mockTasks = [{ id: 'task1' }, { id: 'task2' }];
      mockD1.fetchAll.mockResolvedValue(mockTasks);

      const result = await TaskRepository.findByMsgId(123, 456);

      expect(mockD1.fetchAll).toHaveBeenCalledWith(
        'SELECT * FROM tasks WHERE user_id = ? AND msg_id = ?',
        [123, 456]
      );
      expect(result).toEqual(mockTasks);
    });
  });

  describe('updateStatus', () => {
    test('updates task status', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockResolvedValue();

      const result = await TaskRepository.updateStatus('task1', 'completed');

      expect(mockD1.run).toHaveBeenCalledWith(
        'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
        ['completed', expect.any(Number), 'task1']
      );
      expect(result).toBe(true);
    });
  });

  describe('markCancelled', () => {
    test('marks task as cancelled', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockResolvedValue();

      const result = await TaskRepository.markCancelled('task1');

      expect(mockD1.run).toHaveBeenCalledWith(
        'UPDATE tasks SET status = \'cancelled\', updated_at = ? WHERE id = ?',
        [expect.any(Number), 'task1']
      );
      expect(result).toBe(true);
    });
  });

  describe('findStalledTasks', () => {
    test('finds tasks that have been running too long', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      const mockTasks = [{ id: 'stalled1' }, { id: 'stalled2' }];
      mockD1.fetchAll.mockResolvedValue(mockTasks);

      const result = await TaskRepository.findStalledTasks();

      expect(mockD1.fetchAll).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM tasks WHERE status IN'),
        [expect.any(Number)]
      );
      expect(result).toEqual(mockTasks);
    });
  });

  describe('findByUserId', () => {
    test('finds tasks for a specific user', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      const mockTasks = [{ id: 'task1', user_id: 123 }];
      mockD1.fetchAll.mockResolvedValue(mockTasks);

      const result = await TaskRepository.findByUserId(123);

      expect(mockD1.fetchAll).toHaveBeenCalledWith(
        'SELECT * FROM tasks WHERE user_id = ? ORDER BY created_at DESC',
        [123]
      );
      expect(result).toEqual(mockTasks);
    });
  });

  describe('delete', () => {
    test('deletes a task', async () => {
      const mockD1 = require('../src/services/d1.js').d1;
      mockD1.run.mockResolvedValue();

      const result = await TaskRepository.delete('task1');

      expect(mockD1.run).toHaveBeenCalledWith(
        'DELETE FROM tasks WHERE id = ?',
        ['task1']
      );
      expect(result).toBe(true);
    });
  });
});