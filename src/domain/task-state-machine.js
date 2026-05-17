export const TASK_STATUSES = Object.freeze({
    QUEUED: 'queued',
    DOWNLOADING: 'downloading',
    DOWNLOADED: 'downloaded',
    UPLOADING: 'uploading',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
});

export const TASK_EVENTS = Object.freeze({
    START_DOWNLOAD: 'start_download',
    FINISH_DOWNLOAD: 'finish_download',
    START_UPLOAD: 'start_upload',
    START_STREAM_UPLOAD: 'start_stream_upload',
    COMPLETE: 'complete',
    FAIL: 'fail',
    CANCEL: 'cancel',
    RETRY: 'retry',
    RESET_UPLOAD: 'reset_upload',
    RESET_STREAM_DOWNLOAD: 'reset_stream_download',
    RESET_STALLED: 'reset_stalled'
});

export const TASK_TERMINAL_STATUSES = Object.freeze([
    TASK_STATUSES.COMPLETED,
    TASK_STATUSES.FAILED,
    TASK_STATUSES.CANCELLED
]);

export const TASK_ACTIVE_STATUSES = Object.freeze([
    TASK_STATUSES.QUEUED,
    TASK_STATUSES.DOWNLOADING,
    TASK_STATUSES.DOWNLOADED,
    TASK_STATUSES.UPLOADING
]);

const ALL_STATUSES = Object.freeze(Object.values(TASK_STATUSES));
const STATUS_SET = new Set(ALL_STATUSES);
const TERMINAL_STATUS_SET = new Set(TASK_TERMINAL_STATUSES);

export const TASK_TRANSITIONS = Object.freeze({
    [TASK_EVENTS.START_DOWNLOAD]: Object.freeze({
        to: TASK_STATUSES.DOWNLOADING,
        from: Object.freeze([TASK_STATUSES.QUEUED, TASK_STATUSES.DOWNLOADING])
    }),
    [TASK_EVENTS.FINISH_DOWNLOAD]: Object.freeze({
        to: TASK_STATUSES.DOWNLOADED,
        from: Object.freeze([TASK_STATUSES.DOWNLOADING, TASK_STATUSES.DOWNLOADED])
    }),
    [TASK_EVENTS.START_UPLOAD]: Object.freeze({
        to: TASK_STATUSES.UPLOADING,
        from: Object.freeze([TASK_STATUSES.DOWNLOADED, TASK_STATUSES.UPLOADING])
    }),
    [TASK_EVENTS.START_STREAM_UPLOAD]: Object.freeze({
        to: TASK_STATUSES.UPLOADING,
        from: Object.freeze([TASK_STATUSES.DOWNLOADING, TASK_STATUSES.UPLOADING])
    }),
    [TASK_EVENTS.COMPLETE]: Object.freeze({
        to: TASK_STATUSES.COMPLETED,
        from: Object.freeze([
            TASK_STATUSES.QUEUED,
            TASK_STATUSES.DOWNLOADING,
            TASK_STATUSES.DOWNLOADED,
            TASK_STATUSES.UPLOADING,
            TASK_STATUSES.COMPLETED
        ])
    }),
    [TASK_EVENTS.FAIL]: Object.freeze({
        to: TASK_STATUSES.FAILED,
        from: Object.freeze([
            TASK_STATUSES.QUEUED,
            TASK_STATUSES.DOWNLOADING,
            TASK_STATUSES.DOWNLOADED,
            TASK_STATUSES.UPLOADING,
            TASK_STATUSES.FAILED
        ])
    }),
    [TASK_EVENTS.CANCEL]: Object.freeze({
        to: TASK_STATUSES.CANCELLED,
        from: Object.freeze([
            TASK_STATUSES.QUEUED,
            TASK_STATUSES.DOWNLOADING,
            TASK_STATUSES.DOWNLOADED,
            TASK_STATUSES.UPLOADING,
            TASK_STATUSES.CANCELLED
        ])
    }),
    [TASK_EVENTS.RETRY]: Object.freeze({
        to: TASK_STATUSES.QUEUED,
        from: Object.freeze([
            TASK_STATUSES.QUEUED,
            TASK_STATUSES.DOWNLOADING,
            TASK_STATUSES.DOWNLOADED,
            TASK_STATUSES.UPLOADING,
            TASK_STATUSES.FAILED
        ])
    }),
    [TASK_EVENTS.RESET_UPLOAD]: Object.freeze({
        to: TASK_STATUSES.DOWNLOADED,
        from: Object.freeze([
            TASK_STATUSES.DOWNLOADED,
            TASK_STATUSES.UPLOADING
        ])
    }),
    [TASK_EVENTS.RESET_STREAM_DOWNLOAD]: Object.freeze({
        to: TASK_STATUSES.DOWNLOADING,
        from: Object.freeze([
            TASK_STATUSES.DOWNLOADING,
            TASK_STATUSES.UPLOADING,
            TASK_STATUSES.FAILED
        ])
    }),
    [TASK_EVENTS.RESET_STALLED]: Object.freeze({
        to: TASK_STATUSES.QUEUED,
        from: Object.freeze([
            TASK_STATUSES.DOWNLOADING,
            TASK_STATUSES.DOWNLOADED,
            TASK_STATUSES.UPLOADING
        ])
    })
});

