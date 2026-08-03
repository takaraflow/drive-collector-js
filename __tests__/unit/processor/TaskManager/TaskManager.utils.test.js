import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    createHeartbeat,
    handleTaskCompletion,
    handleTaskFailure,
    handleUploadFailure,
    escapeHTML
} from '../../../../src/processor/TaskManager/TaskManager.utils.js';
import { TASK_EVENTS, TASK_STATUSES } from '../../../../src/domain/task-state-machine.js';
import { dependencyContainer } from '../../../../src/services/DependencyContainer.js';

// Mock dependencies
vi.mock('../../../../src/services/DependencyContainer.js', () => {
    const mockDeps = {
        TaskRepository: {
            transitionStatus: vi.fn()
        },
        STRINGS: {
            task: {
                uploading: 'Uploading...',
                downloading: 'Downloading...',
                success_sec_transfer: 'Success: {name} to {folder}',
                cancelled: 'Cancelled',
                error_prefix: 'Error: ',
                failed_upload: 'Upload failed: {reason}'
            }
        },
        UIHelper: {
            renderProgress: vi.fn()
        },
        logger: {
            withModule: vi.fn().mockReturnValue({
                error: vi.fn(),
                warn: vi.fn(),
                info: vi.fn(),
                debug: vi.fn()
            })
        },
        format: vi.fn((str, vars) => {
            let res = str;
            for (const key in vars) {
                res = res.replace(`{${key}}`, vars[key]);
            }
            return res;
        })
    };

    return {
        dependencyContainer: {
            getAll: vi.fn(() => mockDeps)
        }
    };
});

