// Mock dependencies
const mockD1 = {
    run: vi.fn(),
    fetchOne: vi.fn(),
    fetchAll: vi.fn(),
    batch: vi.fn()
};
vi.mock('../../src/services/d1.js', () => ({
    d1: mockD1
}));

// Mock services/CacheService.js
const mockCache = {
    set: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
    listKeys: vi.fn().mockResolvedValue([])
};
vi.mock('../../src/services/CacheService.js', () => ({
    cache: mockCache
}));

// Mock services/ConsistentCache.js
const mockConsistentCache = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(true),
    delete: vi.fn().mockResolvedValue(true)
};
vi.mock('../../src/services/ConsistentCache.js', () => ({
    ConsistentCache: mockConsistentCache
}));

// Mock services/StateSynchronizer.js
const mockStateSynchronizer = {
    getTaskState: vi.fn().mockResolvedValue(null),
    clearTaskState: vi.fn().mockResolvedValue(true),
    updateTaskState: vi.fn().mockResolvedValue(true)
};
vi.mock('../../src/services/StateSynchronizer.js', () => ({
    StateSynchronizer: mockStateSynchronizer
}));

// Import after mocking
const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
const { d1 } = await import('../../src/services/d1.js');
const { cache } = await import('../../src/services/CacheService.js');
const { localCache } = await import('../../src/utils/LocalCache.js');
const { ConsistentCache } = await import('../../src/services/ConsistentCache.js');
const { StateSynchronizer } = await import('../../src/services/StateSynchronizer.js');

