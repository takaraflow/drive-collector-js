import path from "path";
import fs from "fs";
import bigInt from "big-integer";
import { dependencyContainer } from "../../services/DependencyContainer.js";
import { createHeartbeat, handleTaskCompletion, handleTaskFailure, escapeHTML } from "./TaskManager.utils.js";
import { assertClaimFenceCurrent, getClaimFenceOptions } from "./claim-fence.js";
import { resolveInstanceBaseUrl } from "../../utils/instanceUrl.js";
import { TASK_EVENTS } from "../../domain/task-state-machine.js";
import { TASK_QUEUE_TRIGGER_SOURCES, TaskProcessingLockBusyError } from "../../domain/task-queue-contract.js";

// 获取模块日志记录器
const getLog = () => dependencyContainer.get('logger').withModule('TaskManager');

/**
 * Download Task - Responsible for MTProto download phase
 */
export async function downloadTask(task) {
    const { 
        config, client, CloudTool, getMediaInfo, updateStatus, safeEdit, 
        runBotTask, runMtprotoTask, runBotTaskWithRetry, runMtprotoTaskWithRetry, 
        runMtprotoFileTaskWithRetry, PRIORITY, TaskRepository, queueService, 
        STRINGS, format, streamTransferService, instanceCoordinator 
    } = dependencyContainer.getAll();
    const log = getLog();

        const { message, id } = task;
        if (!message.media) return;

        const ownsProcessingLock = task.processingLockHeld === true;
        let lockAcquired = ownsProcessingLock;
        if (!ownsProcessingLock) {
            lockAcquired = await instanceCoordinator.acquireTaskLock(id);
            if (!lockAcquired) {
                log.info("Task lock exists, skipping download", { taskId: id, instance: 'current' });
                throw new TaskProcessingLockBusyError(id, 'download');
            }
        }

        let didActivate = false;

        try {
            // Anti-reentrancy: Check if task is already being processed
            if (this.activeProcessors.has(id)) {
                log.warn("Task already processing, skipping download", { taskId: id });
                throw new TaskProcessingLockBusyError(id, 'download');
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
            const localPath = path.join(config.downloadDir, path.basename(fileName));
            task.localPath = localPath;

            // Create heartbeat function
            const heartbeat = createHeartbeat(task, this, updateStatus, fileName);

            try {
                const deps = { config, client, CloudTool, updateStatus, runMtprotoFileTaskWithRetry, TaskRepository, queueService, STRINGS, format, streamTransferService, instanceCoordinator };

                // 1. Concurrent processing: Asynchronously initiate UI update without blocking instant transfer check and download preparation
                const initialHeartbeat = heartbeat('downloading', 0, 0)
                    .catch(e => log.warn("Initial heartbeat failed", e));
                
                // 2. Priority check for remote instant transfer
                if (await _handleInstantTransfer(this, deps, task, info, fileName, initialHeartbeat)) return;

                // 2. Local file check
                if (await _handleLocalFile(this, deps, task, info, fileName, localPath, initialHeartbeat)) return;

                const isLargeFile = info.size > 100 * 1024 * 1024;

                // 3. Check if stream forwarding mode is enabled
                if (await _handleStreamForwarding(this, deps, task, info, fileName, isLargeFile)) return;

                // 4. Download phase - MTProto file download
                await _handleMTProtoDownload(this, deps, task, info, fileName, localPath, heartbeat, isLargeFile);


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
            if (didActivate) {
                this.activeProcessors.delete(id);
                this.inFlightTasks.delete(id);
            }
            if (!ownsProcessingLock && lockAcquired) {
                await instanceCoordinator.releaseTaskLock(id);
            }
        }
}


// Helper Functions for Download Phases

async function _handleInstantTransfer(context, deps, task, info, fileName, initialHeartbeat) {
    const { CloudTool, updateStatus, instanceCoordinator } = deps;

    // 2. Priority check for remote instant transfer (using fast check mode: no retry, skip fallback)
    const remoteFile = await CloudTool.getRemoteFileInfo(fileName, task.userId, 1, true);

    if (remoteFile && context._isSizeMatch(remoteFile.Size, info.size)) {
        // Instant transfer hit, ensure UI update completes before showing success
        await initialHeartbeat;

        const actualUploadPath = await CloudTool._getUploadPath(task.userId);
        const fileLink = `tg://openmessage?chat_id=${task.chatId}&message_id=${task.message.id}`;
        await assertClaimFenceCurrent(task, instanceCoordinator);
        await handleTaskCompletion(task, context, updateStatus, fileName, actualUploadPath, fileLink);

        context.activeProcessors.delete(task.id);
        // Instant transfer complete, no need to upload
        return true;
    }
    return false;
}

async function _handleLocalFile(context, deps, task, info, fileName, localPath, initialHeartbeat) {
    const { TaskRepository, updateStatus, format, STRINGS, queueService, instanceCoordinator } = deps;
    const log = dependencyContainer.get('logger').withModule('TaskManager');

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
    if (localFileExists && context._isSizeMatch(localFileSize, info.size)) {
        // Local file is intact, directly trigger upload webhook
        await initialHeartbeat;
        await assertClaimFenceCurrent(task, instanceCoordinator);
        const transition = await TaskRepository.transitionStatus(task.id, TASK_EVENTS.FINISH_DOWNLOAD, null, {
            ...getClaimFenceOptions(task),
            returnResult: true,
            allowNoop: true,
            source: 'local_file_ready'
        });
        if (transition.blocked) return true;
        if (!task.isGroup) {
            await updateStatus(task, format(STRINGS.task.downloaded_waiting_upload, { name: escapeHTML(fileName) }));
        }
        context.activeProcessors.delete(task.id);
        await queueService.enqueueUploadTask(task.id, {
            userId: task.userId,
            chatId: task.chatId,
            msgId: task.msgId,
            localPath: task.localPath,
            _meta: {
                triggerSource: TASK_QUEUE_TRIGGER_SOURCES.LOCAL_FILE_READY,
                queueAttempt: transition.queueAttempt
            }
        });
        log.info("Local file exists, triggered upload webhook", { taskId: task.id });
        return true;
    }
    return false;
}

async function _handleStreamForwarding(context, deps, task, info, fileName, isLargeFile) {
    const { config, instanceCoordinator, TaskRepository, updateStatus, client, streamTransferService } = deps;
    const log = dependencyContainer.get('logger').withModule('TaskManager');
    const { message } = task;

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
        const eligibleWorkers = otherInstances
            .map(instance => ({ instance, url: resolveInstanceBaseUrl(instance) }))
            .filter(worker => worker.url);
        const bestWorker = eligibleWorkers
            .sort((a, b) => (a.instance.activeTaskCount || 0) - (b.instance.activeTaskCount || 0))[0];
        const targetUrl = bestWorker?.url || config.streamForwarding?.lbUrl || null;
        const ownerInstanceId = bestWorker?.instance?.id || null;

        if (targetUrl) {
            try {
                log.info(`🚀 Starting stream forwarding mode: Task ${task.id}, Target: ${targetUrl}`, {
                    workerInstanceId: bestWorker?.instance?.id,
                    viaLoadBalancer: !bestWorker?.url && Boolean(config.streamForwarding?.lbUrl)
                });
                if (!ownerInstanceId) {
                    log.warn(`Stream forwarding requires a direct worker owner; falling back to local download`, {
                        taskId: task.id,
                        targetUrl
                    });
                    return false;
                }
                await updateStatus(task, "🚀 **Uploading via stream forwarding...**");
                await assertClaimFenceCurrent(task, instanceCoordinator);
                const streamStartTransition = await TaskRepository.transitionStatus(task.id, TASK_EVENTS.START_STREAM_UPLOAD, null, {
                    ...getClaimFenceOptions(task),
                    returnResult: true,
                    allowNoop: true,
                    source: 'stream_forwarding_started'
                });
                if (streamStartTransition.blocked) {
                    log.warn(`Stream forwarding start blocked for task ${task.id}: ${streamStartTransition.reason || 'invalid state'}`);
                    return false;
                }
                await streamTransferService.registerStreamOwner(task.id, {
                    instanceId: ownerInstanceId,
                    url: targetUrl,
                    registeredBy: instanceCoordinator.instanceId
                });

                const { tunnelService } = await import("../../services/TunnelService.js");
                const tunnelUrl = await tunnelService.getPublicUrl();
                let leaderUrl = tunnelUrl || config.streamForwarding.externalUrl;
                if (!leaderUrl) {
                    const activeInstances = (await instanceCoordinator.getActiveInstances?.()) || [];
                    const self = activeInstances.find(inst => inst.id === instanceCoordinator.instanceId);
                    leaderUrl = self ? resolveInstanceBaseUrl(self) : null;
                }
                if (!leaderUrl) {
                    log.warn(`⚠️ leaderUrl fallback to localhost — workers will not be able to report status back`);
                    leaderUrl = `http://localhost:${config.port}`;
                }

                const chunkSize = isLargeFile ? 512 * 1024 : 128 * 1024;
                let resumeInfo = null;
                try {
                    resumeInfo = await streamTransferService.resumeTask(task.id, {
                        streamMode: 'resumable',
                        fileName,
                        userId: task.userId,
                        totalSize: info.size,
                        chunkSize,
                        leaderUrl,
                        chatId: task.chatId,
                        msgId: task.msgId,
                        sourceMsgId: task.message.id,
                        claimedBy: task.claimedBy,
                        claimLeaseId: task.claimLeaseId,
                        ownerInstanceId
                    }, targetUrl);
                } catch (resumeError) {
                    log.warn(`Stream resume negotiation failed, starting from scratch: ${resumeError.message}`);
                    await streamTransferService.resetTask(task.id, targetUrl, { ownerInstanceId }).catch(error => {
                        log.warn(`Stream worker reset failed before fallback non-resumable transfer: ${error.message}`);
                    });
                }

                if (resumeInfo?.success === false) {
                    log.warn(`Stream worker resume returned failure, resetting worker before retrying from scratch: ${resumeInfo.error || 'unknown error'}`);
                    await streamTransferService.resetTask(task.id, targetUrl, { ownerInstanceId });
                    resumeInfo = null;
                }

                if (resumeInfo?.finalizing || resumeInfo?.complete) {
                    const finalization = await streamTransferService.waitForFinalization(task.id, { targetUrl });
                    if (finalization?.success && finalization.completed) {
                        log.info(`✅ Stream finalization completed from existing staging: Task ${task.id}`);
                        context.activeProcessors.delete(task.id);
                        return true;
                    }
                    throw new Error(finalization?.error || 'Stream finalization failed');
                }

                const resumeOffset = Number(resumeInfo?.uploadedBytes || 0);
                const startOffset = Number.isFinite(resumeOffset) && resumeOffset > 0 ? resumeOffset : 0;
                let chunkIndex = startOffset > 0
                    ? Math.floor(startOffset / chunkSize)
                    : 0;

                // Create download iterator
                const downloadOptions = {
                    file: message.media,
                    requestSize: chunkSize,
                    chunkSize,
                    stride: chunkSize
                };

                if (startOffset > 0) {
                    downloadOptions.offset = bigInt(startOffset);
                    downloadOptions.fileSize = bigInt(info.size);
                    const remaining = Math.max(0, info.size - startOffset);
                    if (remaining === 0) {
                        log.info(`Stream resume found complete staging file for task ${task.id}, waiting for worker finalization`);
                        const finalization = await streamTransferService.waitForFinalization(task.id, { targetUrl });
                        if (finalization?.success && finalization.completed) {
                            context.activeProcessors.delete(task.id);
                            return true;
                        }
                        throw new Error(finalization?.error || 'Stream finalization failed');
                    }
                    downloadOptions.limit = Math.ceil(remaining / chunkSize);
                    await updateStatus(task, `🔄 **Resuming transfer... (${(startOffset / 1024 / 1024).toFixed(2)}MB)**`);
                }

                const downloadIterator = client.iterDownload(downloadOptions);

                const { UIHelper } = dependencyContainer.getAll();

                // Continue transferring remaining chunks
                for await (const chunk of downloadIterator) {
                    if (context.cancelledTaskIds.has(task.id)) throw new Error("CANCELLED");
                    const downloaded = Math.min(info.size, startOffset + ((chunkIndex - Math.floor(startOffset / chunkSize)) * chunkSize) + chunk.length);
                    const isLast = downloaded >= info.size;

                    await streamTransferService.forwardChunk(task.id, chunk, {
                        fileName, userId: task.userId, chunkIndex, isLast,
                        totalSize: info.size, leaderUrl, chatId: task.chatId, msgId: task.msgId,
                        sourceMsgId: task.message.id, targetUrl,
                        resumeEnabled: true,
                        streamMode: 'resumable',
                        chunkSize,
                        claimedBy: task.claimedBy,
                        claimLeaseId: task.claimLeaseId,
                        ownerInstanceId
                    });

                    if (chunkIndex % 20 === 0 || isLast) {
                        const statusText = startOffset > 0 ? "🔄 Resuming transfer..." : "📥 Forwarding stream...";
                        await updateStatus(task, UIHelper.renderProgress(downloaded, info.size, statusText, fileName));
                    }
                    chunkIndex++;
                }
                const finalization = await streamTransferService.waitForFinalization(task.id, { targetUrl });
                if (!finalization?.success || !finalization.completed) {
                    throw new Error(finalization?.error || 'Stream finalization failed');
                }
                log.info(`✅ Stream forwarding completed: Task ${task.id}`);
                await streamTransferService.clearStreamOwner(task.id).catch(clearError => {
                    log.warn(`Failed to clear stream owner after completion: ${clearError.message}`);
                });
                context.activeProcessors.delete(task.id);
                return true;
            } catch (e) {
                if (e.message === "CANCELLED") throw e;
                await streamTransferService.resetTask(task.id, targetUrl, { ownerInstanceId }).catch(resetError => {
                    log.warn(`Stream worker reset failed after transfer error: ${resetError.message}`);
                });
                await streamTransferService.clearStreamOwner(task.id).catch(clearError => {
                    log.warn(`Failed to clear stream owner after transfer error: ${clearError.message}`);
                });
                const fallbackTransition = await TaskRepository.transitionStatus(task.id, TASK_EVENTS.RESET_STREAM_DOWNLOAD, null, {
                    ...getClaimFenceOptions(task),
                    returnResult: true,
                    allowNoop: true,
                    source: 'stream_forwarding_fallback'
                }).catch(resetStateError => {
                    log.warn(`Failed to reset task state for stream fallback: ${resetStateError.message}`);
                    return { blocked: true, reason: resetStateError.message };
                });
                if (fallbackTransition.blocked) {
                    throw new Error(`Stream fallback rejected: ${fallbackTransition.reason || 'state transition blocked'}`);
                }
                log.error(`❌ Stream forwarding failed, falling back to local download mode: ${e.message}`);
            }
        } else {
            log.warn(`⚠️ Stream transfer disabled for task ${task.id}: no direct worker URL available`, {
                otherInstances: otherInstances.map(inst => ({ id: inst.id, url: inst.url, tunnelUrl: inst.tunnelUrl, directUrl: inst.directUrl }))
            });
        }
    }
    return false;
}

async function _handleMTProtoDownload(context, deps, task, info, fileName, localPath, heartbeat, isLargeFile) {
    const { client, runMtprotoFileTaskWithRetry, TaskRepository, updateStatus, STRINGS, format, queueService } = deps;
    const log = dependencyContainer.get('logger').withModule('TaskManager');
    const { message } = task;

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
    await assertClaimFenceCurrent(task, deps.instanceCoordinator);
    const transition = await TaskRepository.transitionStatus(task.id, TASK_EVENTS.FINISH_DOWNLOAD, null, {
        ...getClaimFenceOptions(task),
        returnResult: true,
        allowNoop: true,
        source: 'download_complete'
    });
    if (transition.blocked) return true;
    if (!task.isGroup) {
        await updateStatus(task, format(STRINGS.task.downloaded_waiting_upload, { name: escapeHTML(fileName) }));
    }

    // Trigger upload webhook
    context.activeProcessors.delete(task.id);
    await queueService.enqueueUploadTask(task.id, {
        userId: task.userId,
        chatId: task.chatId,
        msgId: task.msgId,
        localPath: task.localPath,
        _meta: {
            triggerSource: TASK_QUEUE_TRIGGER_SOURCES.DOWNLOAD_COMPLETE,
            queueAttempt: transition.queueAttempt
        }
    });
    log.info("Download complete, triggered upload webhook", { taskId: task.id });
    return true;
}
