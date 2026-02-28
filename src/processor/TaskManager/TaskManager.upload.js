import path from "path";
import fs from "fs";
import { dependencyContainer } from "../../services/DependencyContainer.js";
import { createHeartbeat, handleTaskCompletion, handleTaskFailure, handleUploadFailure, escapeHTML } from "./TaskManager.utils.js";

// Get dependencies from dependency container
const { config, CloudTool, ossService, getMediaInfo, updateStatus, TaskRepository, instanceCoordinator, logger, STRINGS, format } = dependencyContainer.getAll();

const log = logger.withModule('TaskManager.upload');

/**
 * Upload Task - Responsible for rclone transfer phase (no MTProto required)
 */
export async function uploadTask(task) {
    const { id } = task;

    // Distributed lock: Try to acquire task lock to ensure same task won't be processed by multiple instances
    const lockAcquired = await instanceCoordinator.acquireTaskLock(id);
    if (!lockAcquired) {
        log.info("Task lock exists, skipping upload", { taskId: id, instance: 'current' });
        return;
    }

    let didActivate = false;
    let localPath = null;
    let info = null;

    try {
        // Anti-reentrancy: Add check for upload Task as well
        if (this.activeProcessors.has(id)) {
            log.warn("Task already processing, skipping upload", { taskId: id });
            return;
        }
        this.activeProcessors.add(id);
        this.inFlightTasks.set(id, task);
        didActivate = true;

        info = getMediaInfo(task.message.media);
        if (!info) {
            return;
        }

        localPath = task.localPath;
        if (!fs.existsSync(localPath)) {
            await TaskRepository.updateStatus(task.id, 'failed', 'Local file not found');
            const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
            const fileNameHtml = `<a href="${fileLink}">${escapeHTML(info.name)}</a>`;
            await updateStatus(task, format(STRINGS.task.failed_validation, { name: fileNameHtml }), true);
            return;
        }

        // Create heartbeat function
        const heartbeat = createHeartbeat(task, this, updateStatus, info.name);

        // Duplicate check before upload: Skip upload if remote file with same name and size already exists
        // Use fast check mode: no retry, skip time-consuming directory fallback
        const fileName = path.basename(localPath);
        const remoteFile = await CloudTool.getRemoteFileInfo(fileName, task.userId, 1, true);
        
        if (remoteFile && this._isSizeMatch(remoteFile.Size, info.size)) {
            const actualUploadPath = await CloudTool._getUploadPath(task.userId);
            const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
            await handleTaskCompletion(task, this, updateStatus, fileName, actualUploadPath, fileLink);
            return;
        }

        // Upload phase - Choose upload method based on drive type
        // Execute status update and heartbeat in parallel
        await Promise.all([
            task.isGroup ? Promise.resolve() : updateStatus(task, STRINGS.task.uploading),
            heartbeat('uploading')
        ]);

        let uploadResult;
        const isR2Drive = config.remoteName === 'r2' && config.oss?.r2?.bucket;
        let lastUpdate = Date.now();

        try {
            if (isR2Drive) {
                // Use OSS service for dual-track upload
                log.info(`📤 Using OSS service to upload to R2: ${fileName}`);
                uploadResult = await ossService.upload(localPath, fileName, (progress) => {
                    const now = Date.now();
                    if (now - lastUpdate > 3000) {
                        lastUpdate = now;
                        void heartbeat('uploading', 0, 0, progress).catch((err) => {
                            if (err?.message === "CANCELLED") return;
                            log.warn("Upload heartbeat failed", { taskId: task.id, error: err?.message || String(err) });
                        });
                    }
                }, task.userId);
                // Convert OSS result to expected format
                uploadResult = uploadResult.success ? { success: true } : { success: false, error: uploadResult.error };
            } else {
                // Use rclone to upload single file directly
                log.info(`📤 Using rclone to upload directly: ${fileName}`);
                uploadResult = await CloudTool.uploadFile(localPath, task, (progress) => {
                    const now = Date.now();
                    if (now - lastUpdate > 3000) {
                        lastUpdate = now;
                        void heartbeat('uploading', 0, 0, progress).catch((err) => {
                            if (err?.message === "CANCELLED") return;
                            log.warn("Upload heartbeat failed", { taskId: task.id, error: err?.message || String(err) });
                        });
                    }
                });
            }
        } catch (uploadError) {
            log.error(`Upload failed for task ${task.id}:`, uploadError);
            throw new Error(`Upload failed: ${uploadError.message}`);
        }

        // Result processing
        if (uploadResult.success) {
            if (!task.isGroup) await updateStatus(task, STRINGS.task.verifying);
            
            // Add delay before validation to handle cloud storage API eventual consistency delay
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Extract correct file name from actual local file path
            const actualFileName = path.basename(localPath);

            // More robust file validation logic
            let finalRemote = null;
            let validationAttempts = 0;
            const maxValidationAttempts = 5;

            while (validationAttempts < maxValidationAttempts) {
                finalRemote = await CloudTool.getRemoteFileInfo(actualFileName, task.userId, 2); // Reduce internal retry count for each validation
                if (finalRemote) break;

                validationAttempts++;
                if (validationAttempts < maxValidationAttempts) {
                    // If this is the last attempt, force refresh file list cache
                    if (validationAttempts === maxValidationAttempts - 1) {
                        log.info(`Final attempt for ${actualFileName}, forcing cache refresh...`);
                        try {
                            await CloudTool.listRemoteFiles(task.userId, true); // Force refresh cache
                            // Try again
                            finalRemote = await CloudTool.getRemoteFileInfo(actualFileName, task.userId, 1);
                            if (finalRemote) break;
                        } catch (e) {
                            log.warn(`Cache refresh failed:`, e);
                        }
                    }

                    log.info(`Attempt ${validationAttempts} failed for ${actualFileName}, retrying in ${validationAttempts * 5}s...`);
                    await new Promise(resolve => setTimeout(resolve, validationAttempts * 5000)); // Increasing delay: 5s, 10s, 15s, 20s
                }
            }

            const localSize = fs.statSync(localPath).size;
            const isOk = finalRemote && this._isSizeMatch(finalRemote.Size, localSize);

            if (!isOk) {
                log.error(`Validation Failed - Task: ${task.id}, File: ${actualFileName}`);
                log.error(`- Local Size: ${localSize}`);
                log.error(`- Remote Size: ${finalRemote ? finalRemote.Size : 'N/A'}`);
                log.error(`- Remote Info: ${JSON.stringify(finalRemote)}`);
                log.error(`- Validation attempts: ${validationAttempts}`);
            }

            const finalStatus = isOk ? 'completed' : 'failed';
            const errorMsg = isOk ? null : `Validation failed: local(${localSize}) vs remote(${finalRemote ? finalRemote.Size : 'not found'})`;
            await TaskRepository.updateStatus(task.id, finalStatus, errorMsg);

            if (task.isGroup) {
                await this._refreshGroupMonitor(task, finalStatus, 0, 0, errorMsg);
            } else {
                const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
                const fileNameHtml = `<a href="${fileLink}">${escapeHTML(info.name)}</a>`;
                const baseText = isOk
                    ? format(STRINGS.task.success, { name: fileNameHtml, folder: config.remoteFolder })
                    : format(STRINGS.task.failed_validation, { name: fileNameHtml });
                
                const finalMsg = isOk ? baseText : `${baseText}\n<code>${escapeHTML(errorMsg)}</code>`;
                await updateStatus(task, finalMsg, true);
            }
        } else {
            await handleUploadFailure(task, this, updateStatus, uploadResult);
        }
    } catch (e) {
        const isCancel = e.message === "CANCELLED";
        await handleTaskFailure(task, this, updateStatus, e.message, isCancel);
    } finally {
        // Clean up local file asynchronously after upload
        if (localPath) {
            try {
                if (fs.promises && fs.promises.unlink) {
                    await fs.promises.unlink(localPath);
                } else {
                    fs.unlinkSync(localPath);
                }
            } catch (e) {
                log.warn(`Failed to cleanup local file ${localPath}:`, e);
            }
        }
        
        // Ensure activeProcessors is cleaned up
        this.activeProcessors.delete(id);
        
        // Ensure inFlightTasks is cleaned up
        if (didActivate) {
            this.inFlightTasks.delete(id);
        }
        
        // Ensure distributed lock is released
        await instanceCoordinator.releaseTaskLock(id);
    }
}