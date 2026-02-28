import { dependencyContainer } from "../../services/DependencyContainer.js";

// Get dependencies from dependency container
const { TaskRepository, logger, STRINGS, format, UIHelper } = dependencyContainer.getAll();

const log = logger.withModule('TaskManager.utils');

/**
 * Create heartbeat function for task status updates
 * @param {Object} task - Task object
 * @param {Object} context - Context object containing cancelledTaskIds and _refreshGroupMonitor
 * @param {Function} updateStatus - Update status function
 * @param {string} fileName - File name for progress display
 * @returns {Function} Heartbeat function
 */
export function createHeartbeat(task, context, updateStatus, fileName = null) {
    let lastUpdate = 0;
    
    return async (status, downloaded = 0, total = 0, uploadProgress = null) => {
        // Check if task is cancelled
        if (context.cancelledTaskIds.has(task.id)) {
            task.isCancelled = true;
            throw new Error("CANCELLED");
        }
        
        // Update task status in database
        await TaskRepository.updateStatus(task.id, status);

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
export async function handleTaskCompletion(task, context, updateStatus, fileName, actualUploadPath, fileLink) {
    await TaskRepository.updateStatus(task.id, 'completed');
    
    if (task.isGroup) {
        await context._refreshGroupMonitor(task, 'completed');
    } else {
        const fileNameHtml = `<a href="${fileLink}">${escapeHTML(fileName)}</a>`;
        await updateStatus(task, format(STRINGS.task.success_sec_transfer, { name: fileNameHtml, folder: actualUploadPath }), true);
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
    const status = isCancelled ? 'cancelled' : 'failed';
    await TaskRepository.updateStatus(task.id, status, errorMessage);
    
    if (task.isGroup) {
        await context._refreshGroupMonitor(task, status);
    } else {
        const text = isCancelled ? STRINGS.task.cancelled : `${STRINGS.task.error_prefix}<code>${escapeHTML(errorMessage)}</code>`;
        await updateStatus(task, text, true);
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
    if (task.isCancelled || uploadResult.error === "CANCELLED") {
        throw new Error("CANCELLED");
    }

    const errorMessage = uploadResult.error || "Upload failed";
    await TaskRepository.updateStatus(task.id, 'failed', errorMessage);
    
    if (task.isGroup) {
        await context._refreshGroupMonitor(task, 'failed', 0, 0, errorMessage);
    } else {
        await updateStatus(task, format(STRINGS.task.failed_upload, {
            reason: task.isCancelled ? "User cancelled manually" : escapeHTML(errorMessage)
        }), true);
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
