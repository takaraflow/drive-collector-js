export const CACHE_KEYS = Object.freeze({
    prefixes: Object.freeze({
        taskStatus: 'task_status:',
        taskDetails: 'task:',
        consistentTask: 'consistent:task:',
        taskLock: 'lock:task:',
        instance: 'instance:',
        drive: 'drive:',
        config: 'config:',
        queueDlq: 'queue:dlq:',
        distributedLock: 'distributed_lock:',
        streamOwner: 'stream:owner:',
        streamProgress: 'stream:progress:',
        streamFinalization: 'stream:final:'
    }),

    setting: key => `setting:${key}`,
    session: userId => `session:${userId}`,

    driveByUser: userId => `drive:${userId}`,
    driveById: driveId => `drive_id:${driveId}`,
    activeDrives: () => "drives:active",
    localDriveByUser: userId => `drive_${userId}`,
    filesByUser: userId => `files_${userId}`,
    uploadPathByUser: userId => `upload_path_${userId}`,

    lock: lockKey => `lock:${lockKey}`,
    telegramClientLock: () => "lock:telegram_client",
    taskLock: taskId => `lock:task:${taskId}`,

    taskStatus: taskId => `task_status:${taskId}`,
    consistentTask: taskId => `consistent:task:${taskId}`,
    taskSync: taskId => `sync:${taskId}`,
    taskStatusPattern: () => 'task_status:*',
    taskLockPattern: () => 'lock:task:*',

    queueDlq: dlqId => `queue:dlq:${dlqId}`,
    queueDlqPrefix: () => 'queue:dlq:',

    streamOwner: taskId => `stream:owner:${taskId}`,
    streamProgress: taskId => `stream:progress:${taskId}`,
    streamFinalization: taskId => `stream:final:${taskId}`
});