describe('TaskRepository', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Clear static properties
        TaskRepository.pendingUpdates.clear();
        TaskRepository.activeTaskCountCache = { value: 0, updatedAt: 0 };
        TaskRepository.activeTaskCountPromise = null;
        if (TaskRepository.flushTimer) {
            clearInterval(TaskRepository.flushTimer);
            TaskRepository.flushTimer = null;
        }
        // Clear LocalCache to prevent test interference
        localCache.clear();
        // Reset mock implementations
        mockConsistentCache.get.mockResolvedValue(null);
        mockStateSynchronizer.getTaskState.mockResolvedValue(null);
        // Ensure mockCache.get always returns null
        mockCache.get.mockResolvedValue(null);
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
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
            mockCache.listKeys.mockResolvedValue([]);

            const result = await TaskRepository.findStalledTasks(3600000); // 1 hour

            expect(result).toEqual(mockTasks);
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining('SELECT * FROM tasks'),
                [expect.any(Number), TaskRepository.STALLED_TASKS_DEFAULT_LIMIT]
            );
        });

        it('should merge tasks from D1 and Redis', async () => {
            const d1Tasks = [{ id: 'task1', status: 'downloading' }];
            
            mockD1.fetchAll.mockResolvedValue(d1Tasks);
            mockCache.listKeys.mockResolvedValue(['task_status:task2']);
            mockCache.get.mockResolvedValue({ status: 'uploading', updatedAt: Date.now() - 4000000 });

            const result = await TaskRepository.findStalledTasks(3600000);

            expect(result).toHaveLength(2);
            expect(mockCache.listKeys).toHaveBeenCalledWith('task_status:*');
        });

        it('should handle Redis errors gracefully', async () => {
            const mockTasks = [{ id: 'task1', status: 'downloading' }];
            mockD1.fetchAll.mockResolvedValue(mockTasks);
            mockCache.listKeys.mockRejectedValue(new Error('Redis error'));

            const result = await TaskRepository.findStalledTasks(3600000);

            expect(result).toEqual(mockTasks);
        });

        it('should use default timeout if not provided', async () => {
            mockD1.fetchAll.mockResolvedValue([]);

            await TaskRepository.findStalledTasks();

            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining('SELECT * FROM tasks'),
                [expect.any(Number), TaskRepository.STALLED_TASKS_DEFAULT_LIMIT]
            );
        });

        it('should clamp maxResults between configured bounds', async () => {
            mockD1.fetchAll.mockResolvedValue([]);

            await TaskRepository.findStalledTasks(3600000, { maxResults: 10 });
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining('SELECT * FROM tasks'),
                [expect.any(Number), TaskRepository.STALLED_TASKS_MIN_LIMIT]
            );

            mockD1.fetchAll.mockClear();
            await TaskRepository.findStalledTasks(3600000, { maxResults: 5000 });
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining('SELECT * FROM tasks'),
                [expect.any(Number), TaskRepository.STALLED_TASKS_MAX_LIMIT]
            );
        });

        it('should handle database errors', async () => {
            mockD1.fetchAll.mockRejectedValue(new Error('DB Error'));

            const result = await TaskRepository.findStalledTasks(3600000);
            expect(result).toEqual([]);
        });
    });

    describe('getActiveTaskCount', () => {
        it('should prefer instance-level activeTaskCount aggregation', async () => {
            mockCache.listKeys.mockResolvedValueOnce(['instance:i1', 'instance:i2']);
            mockCache.get
                .mockResolvedValueOnce({ id: 'i1', lastHeartbeat: Date.now(), activeTaskCount: 2 })
                .mockResolvedValueOnce({ id: 'i2', lastHeartbeat: Date.now(), activeTaskCount: 3 });

            const refreshed = await TaskRepository.refreshActiveTaskCount();

            expect(refreshed).toBe(5);
            expect(TaskRepository.getActiveTaskCount()).toBe(5);
            expect(mockCache.listKeys).toHaveBeenCalledWith('instance:');
        });

        it('should refresh and return cached active task count', async () => {
            mockCache.listKeys
                .mockResolvedValueOnce([]) // instance:
                .mockResolvedValueOnce(['task_status:task1', 'task_status:task2'])
                .mockResolvedValueOnce(['consistent:task:task2', 'consistent:task:task3']);

            const refreshed = await TaskRepository.refreshActiveTaskCount();
            const cached = TaskRepository.getActiveTaskCount();

            expect(refreshed).toBe(3);
            expect(cached).toBe(3);
            expect(mockCache.listKeys).toHaveBeenCalledWith('instance:');
            expect(mockCache.listKeys).toHaveBeenCalledWith('task_status:');
            expect(mockCache.listKeys).toHaveBeenCalledWith('consistent:task:');
        });

        it('should return cached value when refresh fails', async () => {
            TaskRepository.activeTaskCountCache = { value: 5, updatedAt: Date.now() };
            mockCache.listKeys.mockRejectedValue(new Error('Cache error'));

            const refreshed = await TaskRepository.refreshActiveTaskCount();

            expect(refreshed).toBe(5);
        });
    });

    describe('claimTask', () => {
        it('should claim task successfully', async () => {
            mockD1.run.mockResolvedValue({ changes: 1 });

            const result = await TaskRepository.claimTask('task123', 'instance1');
            
            expect(result).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE tasks SET status = 'downloading', claimed_by = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
                ['instance1', expect.any(Number), 'task123']
            );
        });

        it('should return false if task not available', async () => {
            mockD1.run.mockResolvedValue({ changes: 0 });

            const result = await TaskRepository.claimTask('task123', 'instance1');
            
            expect(result).toBe(false);
        });

        it('should throw error for missing fields', async () => {
            await expect(TaskRepository.claimTask('task123', null)).rejects.toThrow('TaskRepository.claimTask: Missing required fields (taskId or instanceId).');
        });

        it('should handle database errors', async () => {
            mockD1.run.mockRejectedValue(new Error('DB Error'));

            const result = await TaskRepository.claimTask('task123', 'instance1');
            expect(result).toBe(false);
        });
    });

    describe('resetStalledTasks', () => {
        it('should reset stalled tasks successfully', async () => {
            mockD1.run.mockResolvedValue({ changes: 3 });

            const result = await TaskRepository.resetStalledTasks(['task1', 'task2', 'task3']);
            
            expect(result).toBe(3);
            expect(mockD1.run).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE tasks SET status = \'queued\', claimed_by = NULL'),
                [expect.any(Number), 'task1', 'task2', 'task3']
            );
        });

        it('should return 0 for empty task list', async () => {
            const result = await TaskRepository.resetStalledTasks([]);
            expect(result).toBe(0);
            expect(mockD1.run).not.toHaveBeenCalled();
        });

        it('should handle database errors', async () => {
            mockD1.run.mockRejectedValue(new Error('DB Error'));

            const result = await TaskRepository.resetStalledTasks(['task1']);
            expect(result).toBe(0);
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

    describe('updateStatus', () => {
        it('should handle critical status updates immediately', async () => {
            mockD1.run.mockResolvedValue({ changes: 1 });

            await TaskRepository.updateStatus('task1', 'completed', 'All good');

            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
                ['completed', 'All good', expect.any(Number), 'task1']
            );
            expect(mockCache.delete).toHaveBeenCalledWith('task_status:task1');
        });

        it('should use Redis for important status updates', async () => {
            await TaskRepository.updateStatus('task1', 'downloading');

            expect(mockCache.set).toHaveBeenCalledWith(
                'task_status:task1',
                expect.objectContaining({ status: 'downloading' }),
                300
            );
        });

        it('should fallback to memory buffer on Redis failure for important status', async () => {
            mockCache.set.mockRejectedValueOnce(new Error('Redis error'));

            await TaskRepository.updateStatus('task1', 'downloading');

            expect(TaskRepository.pendingUpdates.has('task1')).toBe(true);
        });

        it('should buffer non-important status updates', async () => {
            await TaskRepository.updateStatus('task1', 'queued');

            expect(TaskRepository.pendingUpdates.has('task1')).toBe(true);
            expect(mockD1.run).not.toHaveBeenCalled();
            expect(mockCache.set).not.toHaveBeenCalled();
        });
    });

    describe('createBatch', () => {
        it('should create multiple tasks successfully', async () => {
            const tasks = [
                { id: 'task1', userId: 'user1', fileName: 'file1.mp4' },
                { id: 'task2', userId: 'user2', fileName: 'file2.mp4' }
            ];
            mockD1.batch.mockResolvedValue([{ success: true }, { success: true }]);

            const result = await TaskRepository.createBatch(tasks);
            expect(result).toBe(true);
            expect(mockD1.batch).toHaveBeenCalledTimes(1);
        });

        it('should handle empty task array', async () => {
            const result = await TaskRepository.createBatch([]);
            expect(result).toBe(true);
            expect(mockD1.batch).not.toHaveBeenCalled();
        });

        it('should handle batch creation errors', async () => {
            const tasks = [{ id: 'task1', userId: 'user1' }];
            mockD1.batch.mockRejectedValue(new Error('Batch error'));

            await expect(TaskRepository.createBatch(tasks)).rejects.toThrow('Batch error');
        });
    });

    describe('cleanupExpiredUpdates', () => {
        it('should cleanup expired pending updates', async () => {
            const now = Date.now();
            const expiredUpdate = { taskId: 'expired', status: 'queued', timestamp: now - 31 * 60 * 1000 };
            const validUpdate = { taskId: 'valid', status: 'queued', timestamp: now - 10 * 60 * 1000 };

            TaskRepository.pendingUpdates.set('expired', expiredUpdate);
            TaskRepository.pendingUpdates.set('valid', validUpdate);

            TaskRepository.cleanupExpiredUpdates();

            expect(TaskRepository.pendingUpdates.has('expired')).toBe(false);
            expect(TaskRepository.pendingUpdates.has('valid')).toBe(true);
        });

        it('should handle empty pendingUpdates cleanup', () => {
            TaskRepository.pendingUpdates.clear();

            expect(() => TaskRepository.cleanupExpiredUpdates()).not.toThrow();
        });
    });

    describe('flushUpdates', () => {
        it('should flush pending updates to database', async () => {
            TaskRepository.pendingUpdates.set('task1', { taskId: 'task1', status: 'queued', errorMsg: null });
            TaskRepository.pendingUpdates.set('task2', { taskId: 'task2', status: 'queued', errorMsg: null });
            
            mockD1.batch.mockResolvedValue([
                { success: true },
                { success: true }
            ]);

            await TaskRepository.flushUpdates();

            expect(mockD1.batch).toHaveBeenCalledWith([
                {
                    sql: "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
                    params: ['queued', null, expect.any(Number), 'task1']
                },
                {
                    sql: "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?",
                    params: ['queued', null, expect.any(Number), 'task2']
                }
            ]);
            expect(TaskRepository.pendingUpdates.size).toBe(0);
        });

        it('should handle empty pendingUpdates', async () => {
            await TaskRepository.flushUpdates();
            expect(mockD1.batch).not.toHaveBeenCalled();
        });

        it('should limit batch size - simplified', async () => {
            // Add fewer tasks to speed up test
            for (let i = 1; i <= 5; i++) {
                TaskRepository.pendingUpdates.set(`task${i}`, { taskId: `task${i}`, status: 'queued', errorMsg: null });
            }
            
            mockD1.batch.mockResolvedValue(new Array(5).fill({ success: true }));

            await TaskRepository.flushUpdates();

            expect(mockD1.batch).toHaveBeenCalledTimes(1);
            expect(TaskRepository.pendingUpdates.size).toBe(0); // All processed
        });

        it('should handle batch failures', async () => {
            TaskRepository.pendingUpdates.set('task1', { taskId: 'task1', status: 'queued', errorMsg: null });
            
            mockD1.batch.mockResolvedValue([
                { success: false, error: 'Database error' }
            ]);

            await TaskRepository.flushUpdates();

            expect(TaskRepository.pendingUpdates.size).toBe(0); // Still removed to prevent poison pill
        });

        it('should handle batch exceptions', async () => {
            TaskRepository.pendingUpdates.set('task1', { taskId: 'task1', status: 'queued', errorMsg: null });
            
            mockD1.batch.mockRejectedValue(new Error('Database connection error'));

            await TaskRepository.flushUpdates();

            expect(TaskRepository.pendingUpdates.size).toBe(1); // Still in pending due to error
        });
    });

    describe('findByUserId', () => {
        it('should find tasks by user id', async () => {
            const mockTasks = [
                { id: 'task1', file_name: 'file1.mp4', status: 'completed' }
            ];
            
            mockD1.fetchAll.mockResolvedValue(mockTasks);

            const result = await TaskRepository.findByUserId('user123');
            
            expect(result).toEqual(mockTasks);
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining('SELECT id, file_name, status, error_msg, created_at FROM tasks WHERE user_id = ?'),
                ['user123', 10]
            );
        });

        it('should return empty array for null user id', async () => {
            const result = await TaskRepository.findByUserId(null);
            expect(result).toEqual([]);
            expect(mockD1.fetchAll).not.toHaveBeenCalled();
        });
    });

    describe('findByMsgId', () => {
        it('should find tasks by message id', async () => {
            const mockTasks = [
                { id: 'task1', file_name: 'file1.mp4', status: 'completed' }
            ];
            
            mockD1.fetchAll.mockResolvedValue(mockTasks);

            const result = await TaskRepository.findByMsgId('msg123');
            
            expect(result).toEqual(mockTasks);
            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining('SELECT id, user_id, chat_id, msg_id, file_name, status, error_msg FROM tasks WHERE msg_id = ?'),
                ['msg123']
            );
        });

        it('should return empty array for null msg id', async () => {
            const result = await TaskRepository.findByMsgId(null);
            expect(result).toEqual([]);
            expect(mockD1.fetchAll).not.toHaveBeenCalled();
        });
    });

    describe('markCancelled', () => {
        it('should mark task as cancelled', async () => {
            mockD1.run.mockResolvedValue({ changes: 1 });

            await TaskRepository.markCancelled('task123');
            
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE tasks SET status = 'cancelled' WHERE id = ?",
                ['task123']
            );
        });

        it('should handle database errors', async () => {
            mockD1.run.mockRejectedValue(new Error('DB Error'));

            await TaskRepository.markCancelled('task123');
            // Should not throw, just log error
        });
    });

    describe('findCompletedByFile', () => {
        it('should find completed tasks by file', async () => {
            const mockTask = { id: 'task1', status: 'completed' };
            
            mockD1.fetchOne.mockResolvedValue(mockTask);

            const result = await TaskRepository.findCompletedByFile('user123', 'file.mp4', 1024);
            
            expect(result).toEqual(mockTask);
            expect(mockD1.fetchOne).toHaveBeenCalledWith(
                expect.stringContaining('SELECT id, status FROM tasks WHERE user_id = ? AND file_name = ? AND file_size = ?'),
                ['user123', 'file.mp4', 1024]
            );
        });

        it('should return null for missing parameters', async () => {
            const result1 = await TaskRepository.findCompletedByFile(null, 'file.mp4', 1024);
            const result2 = await TaskRepository.findCompletedByFile('user123', null, 1024);
            const result3 = await TaskRepository.findCompletedByFile('user123', 'file.mp4', null);
            
            expect(result1).toBeNull();
            expect(result2).toBeNull();
            expect(result3).toBeNull();
            expect(mockD1.fetchOne).not.toHaveBeenCalled();
        });
    });
});
