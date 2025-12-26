import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';

// Mock d1 service before importing DatabaseService
const mockD1 = {
    run: jest.fn(),
    fetchAll: jest.fn(),
    fetchOne: jest.fn(),
    batch: jest.fn()
};

jest.unstable_mockModule('../../src/services/d1.js', () => ({
    d1: mockD1
}));

// Now import DatabaseService after mocking
const { DatabaseService } = await import('../../src/services/database.js');

describe('DatabaseService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        DatabaseService.pendingUpdates.clear();
        if (DatabaseService.flushTimer) {
            clearInterval(DatabaseService.flushTimer);
            DatabaseService.flushTimer = null;
        }
        if (DatabaseService.cleanupTimer) {
            clearInterval(DatabaseService.cleanupTimer);
            DatabaseService.cleanupTimer = null;
        }

        // Setup default mock responses
        mockD1.run.mockResolvedValue({});
        mockD1.fetchAll.mockResolvedValue([]);
        mockD1.fetchOne.mockResolvedValue(null);
        mockD1.batch.mockResolvedValue([{ success: true }]);
    });

    afterEach(() => {
        jest.clearAllTimers();
    });

    describe('createTask', () => {
        test('should create a task successfully', async () => {
            const mockTaskData = {
                id: 'test-task-id',
                userId: 'test-user-id',
                chatId: 'test-chat-id',
                msgId: 123,
                sourceMsgId: 456,
                fileName: 'test.mp4',
                fileSize: 1024
            };

            mockD1.run.mockResolvedValue({});

            const result = await DatabaseService.createTask(mockTaskData);

            expect(result).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO tasks'),
                expect.arrayContaining([
                    'test-task-id',
                    'test-user-id',
                    'test-chat-id',
                    123,
                    456,
                    'test.mp4',
                    1024,
                    expect.any(Number),
                    expect.any(Number)
                ])
            );
        });

        test('should throw error for missing required fields', async () => {
            await expect(DatabaseService.createTask({})).rejects.toThrow('Missing required fields');
        });
    });

    describe('createBatchTasks', () => {
        test('should create multiple tasks successfully', async () => {
            const mockTasksData = [
                {
                    id: 'task-1',
                    userId: 'user-1',
                    chatId: 'chat-1',
                    msgId: 1,
                    sourceMsgId: 11,
                    fileName: 'file1.mp4',
                    fileSize: 1000
                },
                {
                    id: 'task-2',
                    userId: 'user-1',
                    chatId: 'chat-1',
                    msgId: 1,
                    sourceMsgId: 22,
                    fileName: 'file2.mp4',
                    fileSize: 2000
                }
            ];

            mockD1.batch.mockResolvedValue([]);

            const result = await DatabaseService.createBatchTasks(mockTasksData);

            expect(result).toBe(true);
            expect(mockD1.batch).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({
                        sql: expect.stringContaining('INSERT INTO tasks'),
                        params: expect.arrayContaining(['task-1', 'user-1'])
                    }),
                    expect.objectContaining({
                        sql: expect.stringContaining('INSERT INTO tasks'),
                        params: expect.arrayContaining(['task-2', 'user-1'])
                    })
                ])
            );
        });
    });

    describe('findPendingTasks', () => {
        test('should find pending tasks with default parameters', async () => {
            const mockTasks = [
                { id: 'task-1', status: 'queued' },
                { id: 'task-2', status: 'downloaded' }
            ];

            mockD1.fetchAll.mockResolvedValue(mockTasks);

            const result = await DatabaseService.findPendingTasks();

            expect(result).toEqual(mockTasks);
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining('SELECT * FROM tasks WHERE'),
                expect.arrayContaining([expect.any(Number)])
            );
        });

        test('should filter by specific status', async () => {
            const mockTasks = [{ id: 'task-1', status: 'queued' }];

            mockD1.fetchAll.mockResolvedValue(mockTasks);

            const result = await DatabaseService.findPendingTasks(300000, 'queued');

            expect(result).toEqual(mockTasks);
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining("status = ?"),
                expect.arrayContaining([expect.any(Number), 'queued'])
            );
        });
    });

    describe('updateTaskStatus', () => {
        test('should update critical status immediately', async () => {
            mockD1.run.mockResolvedValue({});

            const result = await DatabaseService.updateTaskStatus('task-1', 'completed', 'success');

            expect(mockD1.run).toHaveBeenCalledWith(
                'UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?',
                ['completed', 'success', expect.any(Number), 'task-1']
            );
            expect(DatabaseService.pendingUpdates.has('task-1')).toBe(false);
        });

        test('should buffer non-critical status updates', async () => {
            const result = await DatabaseService.updateTaskStatus('task-1', 'downloading');

            expect(DatabaseService.pendingUpdates.has('task-1')).toBe(true);
            expect(DatabaseService.flushTimer).toBeTruthy();
        });
    });

    describe('getTaskById', () => {
        test('should return task by id', async () => {
            const mockTask = { id: 'task-1', status: 'completed' };
            mockD1.fetchOne.mockResolvedValue(mockTask);

            const result = await DatabaseService.getTaskById('task-1');

            expect(result).toEqual(mockTask);
            expect(mockD1.fetchOne).toHaveBeenCalledWith('SELECT * FROM tasks WHERE id = ?', ['task-1']);
        });

        test('should return null for non-existent task', async () => {
            mockD1.fetchOne.mockResolvedValue(null);

            const result = await DatabaseService.getTaskById('non-existent');

            expect(result).toBeNull();
        });
    });

    describe('getTasksByMsgId', () => {
        test('should return tasks by message id', async () => {
            const mockTasks = [
                { id: 'task-1', status: 'completed' },
                { id: 'task-2', status: 'failed' }
            ];
            mockD1.fetchAll.mockResolvedValue(mockTasks);

            const result = await DatabaseService.getTasksByMsgId(123);

            expect(result).toEqual(mockTasks);
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                'SELECT id, file_name, status, error_msg FROM tasks WHERE msg_id = ? ORDER BY created_at ASC',
                [123]
            );
        });
    });

    describe('findCompletedTaskByFile', () => {
        test('should find completed task by file info', async () => {
            const mockTask = { id: 'task-1', status: 'completed' };
            mockD1.fetchOne.mockResolvedValue(mockTask);

            const result = await DatabaseService.findCompletedTaskByFile('user-1', 'test.mp4', 1024);

            expect(result).toEqual(mockTask);
            expect(mockD1.fetchOne).toHaveBeenCalledWith(
                expect.stringContaining('SELECT id, status FROM tasks WHERE'),
                ['user-1', 'test.mp4', 1024]
            );
        });
    });

    describe('flushUpdates', () => {
        test('should flush pending updates', async () => {
            DatabaseService.pendingUpdates.set('task-1', {
                taskId: 'task-1',
                status: 'downloading',
                errorMsg: null,
                timestamp: Date.now()
            });

            mockD1.batch.mockResolvedValue([{ success: true }]);

            await DatabaseService.flushUpdates();

            expect(mockD1.batch).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.objectContaining({
                        sql: expect.stringContaining('UPDATE tasks SET status'),
                        params: expect.arrayContaining(['downloading', null, expect.any(Number), 'task-1'])
                    })
                ])
            );
            expect(DatabaseService.pendingUpdates.size).toBe(0);
        });
    });

    describe('cleanupExpiredUpdates', () => {
        test('should clean up expired updates', () => {
            const expiredTimestamp = Date.now() - 31 * 60 * 1000; // 31 minutes ago

            DatabaseService.pendingUpdates.set('expired-task', {
                taskId: 'expired-task',
                status: 'downloading',
                timestamp: expiredTimestamp
            });

            DatabaseService.pendingUpdates.set('valid-task', {
                taskId: 'valid-task',
                status: 'uploading',
                timestamp: Date.now()
            });

            DatabaseService.cleanupExpiredUpdates();

            expect(DatabaseService.pendingUpdates.has('expired-task')).toBe(false);
            expect(DatabaseService.pendingUpdates.has('valid-task')).toBe(true);
        });
    });
});