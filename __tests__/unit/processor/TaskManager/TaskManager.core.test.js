import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskManagerCore } from '../../../../src/processor/TaskManager/TaskManager.core.js';
import { TaskRepository } from '../../../../src/repositories/TaskRepository.js';

vi.mock('../../../../src/services/d1.js', () => ({
    d1: {
        batch: vi.fn()
    }
}));

vi.mock('../../../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: {
        transitionStatus: vi.fn()
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
            expect(TaskRepository.transitionStatus).not.toHaveBeenCalled();
        });

        it('should return early if updates is null', async () => {
            await TaskManagerCore.batchUpdateStatus(null);
            expect(TaskRepository.transitionStatus).not.toHaveBeenCalled();
        });

        it('should successfully batch update tasks', async () => {
            const updates = [
                { id: '1', status: 'completed' },
                { id: '2', status: 'failed', error: 'some error' }
            ];

            TaskRepository.transitionStatus.mockResolvedValue({ changed: true });

            await TaskManagerCore.batchUpdateStatus(updates);

            expect(TaskRepository.transitionStatus).toHaveBeenCalledTimes(2);
            expect(TaskRepository.transitionStatus).toHaveBeenNthCalledWith(1, '1', 'completed', undefined, expect.objectContaining({ source: 'TaskManager.batchUpdateStatus' }));
            expect(TaskRepository.transitionStatus).toHaveBeenNthCalledWith(2, '2', 'failed', 'some error', expect.objectContaining({ source: 'TaskManager.batchUpdateStatus' }));
        });

        it('should fallback to individual updates if d1.batch fails', async () => {
            const updates = [
                { id: '1', status: 'completed' },
                { id: '2', status: 'failed', error: 'some error' }
            ];

            TaskRepository.transitionStatus
                .mockRejectedValueOnce(new Error('Database batch failed'))
                .mockResolvedValueOnce({ changed: true })
                .mockResolvedValueOnce({ changed: true });

            await TaskManagerCore.batchUpdateStatus(updates);

            expect(TaskRepository.transitionStatus).toHaveBeenCalledTimes(4);
            expect(TaskRepository.transitionStatus).toHaveBeenNthCalledWith(3, '1', 'completed', undefined, expect.objectContaining({ source: 'TaskManager.batchUpdateStatus.fallback' }));
            expect(TaskRepository.transitionStatus).toHaveBeenNthCalledWith(4, '2', 'failed', 'some error', expect.objectContaining({ source: 'TaskManager.batchUpdateStatus.fallback' }));
        });

        it('should continue individual updates even if one individual update fails during fallback', async () => {
             const updates = [
                { id: '1', status: 'completed' },
                { id: '2', status: 'failed', error: 'some error' }
            ];

            TaskRepository.transitionStatus
                .mockRejectedValueOnce(new Error('Database batch failed'))
                .mockRejectedValueOnce(new Error('Individual update failed'))
                .mockResolvedValueOnce()
                .mockResolvedValueOnce();

            await TaskManagerCore.batchUpdateStatus(updates);

            expect(TaskRepository.transitionStatus).toHaveBeenCalledTimes(4);
            expect(TaskRepository.transitionStatus).toHaveBeenNthCalledWith(3, '1', 'completed', undefined, expect.any(Object));
            expect(TaskRepository.transitionStatus).toHaveBeenNthCalledWith(4, '2', 'failed', 'some error', expect.any(Object));
        });
    });
});