const EVENT_BY_TARGET_STATUS = Object.freeze({
    [TASK_STATUSES.QUEUED]: TASK_EVENTS.RETRY,
    [TASK_STATUSES.DOWNLOADING]: TASK_EVENTS.START_DOWNLOAD,
    [TASK_STATUSES.DOWNLOADED]: TASK_EVENTS.FINISH_DOWNLOAD,
    [TASK_STATUSES.UPLOADING]: TASK_EVENTS.START_UPLOAD,
    [TASK_STATUSES.COMPLETED]: TASK_EVENTS.COMPLETE,
    [TASK_STATUSES.FAILED]: TASK_EVENTS.FAIL,
    [TASK_STATUSES.CANCELLED]: TASK_EVENTS.CANCEL
});

export class TaskStateTransitionError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'TaskStateTransitionError';
        this.code = 'TASK_STATE_INVALID_TRANSITION';
        this.details = details;
    }
}

export class TaskStateMachine {
    static get statuses() {
        return ALL_STATUSES;
    }

    static isKnownStatus(status) {
        return STATUS_SET.has(status);
    }

    static isTerminalStatus(status) {
        return TERMINAL_STATUS_SET.has(status);
    }

    static getTransition(event) {
        return TASK_TRANSITIONS[event] || null;
    }

    static getEventForTargetStatus(status) {
        if (!this.isKnownStatus(status)) {
            throw new TaskStateTransitionError(`Unknown task status: ${status}`, { status });
        }
        return EVENT_BY_TARGET_STATUS[status];
    }

    static resolveTransition(currentStatus, eventOrStatus) {
        if (!this.isKnownStatus(currentStatus)) {
            throw new TaskStateTransitionError(`Unknown current task status: ${currentStatus}`, { currentStatus });
        }

        const event = TASK_TRANSITIONS[eventOrStatus]
            ? eventOrStatus
            : this.getEventForTargetStatus(eventOrStatus);
        const transition = this.getTransition(event);

        if (!transition) {
            throw new TaskStateTransitionError(`Unknown task event: ${event}`, { event });
        }

        const targetStatus = transition.to;
        const allowed = transition.from.includes(currentStatus);
        const idempotent = currentStatus === targetStatus;

        return {
            allowed,
            event,
            fromStatus: currentStatus,
            toStatus: targetStatus,
            idempotent,
            reason: allowed ? null : `Cannot transition task from ${currentStatus} to ${targetStatus} via ${event}`
        };
    }

    static assertTransition(currentStatus, eventOrStatus) {
        const resolution = this.resolveTransition(currentStatus, eventOrStatus);
        if (!resolution.allowed) {
            throw new TaskStateTransitionError(resolution.reason, resolution);
        }
        return resolution;
    }

    static allowedFromForEvent(eventOrStatus) {
        const event = TASK_TRANSITIONS[eventOrStatus]
            ? eventOrStatus
            : this.getEventForTargetStatus(eventOrStatus);
        const transition = this.getTransition(event);

        if (!transition) {
            throw new TaskStateTransitionError(`Unknown task event: ${event}`, { event });
        }

        return [...transition.from];
    }

    static targetStatusForEvent(eventOrStatus) {
        const event = TASK_TRANSITIONS[eventOrStatus]
            ? eventOrStatus
            : this.getEventForTargetStatus(eventOrStatus);
        const transition = this.getTransition(event);

        if (!transition) {
            throw new TaskStateTransitionError(`Unknown task event: ${event}`, { event });
        }

        return transition.to;
    }
}
