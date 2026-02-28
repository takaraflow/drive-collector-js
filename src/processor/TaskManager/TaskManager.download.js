import path from "path";
import fs from "fs";
import { dependencyContainer } from "../../services/DependencyContainer.js";
import { createHeartbeat, handleTaskCompletion, handleTaskFailure, escapeHTML } from "./TaskManager.utils.js";

// Get dependencies from dependency container
const { config, client, CloudTool, getMediaInfo, updateStatus, safeEdit, runBotTask, runMtprotoTask, runBotTaskWithRetry, runMtprotoTaskWithRetry, runMtprotoFileTaskWithRetry, PRIORITY, TaskRepository, queueService, logger, STRINGS, format, streamTransferService, instanceCoordinator } = dependencyContainer.getAll();

const log = logger.withModule('TaskManager');

/**
 * Download Task - Responsible for MTProto download phase
 */
export async function downloadTask(task) {
        const { message, id } = task;
        if (!message.media) return;

        // Distributed lock: Try to acquire task lock to ensure same task won't be processed by multiple instances
        const lockAcquired = await instanceCoordinator.acquireTaskLock(id);
        if (!lockAcquired) {
            log.info("Task lock exists, skipping download", { taskId: id, instance: 'current' });
            return;
        }

        let didActivate = false;

        try {
            // Anti-reentrancy: Check if task is already being processed
            if (this.activeProcessors.has(id)) {
                log.warn("Task already processing, skipping download", { taskId: id });
                return;
            }
            this.activeProcessors.add(id);
            this.inFlightTasks.set(id, task);
            didActivate = true;

            this.waitingTasks = this.waitingTasks.filter(t => t.id !== id);
            this.updateQueueUI();

            const info = getMediaInfo(message.media);
            if (!info) {
                this.activeProcessors.delete(id);
                return await updateStatus(task, STRINGS.task.parse_failed, true);
            }

            // Use existing file name from task (for consistency), or use info.name if not exist
            const fileName = task.fileName || info.name;
            const localPath = path.join(config.downloadDir, fileName);
            task.localPath = localPath;

            // Create heartbeat function
            const heartbeat = createHeartbeat(task, this, updateStatus, fileName);

            try {
                // 1. Concurrent processing: Asynchronously initiate UI update without blocking instant transfer check and download preparation
                const initialHeartbeat = heartbeat('downloading', 0, 0)
                    .catch(e => log.warn("Initial heartbeat failed", e));
                
                // 2. Priority check for remote instant transfer (using fast check mode: no retry, skip fallback)
                const remoteFile = await CloudTool.getRemoteFileInfo(fileName, task.userId, 1, true);

                if (remoteFile && this._isSizeMatch(remoteFile.Size, info.size)) {
                    // Instant transfer hit, ensure UI update completes before showing success
                    await initialHeartbeat; 
                    
                    const actualUploadPath = await CloudTool._getUploadPath(task.userId);
                    const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
                    await handleTaskCompletion(task, this, updateStatus, fileName, actualUploadPath, fileLink);
                    
                    this.activeProcessors.delete(id);
                    // Instant transfer complete, no need to upload
                    return;
                }

                // 2. Local file check (resume or use local cache)
                let localFileExists = false;
                let localFileSize = 0;

                try {
                    const stats = await fs.promises.stat(localPath);
                    localFileExists = true;
                    localFileSize = stats.size;
                } catch (e) {
                    // File does not exist, continue downloading
                }

                // If local file exists and is complete, skip download and directly enter upload process
                if (localFileExists && this._isSizeMatch(localFileSize, info.size)) {
                    // Local file is intact, directly trigger upload webhook
                    await TaskRepository.updateStatus(task.id, 'downloaded');
                    if (!task.isGroup) {
                        await updateStatus(task, format(STRINGS.task.downloaded_waiting_upload, { name: escapeHTML(fileName) }));
                    }
                    this.activeProcessors.delete(id);
                    await queueService.enqueueUploadTask(task.id, {
                        userId: task.userId,
                        chatId: task.chatId,
                        msgId: task.msgId,
                        localPath: task.localPath
                    });
                    log.info("Local file exists, triggered upload webhook", { taskId: task.id });
                    return;
                }

                const isLargeFile = info.size > 100 * 1024 * 1024;

                // 3. Check if stream forwarding mode is enabled
                const activeInstances = (await instanceCoordinator.getActiveInstances?.()) || [];
                const otherInstances = activeInstances.filter(inst => inst.id !== instanceCoordinator.instanceId);
                const streamEnabled = config.streamForwarding?.enabled && otherInstances.length > 0;

                // Stream transfer status log
                if (streamEnabled) {
                    log.info(`🚀 Stream transfer enabled! Task: ${task.id} (${task.fileName})`, {
                        configEnabled: config.streamForwarding?.enabled,
                        otherInstancesCount: otherInstances.length,
                        activeInstances: activeInstances.map(i => i.id),
                        currentInstance: instanceCoordinator.instanceId,
                        lbUrl: config.streamForwarding?.lbUrl,
                        externalUrl: config.streamForwarding?.externalUrl
                    });
                } else {
                    const reason = config.streamForwarding?.enabled
                        ? '❌ No other active instances'
                        : '❌ Configuration not enabled';
                        
                    log.info(`⚠️ Stream transfer not enabled! Task: ${task.id} (${task.fileName}), reason: ${reason}`, {
                        configStatus: config.streamForwarding,
                        activeInstancesCount: activeInstances.length,
                        otherInstancesCount: otherInstances.length,
                        currentInstance: instanceCoordinator.instanceId
                    });
                }

                if (streamEnabled) {
                    let targetUrl = config.streamForwarding.lbUrl;
                    if (!targetUrl) {
                        const bestWorker = otherInstances.sort((a, b) => (a.activeTaskCount || 0) - (b.activeTaskCount || 0))[0];
                        if (bestWorker) targetUrl = bestWorker.tunnelUrl || bestWorker.url;
                    }

                    if (targetUrl) {
                        try {
                            log.info(`🚀 Starting stream forwarding mode: Task ${task.id}, Target: ${targetUrl}`);
                            await updateStatus(task, "🚀 **Uploading via stream forwarding...**");

                            const { tunnelService } = await import("../../services/TunnelService.js");
                            const tunnelUrl = await tunnelService.getPublicUrl();
                            const leaderUrl = tunnelUrl || config.streamForwarding.externalUrl || `http://localhost:${config.port}`;

                            // Resume transfer: Check if can resume
                            let chunkIndex = 0;
                            let resumeInfo = null;
                            
                            try {
                                // Query Worker progress
                                const progressUrl = `${targetUrl.replace(/\/$/, '')}/api/v2/stream/${task.id}/full-progress`;
                                const progressResponse = await fetch(progressUrl, {
                                    method: 'GET',
                                    headers: {
                                        'x-instance-secret': config.streamForwarding.secret
                                    }
                                });
                                
                                if (progressResponse.ok) {
                                    const progressData = await progressResponse.json();
                                    if (progressData.isCached || progressData.isActive) {
                                        chunkIndex = progressData.lastChunkIndex + 1;
                                        resumeInfo = progressData;
                                        log.info(`🔄 Resume transfer: Resume task ${task.id} from chunk ${chunkIndex}`);
                                        await updateStatus(task, `🔄 **Resuming transfer... (from ${(progressData.uploadedBytes / 1024 / 1024).toFixed(2)}MB)**`);
                                    }
                                }
                            } catch (resumeError) {
                                log.debug(`Resume check failed, will start from beginning: ${resumeError.message}`);
                            }

                            // Create download iterator
                            const downloadIterator = client.iterDownload({
                                file: message.media,
                                requestSize: isLargeFile ? 512 * 1024 : 128 * 1024
                            });

                            // If resuming, need to skip already transferred chunks
                            if (resumeInfo && chunkIndex > 0) {
                                log.info(`⏭️ Skipping first ${chunkIndex} chunks (resume)`);
                                for (let i = 0; i < chunkIndex; i++) {
                                    await downloadIterator.next();
                                    // Update download progress to keep consistent
                                    const downloaded = Math.min((i + 1) * (isLargeFile ? 512 * 1024 : 128 * 1024), info.size);
                                    if (i % 20 === 0) {
                                        await updateStatus(task, UIHelper.renderProgress(downloaded, info.size, "⏭️ Skipping transferred parts...", fileName));
                                    }
                                }
                            }

                            // Continue transferring remaining chunks
                            for await (const chunk of downloadIterator) {
                                if (this.cancelledTaskIds.has(task.id)) throw new Error("CANCELLED");
                                const isLast = chunkIndex * (isLargeFile ? 512 * 1024 : 128 * 1024) + chunk.length >= info.size;
                                
                                await streamTransferService.forwardChunk(task.id, chunk, {
                                    fileName, userId: task.userId, chunkIndex, isLast, 
                                    totalSize: info.size, leaderUrl, chatId: task.chatId, msgId: task.msgId, 
                                    sourceMsgId: task.message.id, targetUrl
                                });
                                
                                const downloaded = chunkIndex * (isLargeFile ? 512 * 1024 : 128 * 1024) + chunk.length;
                                if (chunkIndex % 20 === 0 || isLast) {
                                    const statusText = resumeInfo ? "🔄 Resuming transfer..." : "📥 Forwarding stream...";
                                    await updateStatus(task, UIHelper.renderProgress(downloaded, info.size, statusText, fileName));
                                }
                                chunkIndex++;
                            }
                            log.info(`✅ Stream forwarding completed: Task ${task.id}`);
                            this.activeProcessors.delete(id);
                            return;
                        } catch (e) {
                            if (e.message === "CANCELLED") throw e;
                            log.error(`❌ Stream forwarding failed, falling back to local download mode: ${e.message}`);
                        }
                    }
                }

                // Download phase - MTProto file download
                let lastUpdate = Date.now();
                const downloadOptions = {
                    outputFile: localPath,
                    chunkSize: isLargeFile ? 512 * 1024 : 128 * 1024,
                    workers: isLargeFile ? 3 : 1,
                    progressCallback: async (downloaded, total) => {
                        const now = Date.now();
                        if (now - lastUpdate > 3000 || downloaded === total) {
                            lastUpdate = now;
                            await heartbeat('downloading', downloaded, total);
                        }
                    }
                };

                try {
                    await runMtprotoFileTaskWithRetry(() => client.downloadMedia(message, downloadOptions), {}, 10); // Increase retry count to 10
                } catch (downloadError) {
                    log.error(`Download failed for task ${task.id}:`, downloadError);
                    throw new Error(`Download failed: ${downloadError.message}`);
                }

                // Download complete, push to upload queue
                await TaskRepository.updateStatus(task.id, 'downloaded');
                if (!task.isGroup) {
                    await updateStatus(task, format(STRINGS.task.downloaded_waiting_upload, { name: escapeHTML(fileName) }));
                }

                // Trigger upload webhook
                this.activeProcessors.delete(id);
                await queueService.enqueueUploadTask(task.id, {
                    userId: task.userId,
                    chatId: task.chatId,
                    msgId: task.msgId,
                    localPath: task.localPath
                });
                log.info("Download complete, triggered upload webhook", { taskId: task.id });

            } catch (e) {
                const isCancel = e.message === "CANCELLED";
                try {
                    await handleTaskFailure(task, this, updateStatus, e.message, isCancel);
                } catch (updateError) {
                    log.error(`Failed to update task status for ${task.id}:`, updateError);
                }
                this.activeProcessors.delete(id);
            }
        } finally {
            if (didActivate) this.inFlightTasks.delete(id);
            // Ensure distributed lock is released
            await instanceCoordinator.releaseTaskLock(id);
        }
}
