import { describe, expect, it } from 'vitest';
import {
    TASK_EVENTS,
    TASK_STATUSES,
    TaskStateMachine,
    TaskStateTransitionError
} from '../../../src/domain/task-state-machine.js';

describe('TaskStateMachine', () => {
    it('should allow the canonical transfer path', () => {
        expect(TaskStateMachine.assertTransition(TASK_STATUSES.QUEUED, TASK_EVENTS.START_DOWNLOAD).toStatus).toBe(TASK_STATUSES.DOWNLOADING);
        expect(TaskStateMachine.assertTransition(TASK_STATUSES.DOWNLOADING, TASK_EVENTS.FINISH_DOWNLOAD).toStatus).toBe(TASK_STATUSES.DOWNLOADED);
        expect(TaskStateMachine.assertTransition(TASK_STATUSES.DOWNLOADED, TASK_EVENTS.START_UPLOAD).toStatus).toBe(TASK_STATUSES.UPLOADING);
        expect(TaskStateMachine.assertTransition(TASK_STATUSES.UPLOADING, TASK_EVENTS.COMPLETE).toStatus).toBe(TASK_STATUSES.COMPLETED);
    });

    it('should block terminal states from being overwritten by stale events', () => {
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.COMPLETED, TASK_EVENTS.START_DOWNLOAD).allowed).toBe(false);
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.CANCELLED, TASK_EVENTS.COMPLETE).allowed).toBe(false);
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.FAILED, TASK_EVENTS.START_UPLOAD).allowed).toBe(false);
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.FAILED, TASK_EVENTS.COMPLETE).allowed).toBe(false);
    });

    it('should only retry non-cancelled and non-completed work', () => {
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.FAILED, TASK_EVENTS.RETRY).allowed).toBe(true);
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.DOWNLOADED, TASK_EVENTS.RETRY).allowed).toBe(true);
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.COMPLETED, TASK_EVENTS.RETRY).allowed).toBe(false);
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.CANCELLED, TASK_EVENTS.RETRY).allowed).toBe(false);
    });

    it('should reset uploading work back to the uploadable state', () => {
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.UPLOADING, TASK_EVENTS.RESET_UPLOAD).toStatus).toBe(TASK_STATUSES.DOWNLOADED);
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.DOWNLOADED, TASK_EVENTS.RESET_UPLOAD).allowed).toBe(true);
        expect(TaskStateMachine.resolveTransition(TASK_STATUSES.DOWNLOADING, TASK_EVENTS.RESET_UPLOAD).allowed).toBe(false);
    });

    it('should reject unknown statuses', () => {
        expect(() => TaskStateMachine.assertTransition('mystery', TASK_EVENTS.COMPLETE)).toThrow(TaskStateTransitionError);
    });
});
