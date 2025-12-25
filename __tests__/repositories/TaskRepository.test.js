import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock dependencies
const mockD1 = {
    run: jest.fn(),
    fetchOne: jest.fn(),
    fetchAll: jest.fn(),
    batch: jest.fn()
};
jest.unstable_mockModule('../../src/services/d1.js', () => ({
    d1: mockD1
}));

const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');

describe('TaskRepository', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Clear static properties
        TaskRepository.pendingUpdates.clear();
        if (TaskRepository.flushTimer) {
            clearInterval(TaskRepository.flushTimer);
            TaskRepository.flushTimer = null;
        }
    });

    describe('create', () => {
        it('should create a new task successfully', async () => {
            const taskData = {
                id: 'task123',
                userId: 'user456',
                chatId: 123456,
                msgId: 789,
                sourceMsgId: 101112,
                fileName: 'test.mp4',
                fileSize: 1048576
            };

            mockD1.run.mockResolvedValue({ success: true });

            const result = await TaskRepository.create(taskData);
            expect(result).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO tasks'),
                ['task123', 'user456', 123456, 789, 101112, 'test.mp4', 1048576, expect.any(Number), expect.any(Number)]
            );
        });

        it('should use default values for optional fields', async () => {
            const taskData = {
                id: 'task123',
                userId: 'user456'
            };

            mockD1.run.mockResolvedValue({ success: true });

            const result = await TaskRepository.create(taskData);
            expect(result).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO tasks'),
                ['task123', 'user456', undefined, undefined, undefined, 'unknown', 0, expect.any(Number), expect.any(Number)]
            );
        });

        it('should throw error for missing required fields', async () => {
            const taskData = { userId: 'user456' }; // missing id

            await expect(TaskRepository.create(taskData)).rejects.toThrow('TaskRepository.create: Missing required fields (id or userId).');
        });

        it('should handle database errors', async () => {
            const taskData = {
                id: 'task123',
                userId: 'user456'
            };

            mockD1.run.mockRejectedValue(new Error('DB Error'));

            await expect(TaskRepository.create(taskData)).rejects.toThrow('DB Error');
        });
    });

    describe('findStalledTasks', () => {
        it('should find stalled tasks', async () => {
            const mockTasks = [
                { id: 'task1', status: 'downloading' },
                { id: 'task2', status: 'uploading' }
            ];

            mockD1.fetchAll.mockResolvedValue(mockTasks);

            const result = await TaskRepository.findStalledTasks(3600000); // 1 hour

            expect(result).toEqual(mockTasks);
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.any(String),
                [expect.any(Number)]
            );
        });

        it('should use default timeout if not provided', async () => {
            mockD1.fetchAll.mockResolvedValue([]);

            await TaskRepository.findStalledTasks();

            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.any(String),
                [expect.any(Number)]
            );
        });

        it('should handle database errors', async () => {
            mockD1.fetchAll.mockRejectedValue(new Error('DB Error'));

            const result = await TaskRepository.findStalledTasks(3600000);
            expect(result).toEqual([]);
        });
    });

    describe('findById', () => {
        it('should find task by id', async () => {
            const mockTask = { id: 'task123', status: 'completed' };

            mockD1.fetchOne.mockResolvedValue(mockTask);

            const result = await TaskRepository.findById('task123');
            expect(result).toEqual(mockTask);
            expect(mockD1.fetchOne).toHaveBeenCalledWith("SELECT * FROM tasks WHERE id = ?", ['task123']);
        });

        it('should return null for non-existent task', async () => {
            mockD1.fetchOne.mockResolvedValue(null);

            const result = await TaskRepository.findById('nonexistent');
            expect(result).toBeNull();
        });

        it('should return null for null id', async () => {
            const result = await TaskRepository.findById(null);
            expect(result).toBeNull();
            expect(mockD1.fetchOne).not.toHaveBeenCalled();
        });

        it('should handle database errors', async () => {
            mockD1.fetchOne.mockRejectedValue(new Error('DB Error'));

            const result = await TaskRepository.findById('task123');
            expect(result).toBeNull();
        });
    });

    describe('markCancelled', () => {
        it('should mark task as cancelled', async () => {
            mockD1.run.mockResolvedValue({ success: true });

            await TaskRepository.markCancelled('task123');
            expect(mockD1.run).toHaveBeenCalledWith("UPDATE tasks SET status = 'cancelled' WHERE id = ?", ['task123']);
        });

        it('should handle database errors', async () => {
            mockD1.run.mockRejectedValue(new Error('DB Error'));

            // Should not throw, just log error
            await expect(TaskRepository.markCancelled('task123')).resolves.not.toThrow();
        });
    });

    describe('findByMsgId', () => {
        it('should find tasks by message id', async () => {
            const mockTasks = [
                { id: 'task1', file_name: 'file1.mp4', status: 'completed', error_msg: null },
                { id: 'task2', file_name: 'file2.mp4', status: 'downloading', error_msg: null }
            ];

            mockD1.fetchAll.mockResolvedValue(mockTasks);

            const result = await TaskRepository.findByMsgId(12345);
            expect(result).toEqual(mockTasks);
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                "SELECT id, file_name, status, error_msg FROM tasks WHERE msg_id = ? ORDER BY created_at ASC",
                [12345]
            );
        });

        it('should return empty array for null msgId', async () => {
            const result = await TaskRepository.findByMsgId(null);
            expect(result).toEqual([]);
            expect(mockD1.fetchAll).not.toHaveBeenCalled();
        });

        it('should handle database errors', async () => {
            mockD1.fetchAll.mockRejectedValue(new Error('DB Error'));

            const result = await TaskRepository.findByMsgId(12345);
            expect(result).toEqual([]);
        });
    });

    describe('createBatch', () => {
        it('should create multiple tasks in batch', async () => {
            const tasksData = [
                {
                    id: 'task1',
                    userId: 'user1',
                    chatId: 123,
                    msgId: 456,
                    sourceMsgId: 789,
                    fileName: 'file1.mp4',
                    fileSize: 1024
                },
                {
                    id: 'task2',
                    userId: 'user2',
                    chatId: 123,
                    msgId: 456,
                    sourceMsgId: 790,
                    fileName: 'file2.mp4',
                    fileSize: 2048
                }
            ];

            mockD1.batch.mockResolvedValue([{ success: true }, { success: true }]);

            const result = await TaskRepository.createBatch(tasksData);
            expect(result).toBe(true);
            expect(mockD1.batch).toHaveBeenCalledWith([
                {
                    sql: expect.stringContaining('INSERT INTO tasks'),
                    params: expect.arrayContaining(['task1', 'user1', 123, 456, 789, 'file1.mp4', 1024, expect.any(Number), expect.any(Number)])
                },
                {
                    sql: expect.stringContaining('INSERT INTO tasks'),
                    params: expect.arrayContaining(['task2', 'user2', 123, 456, 790, 'file2.mp4', 2048, expect.any(Number), expect.any(Number)])
                }
            ]);
        });

        it('should return true for empty tasks array', async () => {
            const result = await TaskRepository.createBatch([]);
            expect(result).toBe(true);
            expect(mockD1.batch).not.toHaveBeenCalled();
        });

        it('should return true for null tasks array', async () => {
            const result = await TaskRepository.createBatch(null);
            expect(result).toBe(true);
            expect(mockD1.batch).not.toHaveBeenCalled();
        });

        it('should handle database errors', async () => {
            const tasksData = [{
                id: 'task1',
                userId: 'user1'
            }];

            mockD1.batch.mockRejectedValue(new Error('DB Error'));

            await expect(TaskRepository.createBatch(tasksData)).rejects.toThrow('DB Error');
        });
    });
});