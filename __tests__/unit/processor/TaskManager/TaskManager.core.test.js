import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskManagerCore } from '../../../../src/processor/TaskManager/TaskManager.core.js';
import { d1 } from '../../../../src/services/d1.js';
import { TaskRepository } from '../../../../src/repositories/TaskRepository.js';

vi.mock('../../../../src/services/d1.js', () => ({
    d1: {
        batch: vi.fn()
    }
}));

vi.mock('../../../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: {
        updateStatus: vi.fn()
    }
}));

// Mock logger to suppress errors in test output and provide required exports for InstanceCoordinator
vi.mock('../../../../src/services/logger/index.js', async (importOriginal) => {
    const actual = await importOriginal();
    const loggerMock = {
        withModule: vi.fn().mockReturnValue({
            error: vi.fn(),
            warn: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        })
    };
    return {
        ...actual,
        logger: loggerMock,
        default: loggerMock,
        setInstanceIdProvider: vi.fn(),
        setAxiomInstanceIdProvider: vi.fn()
    };
});

describe('TaskManagerCore', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('batchUpdateStatus', () => {
        it('should return early if updates array is empty', async () => {
            await TaskManagerCore.batchUpdateStatus([]);
            expect(d1.batch).not.toHaveBeenCalled();
        });

        it('should return early if updates is null', async () => {
            await TaskManagerCore.batchUpdateStatus(null);
            expect(d1.batch).not.toHaveBeenCalled();
        });

        it('should successfully batch update tasks', async () => {
            const updates = [
                { id: '1', status: 'completed' },
                { id: '2', status: 'failed', error: 'some error' }
            ];

            d1.batch.mockResolvedValueOnce([{}]);

            await TaskManagerCore.batchUpdateStatus(updates);

            expect(d1.batch).toHaveBeenCalledTimes(1);
            expect(d1.batch).toHaveBeenCalledWith([
                {
                    sql: "UPDATE tasks SET status = ?, error_msg = ?, updated_at = datetime('now') WHERE id = ?",
                    params: ['completed', null, '1']
                },
                {
                    sql: "UPDATE tasks SET status = ?, error_msg = ?, updated_at = datetime('now') WHERE id = ?",
                    params: ['failed', 'some error', '2']
                }
            ]);
            expect(TaskRepository.updateStatus).not.toHaveBeenCalled();
        });

        it('should fallback to individual updates if d1.batch fails', async () => {
            const updates = [
                { id: '1', status: 'completed' },
                { id: '2', status: 'failed', error: 'some error' }
            ];

            d1.batch.mockRejectedValueOnce(new Error('Database batch failed'));
            TaskRepository.updateStatus.mockResolvedValue();

            await TaskManagerCore.batchUpdateStatus(updates);

            expect(d1.batch).toHaveBeenCalledTimes(1);
            expect(TaskRepository.updateStatus).toHaveBeenCalledTimes(2);
            expect(TaskRepository.updateStatus).toHaveBeenNthCalledWith(1, '1', 'completed', undefined);
            expect(TaskRepository.updateStatus).toHaveBeenNthCalledWith(2, '2', 'failed', 'some error');
        });

        it('should continue individual updates even if one individual update fails during fallback', async () => {
             const updates = [
                { id: '1', status: 'completed' },
                { id: '2', status: 'failed', error: 'some error' }
            ];

            d1.batch.mockRejectedValueOnce(new Error('Database batch failed'));

            // First update fails, second succeeds
            TaskRepository.updateStatus.mockRejectedValueOnce(new Error('Individual update failed'))
                                     .mockResolvedValueOnce();

            await TaskManagerCore.batchUpdateStatus(updates);

            expect(d1.batch).toHaveBeenCalledTimes(1);
            expect(TaskRepository.updateStatus).toHaveBeenCalledTimes(2);
            expect(TaskRepository.updateStatus).toHaveBeenNthCalledWith(1, '1', 'completed', undefined);
            expect(TaskRepository.updateStatus).toHaveBeenNthCalledWith(2, '2', 'failed', 'some error');
        });
    });
});
