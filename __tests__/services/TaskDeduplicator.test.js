import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskDeduplicator } from '../../src/services/TaskDeduplicator.js';

describe('TaskDeduplicator', () => {
    let mockCache;
    let mockLogger;
    let deduplicator;

    beforeEach(() => {
        mockCache = {
            get: vi.fn(),
            set: vi.fn(),
            delete: vi.fn()
        };

        mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn()
        };

        deduplicator = new TaskDeduplicator(mockCache, { logger: mockLogger });

        // Mock Date.now for predictable timestamps
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('constructor', () => {
        it('should initialize with default options', () => {
            const dedup = new TaskDeduplicator(mockCache);
            expect(dedup.cache).toBe(mockCache);
            expect(dedup.dedupWindow).toBe(3600);
            expect(dedup.taskPrefix).toBe('task:');
            expect(dedup.activeTasks).toBeInstanceOf(Map);
        });

        it('should initialize with custom options', () => {
            const dedup = new TaskDeduplicator(mockCache, {
                dedupWindow: 7200,
                taskPrefix: 'custom_task:',
                maxConcurrent: 20
            });
            expect(dedup.dedupWindow).toBe(7200);
            expect(dedup.taskPrefix).toBe('custom_task:');
            expect(dedup.maxConcurrent).toBe(20);
        });
    });

    describe('registerTask', () => {
        it('should register a new task successfully', async () => {
            mockCache.get.mockResolvedValue(null);
            mockCache.set.mockResolvedValue(true);

            const taskData = { id: 1, type: 'test' };
            const result = await deduplicator.registerTask(taskData);

            expect(result.registered).toBe(true);
            expect(result.status).toBe('pending');
            expect(mockCache.get).toHaveBeenCalled();
            expect(mockCache.set).toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Task registered:'), { taskData });
        });

        it('should handle duplicate task when allowDuplicate is false', async () => {
            const existingTask = {
                status: 'pending',
                createdAt: Date.now()
            };
            mockCache.get.mockResolvedValue(existingTask);

            const result = await deduplicator.registerTask({ id: 1 }, { dedupKey: 'task123' });

            expect(result.registered).toBe(false);
            expect(result.reason).toBe('duplicate');
            expect(result.taskKey).toBe('task123');
            expect(mockCache.set).not.toHaveBeenCalled();
        });

        it('should handle duplicate task when allowDuplicate is true and task is completed', async () => {
            const existingTask = {
                status: 'completed',
                createdAt: Date.now() - 1000
            };
            // first get for task, second for _isProcessing
            mockCache.get.mockResolvedValueOnce(existingTask).mockResolvedValueOnce(null);
            mockCache.delete.mockResolvedValue(true);
            mockCache.set.mockResolvedValue(true);

            const result = await deduplicator.registerTask({ id: 1 }, { allowDuplicate: true, dedupKey: 'task123' });

            expect(result.registered).toBe(true);
            expect(mockCache.delete).toHaveBeenCalledTimes(3); // fullKey, processingKey, resultKey
            expect(mockCache.set).toHaveBeenCalled();
        });

        it('should handle storage error during registration', async () => {
            mockCache.get.mockResolvedValue(null);
            mockCache.set.mockResolvedValue(false);

            const result = await deduplicator.registerTask({ id: 1 });

            expect(result.registered).toBe(false);
            expect(result.reason).toBe('storage_error');
        });
    });

    describe('beginProcessing', () => {
        it('should return not_found if task does not exist', async () => {
            mockCache.get.mockResolvedValue(null);

            const result = await deduplicator.beginProcessing('task123', 'worker1');

            expect(result.canProcess).toBe(false);
            expect(result.reason).toBe('not_found');
        });

        it('should return already_completed if task is completed', async () => {
            mockCache.get.mockResolvedValue({ status: 'completed' });

            const result = await deduplicator.beginProcessing('task123', 'worker1');

            expect(result.canProcess).toBe(false);
            expect(result.reason).toBe('already_completed');
        });

        it('should return already_processing if task is currently being processed', async () => {
            mockCache.get.mockImplementation((key) => {
                if (key.startsWith('task:')) return Promise.resolve({ status: 'processing' });
                if (key.startsWith('processing:')) return Promise.resolve({ workerId: 'worker2', startedAt: Date.now() });
                return Promise.resolve(null);
            });

            const result = await deduplicator.beginProcessing('task123', 'worker1');

            expect(result.canProcess).toBe(false);
            expect(result.reason).toBe('already_processing');
        });

        it('should allow preempting if processing is timed out', async () => {
            mockCache.get.mockImplementation((key) => {
                if (key.startsWith('task:')) return Promise.resolve({ status: 'processing', data: {} });
                if (key.startsWith('processing:')) return Promise.resolve({ workerId: 'worker2', startedAt: Date.now() - 2000000 }); // Timed out
                return Promise.resolve(null);
            });
            mockCache.set.mockResolvedValue(true);

            const result = await deduplicator.beginProcessing('task123', 'worker1');

            expect(result.canProcess).toBe(true);
            expect(result.workerId).toBe('worker1');
            expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('processing timeout, allowing抢占'));
        });

        it('should successfully acquire lock and begin processing', async () => {
            mockCache.get.mockResolvedValue({ status: 'pending', data: { id: 1 } });
            mockCache.set.mockResolvedValue(true);

            const result = await deduplicator.beginProcessing('task123', 'worker1');

            expect(result.canProcess).toBe(true);
            expect(result.taskKey).toBe('task123');
            expect(result.workerId).toBe('worker1');
            expect(deduplicator.activeTasks.has('task123')).toBe(true);

            // Check state updates
            expect(mockCache.set).toHaveBeenCalledTimes(2); // One for processing lock, one for task status
        });

        it('should handle lock acquisition failure', async () => {
            mockCache.get.mockResolvedValue({ status: 'pending', data: { id: 1 } });
            mockCache.set.mockResolvedValue(false); // fail to acquire lock

            const result = await deduplicator.beginProcessing('task123', 'worker1');

            expect(result.canProcess).toBe(false);
            expect(result.reason).toBe('lock_failed');
        });
    });

    describe('completeProcessing', () => {
        it('should fail if worker is not the owner', async () => {
            mockCache.get.mockResolvedValue({ workerId: 'worker2' });

            const result = await deduplicator.completeProcessing('task123', 'worker1', { success: true });

            expect(result.success).toBe(false);
            expect(result.reason).toBe('not_owner');
        });

        it('should successfully complete processing', async () => {
            mockCache.get.mockImplementation((key) => {
                if (key.startsWith('processing:')) return Promise.resolve({ workerId: 'worker1', startedAt: Date.now() - 1000 });
                if (key.startsWith('task:')) return Promise.resolve({ status: 'processing' });
                return Promise.resolve(null);
            });

            deduplicator.activeTasks.set('task123', { workerId: 'worker1', startedAt: Date.now() });

            const result = await deduplicator.completeProcessing('task123', 'worker1', { data: 'resultData' });

            expect(result.success).toBe(true);
            expect(result.taskKey).toBe('task123');
            expect(mockCache.set).toHaveBeenCalledTimes(2); // Set result, update task
            expect(mockCache.delete).toHaveBeenCalledWith('processing:task123');
            expect(deduplicator.activeTasks.has('task123')).toBe(false);
        });
    });

    describe('failProcessing', () => {
        it('should fail if worker is not the owner', async () => {
            mockCache.get.mockResolvedValue({ workerId: 'worker2' });

            const result = await deduplicator.failProcessing('task123', 'worker1', new Error('test'));

            expect(result.success).toBe(false);
            expect(result.reason).toBe('not_owner');
        });

        it('should successfully mark processing as failed', async () => {
            mockCache.get.mockImplementation((key) => {
                if (key.startsWith('processing:')) return Promise.resolve({ workerId: 'worker1', startedAt: Date.now() - 1000 });
                if (key.startsWith('task:')) return Promise.resolve({ status: 'processing' });
                return Promise.resolve(null);
            });

            deduplicator.activeTasks.set('task123', { workerId: 'worker1', startedAt: Date.now() });

            const result = await deduplicator.failProcessing('task123', 'worker1', new Error('test error'));

            expect(result.success).toBe(true);
            expect(result.taskKey).toBe('task123');
            expect(result.error).toBe('test error');

            // Check that it was set as retryable by default
            const setTaskCall = mockCache.set.mock.calls.find(call => call[0] === 'task:task123');
            expect(setTaskCall[1].status).toBe('failed_retryable');
            expect(setTaskCall[1].error).toBe('test error');

            expect(mockCache.delete).toHaveBeenCalledWith('processing:task123');
            expect(deduplicator.activeTasks.has('task123')).toBe(false);
            expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Task failed:'), { error: 'test error' });
        });

        it('should mark as failed instead of failed_retryable if retryable is false', async () => {
            mockCache.get.mockImplementation((key) => {
                if (key.startsWith('processing:')) return Promise.resolve({ workerId: 'worker1', startedAt: Date.now() - 1000 });
                if (key.startsWith('task:')) return Promise.resolve({ status: 'processing' });
                return Promise.resolve(null);
            });

            await deduplicator.failProcessing('task123', 'worker1', new Error('test error'), { retryable: false });

            const setTaskCall = mockCache.set.mock.calls.find(call => call[0] === 'task:task123');
            expect(setTaskCall[1].status).toBe('failed');
        });
    });

    describe('getTaskStatus', () => {
        it('should return exists:false if task not found', async () => {
            mockCache.get.mockResolvedValue(null);

            const status = await deduplicator.getTaskStatus('task123');

            expect(status.exists).toBe(false);
        });

        it('should return comprehensive status', async () => {
            mockCache.get.mockImplementation((key) => {
                if (key.startsWith('task:')) return Promise.resolve({ status: 'processing', attempts: 1, data: { id: 1 } });
                if (key.startsWith('processing:')) return Promise.resolve({ workerId: 'worker1', startedAt: Date.now() - 5000 });
                if (key.startsWith('result:')) return Promise.resolve(null);
                return Promise.resolve(null);
            });

            const status = await deduplicator.getTaskStatus('task123');

            expect(status.exists).toBe(true);
            expect(status.status).toBe('processing');
            expect(status.attempts).toBe(1);
            expect(status.processing.workerId).toBe('worker1');
            expect(status.processing.elapsed).toBe(5000);
        });

        it('should include result and error if present', async () => {
             mockCache.get.mockImplementation((key) => {
                if (key.startsWith('task:')) return Promise.resolve({ status: 'completed', attempts: 1, error: 'some error' });
                if (key.startsWith('processing:')) return Promise.resolve(null);
                if (key.startsWith('result:')) return Promise.resolve({ result: 'done', completedAt: Date.now(), processingTime: 100 });
                return Promise.resolve(null);
            });

            const status = await deduplicator.getTaskStatus('task123');

            expect(status.status).toBe('completed');
            expect(status.result).toBe('done');
            expect(status.error).toBe('some error');
        });
    });

    describe('getTaskResult', () => {
        it('should immediately return result if no wait option', async () => {
            mockCache.get.mockResolvedValue({ result: 'done', processingTime: 100 });

            const result = await deduplicator.getTaskResult('task123');

            expect(result.completed).toBe(true);
            expect(result.result).toBe('done');
        });

        it('should immediately return uncompleted if no result found and no wait option', async () => {
            mockCache.get.mockResolvedValue(null);

            const result = await deduplicator.getTaskResult('task123');

            expect(result.completed).toBe(false);
        });

        it('should wait and return completed result', async () => {
            let attempt = 0;
            // Mock getTaskStatus behaviour implicitly via cache.get calls
            mockCache.get.mockImplementation((key) => {
                if (key.startsWith('task:')) {
                     if (attempt < 1) {
                         attempt++;
                         return Promise.resolve({ status: 'processing' });
                     }
                     return Promise.resolve({ status: 'completed' });
                }
                if (key.startsWith('processing:')) return Promise.resolve(null);
                if (key.startsWith('result:')) return Promise.resolve({ result: 'done', processingTime: 100 });
                return Promise.resolve(null);
            });

            // Need to actually let promises resolve in wait loop, but Vitest fake timers make it fast/instant if we advance them or let the loop run (since the loop uses real setTimeout or mocked setTimeout).
            // Actually, we mocked fake timers, so `await new Promise(resolve => setTimeout(resolve, 100))` will block forever if we don't advance time.
            // Let's restore real timers for the wait test or mock it.
            vi.useRealTimers();

            const resultPromise = deduplicator.getTaskResult('task123', { wait: true, timeout: 1 });
            const result = await resultPromise;

            expect(result.completed).toBe(true);
            expect(result.result).toBe('done');
        });

        it('should wait and return error on failure', async () => {
             mockCache.get.mockImplementation((key) => {
                if (key.startsWith('task:')) return Promise.resolve({ status: 'failed', error: 'failed task' });
                return Promise.resolve(null);
            });

            const result = await deduplicator.getTaskResult('task123', { wait: true });

            expect(result.completed).toBe(false);
            expect(result.error).toBe('failed task');
        });

        it('should timeout when waiting', async () => {
             mockCache.get.mockImplementation((key) => {
                if (key.startsWith('task:')) return Promise.resolve({ status: 'processing' });
                return Promise.resolve(null);
            });

            vi.useRealTimers();
            const result = await deduplicator.getTaskResult('task123', { wait: true, timeout: 0.2 }); // 200ms

            expect(result.completed).toBe(false);
            expect(result.timeout).toBe(true);
        });
    });

    describe('cleanupExpired', () => {
        it('should log and return cleaned 0', async () => {
            const result = await deduplicator.cleanupExpired();
            expect(mockLogger.info).toHaveBeenCalledWith('Cleanup expired tasks - requires cache with listKeys support');
            expect(result.cleaned).toBe(0);
        });
    });

    describe('getStats', () => {
        it('should return active tasks info', async () => {
            deduplicator.activeTasks.set('task1', { workerId: 'w1', startedAt: Date.now() - 1000 });
            deduplicator.activeTasks.set('task2', { workerId: 'w2', startedAt: Date.now() - 2000 });

            const stats = await deduplicator.getStats();

            expect(stats.activeTasks).toBe(2);
            expect(stats.activeTaskList).toHaveLength(2);
            expect(stats.activeTaskList[0].taskKey).toBe('task1');
            expect(stats.activeTaskList[0].workerId).toBe('w1');
            expect(stats.activeTaskList[0].elapsed).toBe(1000);
        });
    });

    describe('_isProcessing', () => {
        it('should return true if processing info exists', async () => {
            mockCache.get.mockResolvedValue({ workerId: 'w1' });
            const result = await deduplicator._isProcessing('task123');
            expect(result).toBe(true);
        });

        it('should return false if processing info does not exist', async () => {
            mockCache.get.mockResolvedValue(null);
            const result = await deduplicator._isProcessing('task123');
            expect(result).toBe(false);
        });
    });

    describe('_defaultTaskKeyGenerator', () => {
        it('should generate consistent hash based on object', () => {
            const data1 = { a: 1, b: 2 };
            // Note: date.now is mocked, so it's consistent
            const hash1 = deduplicator._defaultTaskKeyGenerator(data1);
            const hash2 = deduplicator._defaultTaskKeyGenerator(data1);
            expect(hash1).toBe(hash2);
            expect(hash1).toContain('task-');
        });
    });
});
