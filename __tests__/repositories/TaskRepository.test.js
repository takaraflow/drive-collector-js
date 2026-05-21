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
    consistentCache: mockConsistentCache
}));

// Mock services/StateSynchronizer.js
const mockStateSynchronizer = {
    getTaskState: vi.fn().mockResolvedValue(null),
    clearTaskState: vi.fn().mockResolvedValue(true),
    updateTaskState: vi.fn().mockResolvedValue(true)
};
vi.mock('../../src/services/StateSynchronizer.js', () => ({
    stateSynchronizer: mockStateSynchronizer
}));

// Import after mocking
const { TaskRepository } = await import('../../src/repositories/TaskRepository.js');
const { d1 } = await import('../../src/services/d1.js');
const { cache } = await import('../../src/services/CacheService.js');
const { localCache } = await import('../../src/utils/LocalCache.js');
const { TASK_ACTIVE_STATUSES, TASK_EVENTS, TASK_STATUSES } = await import('../../src/domain/task-state-machine.js');

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
        mockD1.fetchOne.mockResolvedValue(null);
        mockD1.fetchAll.mockResolvedValue([]);
        mockD1.batch.mockResolvedValue([]);
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
                sourceType: 'external_url',
                sourceRef: { url: 'https://files.example.com/video.mp4', fileName: 'test.mp4' },
                fileName: 'test.mp4',
                fileSize: 1048576
            };

            mockD1.run.mockResolvedValue({ success: true });

            const result = await TaskRepository.create(taskData);
            expect(result).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO tasks'),
                [
                    'task123',
                    'user456',
                    123456,
                    789,
                    101112,
                    'external_url',
                    JSON.stringify({ url: 'https://files.example.com/video.mp4', fileName: 'test.mp4' }),
                    'test.mp4',
                    1048576,
                    TASK_STATUSES.QUEUED,
                    expect.any(Number),
                    expect.any(Number)
                ]
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
                [
                    'task123',
                    'user456',
                    undefined,
                    undefined,
                    undefined,
                    'telegram_media',
                    null,
                    'unknown',
                    0,
                    TASK_STATUSES.QUEUED,
                    expect.any(Number),
                    expect.any(Number)
                ]
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

            mockD1.batch.mockResolvedValue([
                { success: true, result: { results: [] } },
                { success: true, result: { results: mockTasks } },
                { success: true, result: { results: [] } },
                { success: true, result: { results: [] } }
            ]);
            mockCache.listKeys.mockResolvedValue([]);

            const result = await TaskRepository.findStalledTasks(3600000); // 1 hour

            expect(result).toEqual(mockTasks);
            expect(mockD1.batch).toHaveBeenCalledTimes(1);
            expect(mockD1.batch.mock.calls[0][0]).toHaveLength(TASK_ACTIVE_STATUSES.length);
            expect(mockD1.batch.mock.calls[0][0][0]).toEqual({
                sql: expect.stringContaining('WHERE status = ?'),
                params: [TASK_ACTIVE_STATUSES[0], expect.any(Number), TaskRepository.STALLED_TASKS_DEFAULT_LIMIT]
            });
            expect(mockD1.batch.mock.calls[0][0][0].sql).toContain('updated_at < ?');
            expect(mockD1.batch.mock.calls[0][0][0].sql).not.toContain('SELECT *');
        });

        it('should not merge cache-only task states into stalled recovery', async () => {
            const d1Tasks = [{ id: 'task1', status: 'downloading' }];
            
            mockD1.batch.mockResolvedValue([
                { success: true, result: { results: d1Tasks } },
                { success: true, result: { results: [] } },
                { success: true, result: { results: [] } },
                { success: true, result: { results: [] } }
            ]);
            mockCache.listKeys.mockResolvedValue(['task_status:task2']);
            mockCache.get.mockResolvedValue({ status: 'uploading', updatedAt: Date.now() - 4000000 });

            const result = await TaskRepository.findStalledTasks(3600000);

            expect(result).toEqual(d1Tasks);
            expect(mockCache.listKeys).not.toHaveBeenCalledWith('task_status:*');
        });

        it('should handle Redis errors gracefully', async () => {
            const mockTasks = [{ id: 'task1', status: 'downloading' }];
            mockD1.batch.mockResolvedValue([
                { success: true, result: { results: mockTasks } },
                { success: true, result: { results: [] } },
                { success: true, result: { results: [] } },
                { success: true, result: { results: [] } }
            ]);
            mockCache.listKeys.mockRejectedValue(new Error('Redis error'));

            const result = await TaskRepository.findStalledTasks(3600000);

            expect(result).toEqual(mockTasks);
        });

        it('should use default timeout if not provided', async () => {
            mockD1.batch.mockResolvedValue([]);

            await TaskRepository.findStalledTasks();

            expect(mockD1.batch.mock.calls[0][0][0].params).toEqual([
                TASK_ACTIVE_STATUSES[0],
                expect.any(Number),
                TaskRepository.STALLED_TASKS_DEFAULT_LIMIT
            ]);
        });

        it('should include retryable queue failed tasks only when requested', async () => {
            mockD1.batch.mockResolvedValue([]);
            mockD1.fetchAll.mockResolvedValue([]);

            await TaskRepository.findStalledTasks(3600000, { includeRetryableFailed: true });

            const [sql, params] = mockD1.fetchAll.mock.calls[0];
            expect(sql).toContain("error_msg LIKE ?");
            expect(params).toEqual([
                TASK_STATUSES.FAILED,
                expect.any(Number),
                ...TaskRepository.RETRYABLE_FAILED_ERROR_PATTERNS,
                TaskRepository.STALLED_TASKS_DEFAULT_LIMIT
            ]);
            expect(params).toContain("%Circuit breaker is OPEN%");
            expect(params).toContain("%TIMEOUT%");
            expect(params).toContain("%RCLONE_TRANSIENT%");
        });

        it('should not include retryable failed SQL when not requested', async () => {
            mockD1.batch.mockResolvedValue([]);

            await TaskRepository.findStalledTasks(3600000);

            expect(mockD1.fetchAll).not.toHaveBeenCalled();
            const statements = mockD1.batch.mock.calls.at(-1)[0];
            expect(statements).toHaveLength(TASK_ACTIVE_STATUSES.length);
            expect(statements[0].sql).toContain("status = ?");
            expect(statements[0].sql).not.toContain("error_msg LIKE");
            expect(statements[0].params).toEqual([
                TASK_ACTIVE_STATUSES[0],
                expect.any(Number),
                TaskRepository.STALLED_TASKS_DEFAULT_LIMIT
            ]);
        });

        it('should clamp maxResults between configured bounds', async () => {
            mockD1.batch.mockResolvedValue([]);

            await TaskRepository.findStalledTasks(3600000, { maxResults: 10 });
            expect(mockD1.batch.mock.calls[0][0][0].params.at(-1)).toBe(TaskRepository.STALLED_TASKS_MIN_LIMIT);

            mockD1.batch.mockClear();
            await TaskRepository.findStalledTasks(3600000, { maxResults: 5000 });
            expect(mockD1.batch.mock.calls[0][0][0].params.at(-1)).toBe(TaskRepository.STALLED_TASKS_MAX_LIMIT);
        });

        it('should merge active and retryable failed rows by original creation order', async () => {
            mockD1.batch.mockResolvedValue([
                { success: true, result: { results: [] } },
                { success: true, result: { results: [{ id: 'active-newer', status: 'downloading', created_at: 300 }] } },
                { success: true, result: { results: [] } },
                { success: true, result: { results: [] } }
            ]);
            mockD1.fetchAll.mockResolvedValue([{ id: 'failed-older', status: 'failed', created_at: 100 }]);

            const result = await TaskRepository.findStalledTasks(3600000, { includeRetryableFailed: true });

            expect(result.map(task => task.id)).toEqual(['failed-older', 'active-newer']);
            expect(mockD1.fetchAll).toHaveBeenCalledTimes(1);
            expect(mockD1.fetchAll.mock.calls[0][0]).toContain('WHERE status = ?');
            expect(mockD1.fetchAll.mock.calls[0][1]).toEqual([
                TASK_STATUSES.FAILED,
                expect.any(Number),
                ...TaskRepository.RETRYABLE_FAILED_ERROR_PATTERNS,
                TaskRepository.STALLED_TASKS_DEFAULT_LIMIT - 1
            ]);
        });

        it('should handle database errors', async () => {
            mockD1.batch.mockRejectedValue(new Error('DB Error'));

            const result = await TaskRepository.findStalledTasks(3600000);
            expect(result).toEqual([]);
        });

        it('should fall back to individual indexed status queries when batch is unavailable', async () => {
            const originalBatch = mockD1.batch;
            delete mockD1.batch;
            mockD1.fetchAll
                .mockResolvedValueOnce([{ id: 'queued-old', status: 'queued', created_at: 1 }])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const result = await TaskRepository.findStalledTasks(3600000);

            expect(result.map(task => task.id)).toEqual(['queued-old']);
            expect(mockD1.fetchAll).toHaveBeenCalledTimes(TASK_ACTIVE_STATUSES.length);
            expect(mockD1.fetchAll.mock.calls[0][0]).toContain('WHERE status = ?');
            expect(mockD1.fetchAll.mock.calls[0][1]).toEqual([
                TASK_ACTIVE_STATUSES[0],
                expect.any(Number),
                TaskRepository.STALLED_TASKS_DEFAULT_LIMIT
            ]);
            mockD1.batch = originalBatch;
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
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task123', status: 'queued' });
            mockD1.run.mockResolvedValue({ changes: 1 });

            const result = await TaskRepository.claimTask('task123', 'instance1', 'lease1');
            
            expect(result).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ?, claimed_by = ?, claim_lease_id = ? WHERE id = ? AND status = ?",
                ['downloading', null, expect.any(Number), 'instance1', 'lease1', 'task123', 'queued']
            );
        });

        it('should return false if task not available', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task123', status: 'completed' });
            mockD1.run.mockResolvedValue({ changes: 0 });

            const result = await TaskRepository.claimTask('task123', 'instance1', 'lease1');
            
            expect(result).toBe(false);
        });

        it('should throw error for missing fields', async () => {
            await expect(TaskRepository.claimTask('task123', null, 'lease1')).rejects.toThrow('TaskRepository.claimTask: Missing required fields (taskId, instanceId, or claimLeaseId).');
            await expect(TaskRepository.claimTask('task123', 'instance1', null)).rejects.toThrow('TaskRepository.claimTask: Missing required fields (taskId, instanceId, or claimLeaseId).');
        });

        it('should handle database errors', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task123', status: 'queued' });
            mockD1.run.mockRejectedValue(new Error('DB Error'));

            const result = await TaskRepository.claimTask('task123', 'instance1', 'lease1');
            expect(result).toBe(false);
        });
    });

    describe('resetStalledTasks', () => {
        it('should reset stalled tasks successfully', async () => {
            mockD1.fetchOne
                .mockResolvedValueOnce({ id: 'task1', status: 'downloading' })
                .mockResolvedValueOnce({ id: 'task2', status: 'downloaded' })
                .mockResolvedValueOnce({ id: 'task3', status: 'uploading' });
            mockD1.run.mockResolvedValue({ changes: 3 });

            const result = await TaskRepository.resetStalledTasks(['task1', 'task2', 'task3']);
            
            expect(result).toBe(3);
            expect(mockD1.run).toHaveBeenCalledTimes(3);
            expect(mockD1.run).toHaveBeenNthCalledWith(
                1,
                "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ?, claimed_by = NULL, claim_lease_id = NULL WHERE id = ? AND status = ?",
                ['queued', null, expect.any(Number), 'task1', 'downloading']
            );
        });

        it('should return 0 for empty task list', async () => {
            const result = await TaskRepository.resetStalledTasks([]);
            expect(result).toBe(0);
            expect(mockD1.run).not.toHaveBeenCalled();
        });

        it('should handle database errors', async () => {
            mockD1.fetchOne.mockRejectedValue(new Error('DB Error'));

            const result = await TaskRepository.resetStalledTasks(['task1']);
            expect(result).toBe(0);
        });
    });

    describe('findById', () => {
        it('should find task by id from D1 by default', async () => {
            const mockTask = { id: 'task123', status: 'completed' };

            mockD1.fetchOne.mockResolvedValue(mockTask);

            const result = await TaskRepository.findById('task123');
            expect(result).toEqual(mockTask);
            expect(mockCache.get).not.toHaveBeenCalledWith('task:task123:details', 'json');
            expect(mockD1.fetchOne).toHaveBeenCalledWith("SELECT * FROM tasks WHERE id = ?", ['task123']);
        });

        it('should not let stale detail cache override the default D1 read', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task123', status: 'completed' });

            const result = await TaskRepository.findById('task123');

            expect(result).toEqual({ id: 'task123', status: 'completed' });
            expect(mockCache.get).not.toHaveBeenCalledWith('task:task123:details', 'json');
        });

        it('should use detail cache only when explicitly allowed', async () => {
            const cachedTask = { id: 'task123', status: 'queued' };
            mockCache.get.mockResolvedValueOnce(cachedTask);

            const result = await TaskRepository.findById('task123', { allowCache: true });

            expect(result).toEqual(cachedTask);
            expect(mockCache.get).toHaveBeenCalledWith('task:task123:details', 'json');
            expect(mockD1.fetchOne).not.toHaveBeenCalled();
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

        it('should rethrow database errors instead of masking them as missing tasks', async () => {
            mockD1.fetchOne.mockRejectedValue(new Error('DB Error'));

            await expect(TaskRepository.findById('task123')).rejects.toThrow('DB Error');
        });
    });

    describe('task status SSOT reads', () => {
        it('should return D1 as canonical and keep derived views diagnostic', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task1', status: 'completed' });
            mockStateSynchronizer.getTaskState.mockResolvedValueOnce({ status: 'queued' });
            mockConsistentCache.get.mockResolvedValueOnce({ status: 'downloading' });
            TaskRepository.pendingUpdates.set('task1', { status: 'uploading' });

            const result = await TaskRepository.getTaskStatusFull('task1');

            expect(result).toMatchObject({
                source: 'd1',
                data: { id: 'task1', status: 'completed' },
                derivedViews: {
                    synchronizer: { status: 'queued' },
                    consistentCache: { status: 'downloading' },
                    memory: { status: 'uploading' }
                }
            });
        });

        it('should not return derived cache as canonical when D1 has no task', async () => {
            mockD1.fetchOne.mockResolvedValueOnce(null);
            mockStateSynchronizer.getTaskState.mockResolvedValueOnce({ status: 'downloading' });
            mockConsistentCache.get.mockResolvedValueOnce({ status: 'uploading' });
            TaskRepository.pendingUpdates.set('missing-task', { status: 'queued' });

            await expect(TaskRepository.inspectTaskStateViews('missing-task')).resolves.toEqual({
                canonicalSource: 'd1',
                canonical: null,
                derivedViews: {
                    synchronizer: { status: 'downloading' },
                    consistentCache: { status: 'uploading' },
                    memory: { status: 'queued' }
                }
            });
            await expect(TaskRepository.getTaskStatusFull('missing-task')).resolves.toBeNull();
            expect(mockD1.fetchOne).toHaveBeenCalledTimes(2);
        });

        it('should batch return only D1 canonical statuses', async () => {
            mockD1.fetchAll.mockResolvedValueOnce([
                { id: 'task1', status: 'queued', updated_at: 100 },
                { id: 'task2', status: 'completed', updated_at: 200 }
            ]);
            TaskRepository.pendingUpdates.set('task3', { status: 'uploading' });

            const result = await TaskRepository.getTaskStatusBatch(['task1', 'task2', 'task3']);

            expect(result).toEqual({
                task1: { source: 'd1', data: { id: 'task1', status: 'queued', updated_at: 100 } },
                task2: { source: 'd1', data: { id: 'task2', status: 'completed', updated_at: 200 } }
            });
            expect(mockConsistentCache.get).not.toHaveBeenCalled();
        });

        it('should fail closed instead of returning cache statuses when D1 batch read fails', async () => {
            mockD1.fetchAll.mockRejectedValueOnce(new Error('D1 unavailable'));
            TaskRepository.pendingUpdates.set('task1', { status: 'uploading' });

            await expect(TaskRepository.getTaskStatusBatch(['task1'])).rejects.toThrow('D1 unavailable');
        });

        it('should expose derived views on task info without changing canonical task fields', async () => {
            mockD1.fetchOne
                .mockResolvedValueOnce({ id: 'task1', status: 'completed' })
                .mockResolvedValueOnce({ id: 'task1', status: 'completed' });
            mockConsistentCache.get.mockResolvedValueOnce({ status: 'downloading' });

            const result = await TaskRepository.getTaskInfo('task1');

            expect(result).toMatchObject({
                id: 'task1',
                status: 'completed',
                canonicalStatusSource: 'd1',
                cacheStatus: 'derived',
                derivedStateViews: {
                    consistentCache: { status: 'downloading' }
                }
            });
        });
    });

    describe('transitionStatus', () => {
        it('should complete an uploading task with an atomic state check', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task1', status: 'uploading' });
            mockD1.run.mockResolvedValue({ changes: 1 });

            const result = await TaskRepository.transitionStatus('task1', 'completed', 'All good', { returnResult: true });

            expect(result.changed).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ?, claimed_by = NULL, claim_lease_id = NULL WHERE id = ? AND status = ?",
                ['completed', 'All good', expect.any(Number), 'task1', 'uploading']
            );
            expect(mockCache.delete).toHaveBeenCalledWith('task_status:task1');
        });

        it('should redact sensitive values before persisting task errors', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task1', status: 'uploading' });
            mockD1.run.mockResolvedValue({ changes: 1 });

            const errorMessage = 'Rclone failed :mega,user="user@example.com",pass="secret-pass": unexpected end of JSON input';
            await TaskRepository.transitionStatus('task1', 'failed', errorMessage, { returnResult: true });

            const params = mockD1.run.mock.calls[0][1];
            expect(params[1]).toContain('user="[REDACTED]"');
            expect(params[1]).toContain('pass="[REDACTED]"');
            expect(params[1]).toContain('unexpected end of JSON input');
            expect(params[1]).not.toContain('user@example.com');
            expect(params[1]).not.toContain('secret-pass');
        });

        it('should keep terminal states from being overwritten by stale work', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task1', status: 'completed' });

            const result = await TaskRepository.transitionStatus('task1', 'downloading', null, { returnResult: true });

            expect(result.blocked).toBe(true);
            expect(mockD1.run).not.toHaveBeenCalled();
        });

        it('should write active states to D1 and sync cache as a derived view', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task1', status: 'queued' });
            mockD1.run.mockResolvedValue({ changes: 1 });

            await TaskRepository.updateStatus('task1', 'downloading');

            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ? AND status = ?",
                ['downloading', null, expect.any(Number), 'task1', 'queued']
            );
            expect(mockCache.set).toHaveBeenCalledWith(
                'task_status:task1',
                expect.objectContaining({ status: 'downloading' }),
                300
            );
        });

        it('should allow retry from failed to queued', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task1', status: 'failed' });
            mockD1.run.mockResolvedValue({ changes: 1 });

            const result = await TaskRepository.transitionStatus('task1', 'queued', null, { returnResult: true });

            expect(result.changed).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ?, claimed_by = NULL, claim_lease_id = NULL WHERE id = ? AND status = ?",
                ['queued', null, expect.any(Number), 'task1', 'failed']
            );
        });

        it('should refresh an already queued retry with a fresh queue attempt', async () => {
            vi.setSystemTime(new Date('2026-05-18T00:00:00.000Z'));
            const previousUpdatedAt = Date.now();
            const expectedUpdatedAt = previousUpdatedAt + 1;
            mockD1.fetchOne.mockResolvedValueOnce({
                id: 'task1',
                status: 'queued',
                updated_at: previousUpdatedAt,
                claimed_by: 'stale-instance',
                claim_lease_id: 'stale-lease'
            });
            mockD1.run.mockResolvedValue({ changes: 1 });

            const result = await TaskRepository.transitionStatus('task1', TASK_EVENTS.RETRY, null, { returnResult: true });

            expect(result).toMatchObject({
                changed: true,
                blocked: false,
                fromStatus: 'queued',
                toStatus: 'queued',
                idempotent: false,
                queueAttempt: `queued:${expectedUpdatedAt}`
            });
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ?, claimed_by = NULL, claim_lease_id = NULL WHERE id = ? AND status = ?",
                ['queued', null, expectedUpdatedAt, 'task1', 'queued']
            );
            expect(mockCache.set).toHaveBeenCalledWith(
                'task_status:task1',
                expect.objectContaining({ status: 'queued', updatedAt: expectedUpdatedAt }),
                300
            );
        });

        it('should not reuse a stale queue attempt when queued retry refresh loses the write', async () => {
            vi.setSystemTime(new Date('2026-05-18T00:00:00.000Z'));
            const previousUpdatedAt = Date.now();
            mockD1.fetchOne
                .mockResolvedValueOnce({
                    id: 'task1',
                    status: 'queued',
                    updated_at: previousUpdatedAt
                })
                .mockResolvedValueOnce({
                    id: 'task1',
                    status: 'queued',
                    updated_at: previousUpdatedAt
                });
            mockD1.run.mockResolvedValue({ changes: 0 });

            const result = await TaskRepository.transitionStatus('task1', TASK_EVENTS.RETRY, null, { returnResult: true });

            expect(result).toMatchObject({
                changed: false,
                blocked: true,
                reason: 'Queued retry attempt refresh failed',
                queueAttempt: `queued:${previousUpdatedAt}`
            });
            expect(mockCache.set).not.toHaveBeenCalled();
        });

        it('should fence claimed task transitions by owner and lease', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({
                id: 'task1',
                status: 'downloading',
                claimed_by: 'instance1',
                claim_lease_id: 'lease1'
            });
            mockD1.run.mockResolvedValue({ changes: 1 });

            const result = await TaskRepository.transitionStatus('task1', 'downloaded', null, {
                requireClaim: true,
                claimedBy: 'instance1',
                claimLeaseId: 'lease1',
                returnResult: true
            });

            expect(result.changed).toBe(true);
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ? AND status = ? AND claimed_by = ? AND claim_lease_id = ?",
                ['downloaded', null, expect.any(Number), 'task1', 'downloading', 'instance1', 'lease1']
            );
        });

        it('should block stale claimed task transitions when the lease changed', async () => {
            mockD1.fetchOne
                .mockResolvedValueOnce({
                    id: 'task1',
                    status: 'downloading',
                    updated_at: 100,
                    claimed_by: 'instance1',
                    claim_lease_id: 'lease1'
                })
                .mockResolvedValueOnce({
                    id: 'task1',
                    status: 'downloading',
                    updated_at: 100,
                    claimed_by: 'instance2',
                    claim_lease_id: 'lease2'
                });
            mockD1.run.mockResolvedValue({ changes: 0 });

            const result = await TaskRepository.transitionStatus('task1', 'downloaded', null, {
                requireClaim: true,
                claimedBy: 'instance1',
                claimLeaseId: 'lease1',
                returnResult: true
            });

            expect(result.blocked).toBe(true);
            expect(result.reason).toBe('Task claim lease no longer matches current worker');
        });

        it('should not allow a stale completion event to overwrite failed', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task1', status: 'failed' });

            const result = await TaskRepository.transitionStatus('task1', 'completed', null, { returnResult: true });

            expect(result.blocked).toBe(true);
            expect(mockD1.run).not.toHaveBeenCalled();
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
            expect(mockD1.batch.mock.calls[0][0][0].params).toEqual([
                'task1',
                'user1',
                undefined,
                undefined,
                undefined,
                'telegram_media',
                null,
                'file1.mp4',
                0,
                TASK_STATUSES.QUEUED,
                expect.any(Number),
                expect.any(Number)
            ]);
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

        it('should reject partial D1 batch failures', async () => {
            const tasks = [
                { id: 'task1', userId: 'user1' },
                { id: 'task2', userId: 'user1' }
            ];
            mockD1.batch.mockResolvedValue([
                { success: true },
                { success: false, error: new Error('constraint failed') }
            ]);

            await expect(TaskRepository.createBatch(tasks)).rejects.toThrow('constraint failed');
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
            mockD1.fetchOne
                .mockResolvedValueOnce({ id: 'task1', status: 'failed' })
                .mockResolvedValueOnce({ id: 'task2', status: 'failed' });
            mockD1.run.mockResolvedValue({ changes: 1 });

            await TaskRepository.flushUpdates();

            expect(mockD1.run).toHaveBeenCalledTimes(2);
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
            mockD1.fetchOne.mockResolvedValue({ id: 'task', status: 'failed' });
            mockD1.run.mockResolvedValue({ changes: 1 });

            await TaskRepository.flushUpdates();

            expect(mockD1.run).toHaveBeenCalledTimes(5);
            expect(TaskRepository.pendingUpdates.size).toBe(0); // All processed
        });

        it('should handle batch failures', async () => {
            TaskRepository.pendingUpdates.set('task1', { taskId: 'task1', status: 'queued', errorMsg: null });
            mockD1.fetchOne.mockResolvedValue({ id: 'task1', status: 'failed' });
            mockD1.run.mockResolvedValue({ changes: 0 });

            await TaskRepository.flushUpdates();

            expect(TaskRepository.pendingUpdates.size).toBe(0); // Still removed to prevent poison pill
        });

        it('should handle batch exceptions', async () => {
            TaskRepository.pendingUpdates.set('task1', { taskId: 'task1', status: 'queued', errorMsg: null });
            mockD1.fetchOne.mockRejectedValue(new Error('Database connection error'));

            await TaskRepository.flushUpdates();

            expect(TaskRepository.pendingUpdates.size).toBe(0); // Removed to avoid poison-pill loops
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
                expect.stringContaining('SELECT id, file_name, status, error_msg, source_type, created_at FROM tasks WHERE user_id = ?'),
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
                expect.stringContaining('SELECT id, user_id, chat_id, msg_id, file_name, status, error_msg, source_type FROM tasks WHERE msg_id = ?'),
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
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task123', status: 'queued' });
            mockD1.run.mockResolvedValue({ changes: 1 });

            await TaskRepository.markCancelled('task123');
            
            expect(mockD1.run).toHaveBeenCalledWith(
                "UPDATE tasks SET status = ?, error_msg = ?, updated_at = ?, claimed_by = NULL, claim_lease_id = NULL WHERE id = ? AND status = ?",
                ['cancelled', null, expect.any(Number), 'task123', 'queued']
            );
        });

        it('should handle database errors', async () => {
            mockD1.fetchOne.mockResolvedValueOnce({ id: 'task123', status: 'queued' });
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
                ['user123', 'file.mp4', 1024, TASK_STATUSES.COMPLETED]
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

    describe('getQueueOverview', () => {
        it('should return status counts, active tasks, and user counts', async () => {
            const mockStatusCounts = [
                { status: 'queued', count: 5 },
                { status: 'downloading', count: 2 },
                { status: 'completed', count: 100 }
            ];
            const mockActiveTasks = [
                { id: 't1', user_id: 'u1', file_name: 'a.mp4', status: 'downloading', updated_at: Date.now() },
                { id: 't2', user_id: 'u2', file_name: 'b.mp4', status: 'queued', updated_at: Date.now() }
            ];
            const mockUserCounts = [
                { user_id: 'u1', count: 3 },
                { user_id: 'u2', count: 1 }
            ];

            mockD1.fetchAll
                .mockResolvedValueOnce(mockStatusCounts)
                .mockResolvedValueOnce(mockActiveTasks)
                .mockResolvedValueOnce(mockUserCounts);

            const result = await TaskRepository.getQueueOverview(10);

            expect(result.statusCounts).toEqual({ queued: 5, downloading: 2, completed: 100 });
            expect(result.activeTasks).toEqual(mockActiveTasks);
            expect(result.userCounts).toEqual(mockUserCounts);
            expect(mockD1.fetchAll).toHaveBeenCalledTimes(3);
        });

        it('should handle empty results', async () => {
            mockD1.fetchAll
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            const result = await TaskRepository.getQueueOverview();

            expect(result.statusCounts).toEqual({});
            expect(result.activeTasks).toEqual([]);
            expect(result.userCounts).toEqual([]);
        });

        it('should handle null returns from D1 (partial failure)', async () => {
            mockD1.fetchAll
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null);

            const result = await TaskRepository.getQueueOverview();

            expect(result.statusCounts).toEqual({});
            expect(result.activeTasks).toEqual([]);
            expect(result.userCounts).toEqual([]);
        });

        it('should verify SQL query structure and parameters', async () => {
            mockD1.fetchAll
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            await TaskRepository.getQueueOverview(15);

            // First query: status GROUP BY
            expect(mockD1.fetchAll).toHaveBeenNthCalledWith(1,
                expect.stringContaining('GROUP BY status')
            );
            // Second query: active tasks with limit parameter
            expect(mockD1.fetchAll).toHaveBeenNthCalledWith(2,
                expect.stringContaining('LIMIT ?'),
                [...TASK_ACTIVE_STATUSES, 15]
            );
            // Third query: user distribution with hardcoded LIMIT 5
            expect(mockD1.fetchAll).toHaveBeenNthCalledWith(3,
                expect.stringContaining('LIMIT 5'),
                [...TASK_ACTIVE_STATUSES]
            );
        });

        it('should use default limit of 10 when not specified', async () => {
            mockD1.fetchAll
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            await TaskRepository.getQueueOverview();

            expect(mockD1.fetchAll).toHaveBeenNthCalledWith(2,
                expect.stringContaining('LIMIT ?'),
                [...TASK_ACTIVE_STATUSES, 10]
            );
        });
    });

    describe('getUserQueueOverview', () => {
        it('should return status counts, active tasks, and recent tasks for one user', async () => {
            const mockStatusCounts = [
                { status: 'queued', count: 2 },
                { status: 'uploading', count: 1 },
                { status: 'completed', count: 5 }
            ];
            const mockActiveTasks = [
                { id: 't1', file_name: 'a.mp4', status: 'queued', updated_at: Date.now() },
                { id: 't2', file_name: 'b.mp4', status: 'uploading', updated_at: Date.now() }
            ];
            const mockRecentTasks = [
                { id: 't3', file_name: 'done.mp4', status: 'completed', created_at: Date.now() }
            ];

            mockD1.fetchAll
                .mockResolvedValueOnce(mockStatusCounts)
                .mockResolvedValueOnce(mockActiveTasks)
                .mockResolvedValueOnce(mockRecentTasks);

            const result = await TaskRepository.getUserQueueOverview('user123', 5);

            expect(result.statusCounts).toEqual({ queued: 2, uploading: 1, completed: 5 });
            expect(result.activeTasks).toEqual(mockActiveTasks);
            expect(result.recentTasks).toEqual(mockRecentTasks);
            expect(mockD1.fetchAll).toHaveBeenCalledTimes(3);
        });

        it('should filter every query by user id and active statuses', async () => {
            mockD1.fetchAll
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            await TaskRepository.getUserQueueOverview('user123', 7);

            expect(mockD1.fetchAll).toHaveBeenNthCalledWith(1,
                expect.stringContaining('WHERE user_id = ?'),
                ['user123']
            );
            expect(mockD1.fetchAll).toHaveBeenNthCalledWith(2,
                expect.stringContaining('WHERE user_id = ? AND status IN'),
                ['user123', ...TASK_ACTIVE_STATUSES, 7]
            );
            expect(mockD1.fetchAll).toHaveBeenNthCalledWith(3,
                expect.stringContaining('WHERE user_id = ?'),
                ['user123', 7]
            );
        });

        it('should return empty data without querying D1 when user id is missing', async () => {
            const result = await TaskRepository.getUserQueueOverview(null);

            expect(result).toEqual({ statusCounts: {}, activeTasks: [], recentTasks: [] });
            expect(mockD1.fetchAll).not.toHaveBeenCalled();
        });

        it('should use default limit for invalid limit values', async () => {
            mockD1.fetchAll
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([]);

            await TaskRepository.getUserQueueOverview('user123', 0);

            expect(mockD1.fetchAll).toHaveBeenNthCalledWith(2,
                expect.stringContaining('LIMIT ?'),
                ['user123', ...TASK_ACTIVE_STATUSES, 10]
            );
            expect(mockD1.fetchAll).toHaveBeenNthCalledWith(3,
                expect.stringContaining('LIMIT ?'),
                ['user123', 10]
            );
        });
    });

    describe('getTasksByStatus', () => {
        it('should return paginated tasks for a given status', async () => {
            const mockTasks = [
                { id: 't1', user_id: 'u1', file_name: 'a.mp4', status: 'failed', error_msg: 'timeout' },
                { id: 't2', user_id: 'u2', file_name: 'b.mp4', status: 'failed', error_msg: 'crash' }
            ];
            mockD1.fetchAll.mockResolvedValueOnce(mockTasks);
            mockD1.fetchOne.mockResolvedValueOnce({ total: 15 });

            const result = await TaskRepository.getTasksByStatus('failed', 0, 10);

            expect(result.tasks).toEqual(mockTasks);
            expect(result.total).toBe(15);
            expect(result.page).toBe(0);
            expect(result.pageSize).toBe(10);
            expect(result.totalPages).toBe(2);
        });

        it('should handle empty results', async () => {
            mockD1.fetchAll.mockResolvedValueOnce([]);
            mockD1.fetchOne.mockResolvedValueOnce({ total: 0 });

            const result = await TaskRepository.getTasksByStatus('completed', 0, 10);

            expect(result.tasks).toEqual([]);
            expect(result.total).toBe(0);
            expect(result.totalPages).toBe(0);
        });

        it('should handle null returns from D1', async () => {
            mockD1.fetchAll.mockResolvedValueOnce(null);
            mockD1.fetchOne.mockResolvedValueOnce(null);

            const result = await TaskRepository.getTasksByStatus('queued', 0, 10);

            expect(result.tasks).toEqual([]);
            expect(result.total).toBe(0);
            expect(result.totalPages).toBe(0);
        });

        it('should calculate correct offset for page 2', async () => {
            mockD1.fetchAll.mockResolvedValueOnce([]);
            mockD1.fetchOne.mockResolvedValueOnce({ total: 25 });

            await TaskRepository.getTasksByStatus('failed', 2, 10);

            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining('LIMIT ? OFFSET ?'),
                ['failed', 10, 20]
            );
        });

        it('should verify SQL query structure', async () => {
            mockD1.fetchAll.mockResolvedValueOnce([]);
            mockD1.fetchOne.mockResolvedValueOnce({ total: 0 });

            await TaskRepository.getTasksByStatus('completed', 0, 10);

            expect(mockD1.fetchAll).toHaveBeenCalledWith(
                expect.stringContaining('WHERE status = ?'),
                ['completed', 10, 0]
            );
            expect(mockD1.fetchOne).toHaveBeenCalledWith(
                expect.stringContaining('COUNT(*)'),
                ['completed']
            );
        });
    });
});