describe('TaskManager.utils', () => {
    let mockDeps;

    beforeEach(() => {
        vi.clearAllMocks();
        mockDeps = dependencyContainer.getAll();
    });

    describe('escapeHTML', () => {
        it('should escape special HTML characters', () => {
            const input = 'This & that < > "quoted" \'single\'';
            const expected = 'This &amp; that &lt; &gt; &quot;quoted&quot; &#039;single&#039;';
            expect(escapeHTML(input)).toBe(expected);
        });

        it('should handle strings without special characters', () => {
            expect(escapeHTML('hello world')).toBe('hello world');
        });
    });

    describe('createHeartbeat', () => {
        it('should throw an error and set isCancelled if task is in cancelledTaskIds', async () => {
            const task = { id: 'task1' };
            const context = { cancelledTaskIds: new Set(['task1']) };
            const updateStatus = vi.fn();

            const heartbeat = createHeartbeat(task, context, updateStatus);

            await expect(heartbeat('uploading')).rejects.toThrow('CANCELLED');
            expect(task.isCancelled).toBe(true);
            expect(mockDeps.TaskRepository.transitionStatus).not.toHaveBeenCalled();
        });

        it('should return early if transition is blocked', async () => {
            const task = { id: 'task1' };
            const context = { cancelledTaskIds: new Set() };
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: true });

            const heartbeat = createHeartbeat(task, context, updateStatus);
            await heartbeat('uploading');

            expect(mockDeps.TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'task1', TASK_EVENTS.START_UPLOAD, null, expect.any(Object)
            );
            expect(updateStatus).not.toHaveBeenCalled();
        });

        it('should call _refreshGroupMonitor for group tasks', async () => {
            const task = { id: 'task1', isGroup: true };
            const context = { cancelledTaskIds: new Set(), _refreshGroupMonitor: vi.fn() };
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false });

            const heartbeat = createHeartbeat(task, context, updateStatus);
            await heartbeat('downloading', 100, 1000);

            expect(context._refreshGroupMonitor).toHaveBeenCalledWith(task, 'downloading', 100, 1000);
            expect(updateStatus).not.toHaveBeenCalled();
        });

        it('should render upload progress for single upload tasks with progress info', async () => {
            const task = { id: 'task1', isGroup: false };
            const context = { cancelledTaskIds: new Set() };
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false });
            mockDeps.UIHelper.renderProgress.mockReturnValue('Uploading 50%');

            const heartbeat = createHeartbeat(task, context, updateStatus, 'file.txt');
            const uploadProgress = { bytes: 50, size: 100 };
            await heartbeat('uploading', 0, 0, uploadProgress);

            expect(mockDeps.UIHelper.renderProgress).toHaveBeenCalledWith(
                50, 100, mockDeps.STRINGS.task.uploading, 'file.txt'
            );
            expect(updateStatus).toHaveBeenCalledWith(task, 'Uploading 50%');
        });

        it('should render download progress for single download tasks with downloaded > 0', async () => {
            const task = { id: 'task1', isGroup: false };
            const context = { cancelledTaskIds: new Set() };
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false });
            mockDeps.UIHelper.renderProgress.mockReturnValue('Downloading 30%');

            const heartbeat = createHeartbeat(task, context, updateStatus, 'file.txt');
            await heartbeat('downloading', 30, 100);

            expect(mockDeps.UIHelper.renderProgress).toHaveBeenCalledWith(
                30, 100, mockDeps.STRINGS.task.downloading, 'file.txt'
            );
            expect(updateStatus).toHaveBeenCalledWith(task, 'Downloading 30%');
        });

        it('should use default string for uploading when no uploadProgress is provided', async () => {
            const task = { id: 'task1', isGroup: false };
            const context = { cancelledTaskIds: new Set() };
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false });

            const heartbeat = createHeartbeat(task, context, updateStatus, 'file.txt');
            await heartbeat('uploading');

            expect(updateStatus).toHaveBeenCalledWith(task, mockDeps.STRINGS.task.uploading);
            expect(mockDeps.UIHelper.renderProgress).not.toHaveBeenCalled();
        });

        it('should use default string for downloading when downloaded is 0', async () => {
            const task = { id: 'task1', isGroup: false };
            const context = { cancelledTaskIds: new Set() };
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false });

            const heartbeat = createHeartbeat(task, context, updateStatus, 'file.txt');
            await heartbeat('downloading', 0, 100);

            expect(updateStatus).toHaveBeenCalledWith(task, mockDeps.STRINGS.task.downloading);
            expect(mockDeps.UIHelper.renderProgress).not.toHaveBeenCalled();
        });
    });

    describe('handleTaskCompletion', () => {
        it('should return early if transition is blocked', async () => {
            const task = { id: 'task1' };
            const context = {};
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: true });

            await handleTaskCompletion(task, context, updateStatus, 'file.txt', '/dest', 'http://link');

            expect(mockDeps.TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'task1', TASK_EVENTS.COMPLETE, null, expect.any(Object)
            );
            expect(updateStatus).not.toHaveBeenCalled();
        });

        it('should call _refreshGroupMonitor for group tasks', async () => {
            const task = { id: 'task1', isGroup: true };
            const context = { _refreshGroupMonitor: vi.fn() };
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false });

            await handleTaskCompletion(task, context, updateStatus, 'file.txt', '/dest', 'http://link');

            expect(context._refreshGroupMonitor).toHaveBeenCalledWith(task, TASK_STATUSES.COMPLETED);
            expect(updateStatus).not.toHaveBeenCalled();
        });

        it('should call updateStatus with formatted success string for single tasks', async () => {
            const task = { id: 'task1', isGroup: false };
            const context = {};
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false });

            await handleTaskCompletion(task, context, updateStatus, 'file <name>', '/dest', 'http://link');

            expect(updateStatus).toHaveBeenCalledWith(
                task,
                'Success: <a href="http://link">file &lt;name&gt;</a> to /dest',
                true
            );
        });
    });

    describe('handleTaskFailure', () => {
        it('should return early if transition is blocked', async () => {
            const task = { id: 'task1' };
            const context = {};
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: true });

            await handleTaskFailure(task, context, updateStatus, 'error message', false);

            expect(mockDeps.TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'task1', TASK_EVENTS.FAIL, 'error message', expect.any(Object)
            );
            expect(updateStatus).not.toHaveBeenCalled();
        });

        it('should use TASK_EVENTS.CANCEL when isCancelled is true', async () => {
            const task = { id: 'task1' };
            const context = {};
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: true });

            await handleTaskFailure(task, context, updateStatus, 'error message', true);

            expect(mockDeps.TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'task1', TASK_EVENTS.CANCEL, 'error message', expect.any(Object)
            );
        });

        it('should call _refreshGroupMonitor for group tasks', async () => {
            const task = { id: 'task1', isGroup: true };
            const context = { _refreshGroupMonitor: vi.fn() };
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false, toStatus: TASK_STATUSES.FAILED });

            await handleTaskFailure(task, context, updateStatus, 'error message', false);

            expect(context._refreshGroupMonitor).toHaveBeenCalledWith(task, TASK_STATUSES.FAILED);
            expect(updateStatus).not.toHaveBeenCalled();
        });

        it('should call updateStatus with cancelled text if isCancelled is true', async () => {
            const task = { id: 'task1', isGroup: false };
            const context = {};
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false, toStatus: TASK_STATUSES.CANCELLED });

            await handleTaskFailure(task, context, updateStatus, 'error message', true);

            expect(updateStatus).toHaveBeenCalledWith(
                task,
                mockDeps.STRINGS.task.cancelled,
                true,
                null,
                false
            );
        });

        it('should call updateStatus with error prefix and escaped message if isCancelled is false', async () => {
            const task = { id: 'task1', isGroup: false };
            const context = {};
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false, toStatus: TASK_STATUSES.FAILED });

            await handleTaskFailure(task, context, updateStatus, 'bad <error>', false);

            expect(updateStatus).toHaveBeenCalledWith(
                task,
                'Error: <code>bad &lt;error&gt;</code>',
                true,
                null,
                true
            );
        });
    });

    describe('handleUploadFailure', () => {
        it('should throw an error if task isCancelled', async () => {
            const task = { id: 'task1', isCancelled: true };
            const context = {};
            const updateStatus = vi.fn();

            await expect(handleUploadFailure(task, context, updateStatus, { error: 'some error' })).rejects.toThrow('CANCELLED');
        });

        it('should throw an error if uploadResult.error is CANCELLED', async () => {
            const task = { id: 'task1', isCancelled: false };
            const context = {};
            const updateStatus = vi.fn();

            await expect(handleUploadFailure(task, context, updateStatus, { error: 'CANCELLED' })).rejects.toThrow('CANCELLED');
        });

        it('should return early if transition is blocked', async () => {
            const task = { id: 'task1', isCancelled: false };
            const context = {};
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: true });

            await handleUploadFailure(task, context, updateStatus, { error: 'upload error' });

            expect(mockDeps.TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'task1', TASK_EVENTS.FAIL, 'upload error', expect.any(Object)
            );
            expect(updateStatus).not.toHaveBeenCalled();
        });

        it('should call _refreshGroupMonitor for group tasks', async () => {
            const task = { id: 'task1', isGroup: true, isCancelled: false };
            const context = { _refreshGroupMonitor: vi.fn() };
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false });

            await handleUploadFailure(task, context, updateStatus, { error: 'upload error' });

            expect(context._refreshGroupMonitor).toHaveBeenCalledWith(task, TASK_STATUSES.FAILED, 0, 0, 'upload error');
            expect(updateStatus).not.toHaveBeenCalled();
        });

        it('should call updateStatus with formatted text for single tasks', async () => {
            const task = { id: 'task1', isGroup: false, isCancelled: false };
            const context = {};
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false });

            await handleUploadFailure(task, context, updateStatus, { error: 'upload <error>' });

            expect(updateStatus).toHaveBeenCalledWith(
                task,
                'Upload failed: upload &lt;error&gt;',
                true,
                null,
                true
            );
        });

        it('should handle missing error in uploadResult by defaulting to "Upload failed"', async () => {
            const task = { id: 'task1', isGroup: false, isCancelled: false };
            const context = {};
            const updateStatus = vi.fn();

            mockDeps.TaskRepository.transitionStatus.mockResolvedValue({ blocked: false });

            await handleUploadFailure(task, context, updateStatus, {});

            expect(mockDeps.TaskRepository.transitionStatus).toHaveBeenCalledWith(
                'task1', TASK_EVENTS.FAIL, 'Upload failed', expect.any(Object)
            );
        });
    });
});
