import { dependencyContainer } from "../../services/DependencyContainer.js";
import { TASK_EVENTS, TASK_STATUSES } from "../../domain/task-state-machine.js";
import { getClaimFenceOptions } from "./claim-fence.js";
import { redactSensitiveText } from "../../utils/serializer.js";

// 获取依赖项的辅助函数
const getDeps = () => dependencyContainer.getAll();
const getLog = () => getDeps().logger.withModule('TaskManager.utils');

/**
 * Create heartbeat function for task status updates
 * @param {Object} task - Task object
 * @param {Object} context - Context object containing cancelledTaskIds and _refreshGroupMonitor
 * @param {Function} updateStatus - Update status function
 * @param {string} fileName - File name for progress display
 * @returns {Function} Heartbeat function
 */
export function createHeartbeat(task, context, updateStatus, fileName = null) {
    const { TaskRepository, STRINGS, UIHelper } = getDeps();
    let lastUpdate = 0;
    
    return async (status, downloaded = 0, total = 0, uploadProgress = null) => {
        // Check if task is cancelled
        if (context.cancelledTaskIds.has(task.id)) {
            task.isCancelled = true;
            throw new Error("CANCELLED");
        }
        
        const event = status === 'uploading' ? TASK_EVENTS.START_UPLOAD : TASK_EVENTS.START_DOWNLOAD;
        const transition = await TaskRepository.transitionStatus(task.id, event, null, {
            ...getClaimFenceOptions(task),
            returnResult: true,
            allowNoop: true,
            source: 'heartbeat'
        });
        if (transition.blocked) return;

        if (task.isGroup) {
            // Update group monitor for group tasks
            await context._refreshGroupMonitor(task, status, downloaded, total);
        } else {
            let text;
            if (status === 'uploading' && uploadProgress) {
                // Render progress for upload tasks
                text = UIHelper.renderProgress(uploadProgress.bytes, uploadProgress.size, STRINGS.task.uploading, fileName);
            } else if (downloaded > 0) {
                // Render progress for download tasks
                text = UIHelper.renderProgress(downloaded, total, STRINGS.task.downloading, fileName);
            } else {
                // Default status text
                text = status === 'uploading' ? STRINGS.task.uploading : STRINGS.task.downloading;
            }
            
            // Update status for single tasks
            await updateStatus(task, text);
        }
    };
}

/**
 * Handle task completion
 * @param {Object} task - Task object
 * @param {Object} context - Context object containing _refreshGroupMonitor
 * @param {Function} updateStatus - Update status function
 * @param {string} fileName - File name for status display
 * @param {string} actualUploadPath - Actual upload path
 * @param {string} fileLink - File link for status display
 */
export async function handleTaskCompletion(task, context, updateStatus, fileName, actualUploadPath, fileLink, options = {}) {
    const { TaskRepository, STRINGS, format } = getDeps();
    const transition = await TaskRepository.transitionStatus(task.id, TASK_EVENTS.COMPLETE, null, {
        ...getClaimFenceOptions(task),
        returnResult: true,
        allowNoop: true,
        source: options.source || 'handleTaskCompletion'
    });
    if (transition.blocked) return;
    
    if (task.isGroup) {
        await context._refreshGroupMonitor(task, TASK_STATUSES.COMPLETED);
    } else {
        const fileNameHtml = fileLink
            ? `<a href="${fileLink}">${escapeHTML(fileName)}</a>`
            : `<code>${escapeHTML(fileName)}</code>`;
        const template = options.successTemplate || STRINGS.task.success_sec_transfer;
        await updateStatus(task, format(template, { name: fileNameHtml, folder: actualUploadPath }), true);
    }
}

/**
 * Handle task failure
 * @param {Object} task - Task object
 * @param {Object} context - Context object containing _refreshGroupMonitor
 * @param {Function} updateStatus - Update status function
 * @param {string} errorMessage - Error message
 * @param {boolean} isCancelled - Whether task was cancelled
 */
export async function handleTaskFailure(task, context, updateStatus, errorMessage, isCancelled = false) {
    const { TaskRepository, STRINGS } = getDeps();
    const event = isCancelled ? TASK_EVENTS.CANCEL : TASK_EVENTS.FAIL;
    const safeErrorMessage = redactSensitiveText(errorMessage);
    const transition = await TaskRepository.transitionStatus(task.id, event, safeErrorMessage, {
        ...getClaimFenceOptions(task),
        returnResult: true,
        allowNoop: true,
        source: 'handleTaskFailure'
    });
    if (transition.blocked) return;
    const status = transition.toStatus;
    
    if (task.isGroup) {
        await context._refreshGroupMonitor(task, status);
    } else {
        const text = isCancelled ? STRINGS.task.cancelled : `${STRINGS.task.error_prefix}<code>${escapeHTML(safeErrorMessage)}</code>`;
        await updateStatus(task, text, true, null, !isCancelled);
    }
}

/**
 * Handle upload failure
 * @param {Object} task - Task object
 * @param {Object} context - Context object containing _refreshGroupMonitor
 * @param {Function} updateStatus - Update status function
 * @param {Object} uploadResult - Upload result object
 */
export async function handleUploadFailure(task, context, updateStatus, uploadResult) {
    const { TaskRepository, STRINGS, format } = getDeps();
    if (task.isCancelled || uploadResult.error === "CANCELLED") {
        throw new Error("CANCELLED");
    }

    const errorMessage = redactSensitiveText(uploadResult.error || "Upload failed");
    const transition = await TaskRepository.transitionStatus(task.id, TASK_EVENTS.FAIL, errorMessage, {
        ...getClaimFenceOptions(task),
        returnResult: true,
        allowNoop: true,
        source: 'handleUploadFailure'
    });
    if (transition.blocked) return;
    
    if (task.isGroup) {
        await context._refreshGroupMonitor(task, TASK_STATUSES.FAILED, 0, 0, errorMessage);
    } else {
        await updateStatus(task, format(STRINGS.task.failed_upload, {
            reason: task.isCancelled ? "User cancelled manually" : escapeHTML(errorMessage)
        }), true, null, true);
    }
}

/**
 * Escape HTML special characters
 * @param {string} str - String to escape
 * @returns {string} Escaped string
 */
export function escapeHTML(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
