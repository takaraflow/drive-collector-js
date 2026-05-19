import fs from "fs";
import path from "path";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { dependencyContainer } from "../../services/DependencyContainer.js";
import { TASK_EVENTS } from "../../domain/task-state-machine.js";
import { TASK_QUEUE_TRIGGER_SOURCES, TaskProcessingLockBusyError } from "../../domain/task-queue-contract.js";
import {
    buildExternalLocalFileName,
    buildRetainedExternalUrlSourceRef,
    openExternalUrlStream,
    urlFingerprint
} from "../ExternalUrlPolicy.js";
import { assertLocalStorageCapacity } from "../../utils/storageGuard.js";
import { createHeartbeat, handleTaskFailure, escapeHTML } from "./TaskManager.utils.js";
import { assertClaimFenceCurrent, getClaimFenceOptions } from "./claim-fence.js";
import { isRetryableInfrastructureError } from "../../domain/infrastructure-error.js";

const getLog = () => dependencyContainer.get("logger").withModule("TaskManager.external-download");
const EXTERNAL_URL_USER_FAILURE_MESSAGE = "外部链接下载失败，请确认链接仍可公开访问且文件大小未超过限制。";

export async function downloadExternalUrlTask(task) {
    const {
        config,
        updateStatus,
        TaskRepository,
        queueService,
        STRINGS,
        format,
        instanceCoordinator
    } = dependencyContainer.getAll();
    const log = getLog();

    const ownsProcessingLock = task.processingLockHeld === true;
    let lockAcquired = ownsProcessingLock;
    if (!ownsProcessingLock) {
        lockAcquired = await instanceCoordinator.acquireTaskLock(task.id);
        if (!lockAcquired) {
            log.info("Task lock exists, skipping external URL download", { taskId: task.id });
            throw new TaskProcessingLockBusyError(task.id, "download");
        }
    }

    let didActivate = false;
    let localPath = null;
    let partialPath = null;
    let downloadFinished = false;

    try {
        if (this.activeProcessors.has(task.id)) {
            log.warn("Task already processing, skipping external URL download", { taskId: task.id });
            throw new TaskProcessingLockBusyError(task.id, "download");
        }
        this.activeProcessors.add(task.id);
        this.inFlightTasks.set(task.id, task);
        didActivate = true;

        const sourceRef = task.sourceRef || {};
        if (!sourceRef.url) throw new Error("External URL source missing");

        this.waitingTasks = this.waitingTasks.filter(t => t.id !== task.id);
        this.updateQueueUI();

        const configured = config.externalDownload || {};
        const fileName = task.fileName || sourceRef.fileName || "download.bin";
        const localFileName = buildExternalLocalFileName(task.id, fileName);
        localPath = path.join(config.downloadDir, localFileName);
        partialPath = `${localPath}.part`;
        task.localPath = localPath;
        task.fileInfo = task.fileInfo || { name: fileName, size: Number(sourceRef.fileSize) || 0 };
        const retainedSourceRef = buildRetainedExternalUrlSourceRef({
            ...sourceRef,
            fileName,
            fileSize: task.fileInfo.size
        });

        await fs.promises.mkdir(config.downloadDir, { recursive: true });
        await fs.promises.rm(partialPath, { force: true });

        const heartbeat = createHeartbeat(task, this, updateStatus, fileName);
        await heartbeat("downloading", 0, task.fileInfo.size || 0);

        const transportOptions = task.externalUrlTransportOptions || {};
        const { response, contentLength } = await openExternalUrlStream(sourceRef.url, {
            timeoutMs: configured.timeoutMs,
            maxRedirects: configured.maxRedirects,
            maxBytes: configured.maxBytes,
            lookupImpl: transportOptions.lookupImpl,
            requestImpl: transportOptions.requestImpl
        });

        const total = contentLength || task.fileInfo.size || 0;
        await assertLocalStorageCapacity({
            dirPath: config.downloadDir,
            expectedBytes: total || configured.maxBytes || 0,
            config,
            purpose: `external URL download ${fileName}`
        });

        let downloaded = 0;
        let lastUpdate = Date.now();
        const sourceStream = Readable.fromWeb(response.body);
        const progressStream = new Transform({
            transform(chunk, _encoding, callback) {
                downloaded += chunk.length;
                if (configured.maxBytes && downloaded > configured.maxBytes) {
                    callback(new Error("External file is larger than the configured limit"));
                    return;
                }
                const now = Date.now();
                if (now - lastUpdate > 3000 || (total > 0 && downloaded >= total)) {
                    lastUpdate = now;
                    void heartbeat("downloading", downloaded, total || downloaded).catch(error => {
                        if (error?.message === "CANCELLED") {
                            this.destroy(error);
                            return;
                        }
                        log.warn("External download heartbeat failed", { taskId: task.id, error: error?.message || String(error) });
                    });
                }
                callback(null, chunk);
            }
        });

        await pipeline(sourceStream, progressStream, fs.createWriteStream(partialPath, { flags: "wx" }));
        await fs.promises.rename(partialPath, localPath);

        const localSize = (await fs.promises.stat(localPath)).size;
        task.fileInfo = { name: fileName, size: localSize };
        await TaskRepository.updateFileMetadata?.(task.id, {
            fileName,
            fileSize: localSize
        });
        await TaskRepository.updateSourceRef?.(task.id, {
            ...retainedSourceRef,
            fileSize: localSize
        });

        await assertClaimFenceCurrent(task, instanceCoordinator);
        const transition = await TaskRepository.transitionStatus(task.id, TASK_EVENTS.FINISH_DOWNLOAD, null, {
            ...getClaimFenceOptions(task),
            returnResult: true,
            allowNoop: true,
            source: "external_url_download_complete"
        });
        if (transition.blocked) return true;
        downloadFinished = true;

        if (!task.isGroup) {
            await updateStatus(task, format(STRINGS.task.downloaded_waiting_upload, { name: escapeHTML(fileName) }));
        }

        this.activeProcessors.delete(task.id);
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
        log.info("External URL download complete, triggered upload webhook", {
            taskId: task.id,
            source: urlFingerprint(sourceRef.url),
            bytes: localSize
        });
        return true;
    } catch (error) {
        const isCancel = error.message === "CANCELLED";
        if (partialPath) {
            await fs.promises.rm(partialPath, { force: true }).catch(() => {});
        }
        if (downloadFinished && isRetryableInfrastructureError(error)) {
            log.warn("External URL task hit retryable infrastructure error; leaving state for webhook/recovery retry", {
                taskId: task.id,
                error: error.message
            });
            throw error;
        }
        const sourceRef = task.sourceRef || {};
        log.warn("External URL download failed", {
            taskId: task.id,
            code: error?.code,
            source: sourceRef.url ? urlFingerprint(sourceRef.url) : "unknown",
            errorType: error?.name || "Error"
        });
        await TaskRepository.updateSourceRef?.(task.id, buildRetainedExternalUrlSourceRef({
            ...sourceRef,
            fileName: task.fileInfo?.name || task.fileName,
            fileSize: task.fileInfo?.size || 0
        })).catch(updateError => {
            log.warn("Failed to retain redacted external URL source ref", { taskId: task.id, error: updateError?.message });
        });
        await handleTaskFailure(task, this, updateStatus, isCancel ? error.message : EXTERNAL_URL_USER_FAILURE_MESSAGE, isCancel);
    } finally {
        if (didActivate) {
            this.activeProcessors.delete(task.id);
            this.inFlightTasks.delete(task.id);
        }
        if (!ownsProcessingLock && lockAcquired) {
            await instanceCoordinator.releaseTaskLock(task.id);
        }
    }
}
