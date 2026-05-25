import { getConfig } from "../config/index.js";
import { logger } from "./logger/index.js";
import { CloudTool } from "./rclone.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import { escapeHTML } from "../utils/common.js";
import { TaskRepository } from "../repositories/TaskRepository.js";
import { TelegramBotApi } from "../utils/telegramBotApi.js";
import { cache } from "./CacheService.js";
import { resolveInstanceBaseUrl } from "../utils/instanceUrl.js";
import { assertLocalStorageCapacity } from "../utils/storageGuard.js";
import { TASK_EVENTS, TASK_STATUSES } from "../domain/task-state-machine.js";
import { CACHE_KEYS } from "../domain/cache-keys.js";
import { getClaimFenceOptions } from "../processor/TaskManager/claim-fence.js";
import { redactSensitiveText } from "../utils/serializer.js";
import { resolveRcloneFailureMetadata } from "../utils/rcloneErrorMessage.js";
import { once } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "node:crypto";

const log = logger.withModule('StreamTransferService');
const getStreamConfig = () => getConfig().streamForwarding;
const DEFAULT_STREAM_CHUNK_SIZE = 512 * 1024;
const DEFAULT_FINALIZATION_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_FINALIZATION_POLL_MS = 3000;
const DEFAULT_STREAM_OWNER_TTL_SECONDS = 6 * 60 * 60;

function hasValidInstanceSecret(headerSecret, configuredSecret) {
    if (typeof headerSecret !== 'string' || typeof configuredSecret !== 'string') {
        return false;
    }

    const header = headerSecret.trim();
    const secret = configuredSecret.trim();
    return header !== '' && secret !== '' && header === secret;
}

function sanitizeTaskPathSegment(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9_.-]/g, '_')
        .slice(0, 160) || 'unknown-task';
}

/**
 * 实时流式转发服务 (StreamTransferService)
 * 负责在多实例环境下，由 Leader 转发 Telegram 下载流给 Worker 实例进行上传
 */
class StreamTransferService {
    constructor() {
        this.activeStreams = new Map(); // Worker 端：taskId -> { stdin, proc, lastSeen, fileName, userId, totalBytes, chatId, msgId }
        this.cleanupInterval = setInterval(() => this.cleanupStaleStreams(), 60000);
        // 断点续传相关
        this.chunkRetryAttempts = new Map(); // taskId -> { chunkIndex: attempts }
        this.taskLocks = new Map();
        this.maxRetryAttempts = 3;
        this.progressCacheTTL = 3600; // 1小时
    }

    async _withTaskLock(taskId, operation) {
        const previous = this.taskLocks.get(taskId) || Promise.resolve();
        let release;
        const gate = new Promise(resolve => {
            release = resolve;
        });
        const tail = previous.catch(() => {}).then(() => gate);
        this.taskLocks.set(taskId, tail);

        await previous.catch(() => {});
        try {
            return await operation();
        } finally {
            release();
            if (this.taskLocks.get(taskId) === tail) {
                this.taskLocks.delete(taskId);
            }
        }
    }

    async _markStreamUploadStarted(taskId, source, claimContext = {}) {
        const transition = await TaskRepository.transitionStatus(taskId, TASK_EVENTS.START_STREAM_UPLOAD, null, {
            ...getClaimFenceOptions(claimContext),
            returnResult: true,
            allowNoop: true,
            source
        });

        if (transition.blocked) {
            throw new Error(`Stream upload rejected: ${transition.reason || `invalid transition from ${transition.fromStatus || transition.latestStatus || 'unknown'}`}`);
        }

        return transition;
    }

    async _writeWithBackpressure(streamContext, chunk) {
        if (!streamContext.stdin?.writable || streamContext.stdin.destroyed) {
            throw new Error("rcat stdin is not writable");
        }

        const canContinue = streamContext.stdin.write(chunk);
        if (!canContinue) {
            await Promise.race([
                once(streamContext.stdin, "drain"),
                once(streamContext.stdin, "error").then(([error]) => {
                    throw error;
                })
            ]);
        }
    }

    _getResumeDir() {
        const cfg = getConfig();
        return path.resolve(
            cfg.streamForwarding?.resumeDir ||
            path.join(cfg.downloadDir || os.tmpdir(), ".stream-resume")
        );
    }

    _getResumablePaths(taskId, fileName) {
        const remoteFileName = CloudTool.sanitizeRemoteFileName(fileName);
        const taskSegment = sanitizeTaskPathSegment(taskId);
        const partFileName = `${taskSegment}.${remoteFileName}.part`;
        return {
            resumeDir: this._getResumeDir(),
            localPath: path.join(this._getResumeDir(), partFileName),
            fileName: remoteFileName
        };
    }

    async _writeFileWithBackpressure(writeStream, chunk) {
        if (!writeStream?.writable || writeStream.destroyed) {
            throw new Error("staging file stream is not writable");
        }

        await new Promise((resolve, reject) => {
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const cleanup = () => {
                writeStream.off?.("error", onError);
            };

            writeStream.once("error", onError);
            writeStream.write(chunk, (error) => {
                cleanup();
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }

    async _closeWriteStream(writeStream) {
        if (!writeStream || writeStream.destroyed || writeStream.closed) return;
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                cleanup();
                reject(error);
            };
            const onFinish = () => {
                cleanup();
                resolve();
            };
            const cleanup = () => {
                writeStream.off?.("error", onError);
                writeStream.off?.("finish", onFinish);
            };

            writeStream.once("error", onError);
            writeStream.once("finish", onFinish);
            writeStream.end();
        });
    }

    _normalizeResumableProgress(fileSize, totalSize, chunkSize) {
        const expectedTotal = Number(totalSize || 0);
        const safeChunkSize = Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : DEFAULT_STREAM_CHUNK_SIZE;
        let uploadedBytes = Math.max(0, Number(fileSize || 0));

        if (expectedTotal > 0 && uploadedBytes > expectedTotal) {
            uploadedBytes = expectedTotal;
        }

        const isComplete = expectedTotal > 0 && uploadedBytes === expectedTotal;
        if (!isComplete && uploadedBytes > 0) {
            uploadedBytes = Math.floor(uploadedBytes / safeChunkSize) * safeChunkSize;
        }

        const lastChunkIndex = uploadedBytes <= 0
            ? -1
            : (isComplete ? Math.ceil(uploadedBytes / safeChunkSize) - 1 : Math.floor(uploadedBytes / safeChunkSize) - 1);

        return { uploadedBytes, lastChunkIndex, chunkSize: safeChunkSize };
    }

    _isResumableDataComplete(contextOrProgress) {
        const totalSize = Number(contextOrProgress?.totalSize || 0);
        const uploadedBytes = Number(contextOrProgress?.uploadedBytes || 0);
        return totalSize > 0 && uploadedBytes === totalSize;
    }

    _buildResumableContext(taskId, metadata, progress, writeStream = null) {
        const isComplete = this._isResumableDataComplete(progress);
        return {
            mode: 'resumable',
            phase: isComplete ? 'received' : 'receiving',
            finalizeState: null,
            finalizePromise: null,
            finalizeToken: null,
            abortController: null,
            cancelled: false,
            writeStream,
            localPath: progress.localPath,
            resumeDir: progress.resumeDir,
            fileName: progress.fileName,
            originalFileName: metadata.fileName,
            userId: metadata.userId,
            totalSize: progress.totalSize,
            chunkSize: progress.chunkSize,
            leaderUrl: metadata.leaderUrl,
            chatId: metadata.chatId,
            msgId: metadata.msgId,
            sourceMsgId: metadata.sourceMsgId,
            claimedBy: metadata.claimedBy,
            claimLeaseId: metadata.claimLeaseId,
            uploadedBytes: progress.uploadedBytes,
            status: TASK_STATUSES.UPLOADING,
            lastChunkIndex: progress.lastChunkIndex,
            lastSeen: Date.now(),
            errorReported: false
        };
    }

    _validateResumableMetadata(context, metadata) {
        const expected = {
            fileName: context.fileName,
            userId: context.userId,
            totalSize: Number(context.totalSize || 0),
            chunkSize: Number(context.chunkSize || DEFAULT_STREAM_CHUNK_SIZE)
        };
        const actual = {
            fileName: CloudTool.sanitizeRemoteFileName(metadata.fileName),
            userId: metadata.userId,
            totalSize: Number(metadata.totalSize || 0),
            chunkSize: Number(metadata.chunkSize || DEFAULT_STREAM_CHUNK_SIZE)
        };

        if (expected.fileName !== actual.fileName) {
            return `Resumable metadata mismatch: fileName expected ${expected.fileName}, got ${actual.fileName}`;
        }
        if (expected.userId !== actual.userId) {
            return "Resumable metadata mismatch: userId changed";
        }
        if (expected.totalSize !== actual.totalSize) {
            return `Resumable metadata mismatch: totalSize expected ${expected.totalSize}, got ${actual.totalSize}`;
        }
        if (expected.chunkSize !== actual.chunkSize) {
            return `Resumable metadata mismatch: chunkSize expected ${expected.chunkSize}, got ${actual.chunkSize}`;
        }

        return null;
    }

    async _getResumableProgress(taskId, metadata) {
        const paths = this._getResumablePaths(taskId, metadata.fileName);

        let fileSize = 0;
        try {
            const stat = await fs.promises.stat(paths.localPath);
            fileSize = stat.size;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }

        const totalSize = Number(metadata.totalSize || 0);
        const remainingBytes = Math.max(0, totalSize - fileSize);
        await assertLocalStorageCapacity({
            dirPath: paths.resumeDir,
            expectedBytes: remainingBytes,
            config: getConfig(),
            purpose: `resumable stream staging ${metadata.fileName}`
        });

        const progress = this._normalizeResumableProgress(fileSize, metadata.totalSize, metadata.chunkSize);
        if (progress.uploadedBytes !== fileSize) {
            await fs.promises.truncate(paths.localPath, progress.uploadedBytes);
        }

        return {
            ...paths,
            ...progress,
            isCached: progress.uploadedBytes > 0,
            isActive: false,
            totalSize: Number(metadata.totalSize || 0)
        };
    }

    async _saveFinalizationStatus(taskId, status) {
        try {
            await cache.set(CACHE_KEYS.streamFinalization(taskId), {
                taskId,
                ...status,
                timestamp: Date.now()
            }, this.progressCacheTTL);
        } catch (error) {
            log.warn(`Failed to save finalization status for ${taskId}:`, error.message);
        }
    }

    async _loadFinalizationStatus(taskId) {
        try {
            return await cache.get(CACHE_KEYS.streamFinalization(taskId));
        } catch (error) {
            log.warn(`Failed to load finalization status for ${taskId}:`, error.message);
            return null;
        }
    }

    async _clearFinalizationStatus(taskId) {
        try {
            await cache.delete(CACHE_KEYS.streamFinalization(taskId));
        } catch (error) {
            log.warn(`Failed to clear finalization status for ${taskId}:`, error.message);
        }
    }

    _finalizationResultFromStatus(status) {
        if (!status) return null;
        if (status.status === 'completed') {
            return { success: true, completed: true, status: status.status };
        }
        if (status.status === 'failed' || status.status === 'cancelled') {
            return {
                success: false,
                completed: false,
                status: status.status,
                error: status.error || `Finalization ${status.status}`
            };
        }
        return null;
    }

    async _delay(ms) {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    async _waitForLocalFinalization(taskId, options = {}) {
        const timeoutMs = options.timeoutMs || getConfig().streamForwarding?.finalizationTimeoutMs || DEFAULT_FINALIZATION_TIMEOUT_MS;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() <= deadline) {
            const context = this.activeStreams.get(taskId);
            if (context?.finalizePromise) {
                return await context.finalizePromise;
            }

            const statusResult = this._finalizationResultFromStatus(await this._loadFinalizationStatus(taskId));
            if (statusResult) {
                return statusResult;
            }

            await this._delay(options.pollMs || DEFAULT_FINALIZATION_POLL_MS);
        }

        return { success: false, completed: false, status: 'timeout', error: 'Stream finalization timed out' };
    }

    async _waitForRemoteFinalization(targetUrl, taskId, options = {}) {
        const timeoutMs = options.timeoutMs || getConfig().streamForwarding?.finalizationTimeoutMs || DEFAULT_FINALIZATION_TIMEOUT_MS;
        const pollMs = options.pollMs || getConfig().streamForwarding?.finalizationPollMs || DEFAULT_FINALIZATION_POLL_MS;
        const deadline = Date.now() + timeoutMs;
        const url = `${targetUrl.replace(/\/$/, '')}/api/v2/stream/${taskId}/full-progress`;

        while (Date.now() <= deadline) {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'x-instance-secret': getStreamConfig().secret
                },
                signal: AbortSignal.timeout(Math.min(30000, pollMs + 5000))
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => '');
                throw new Error(`Worker finalization status failed with ${response.status}: ${errorText}`);
            }

            const progress = await response.json();
            const statusResult = this._finalizationResultFromStatus(progress.finalization);
            if (statusResult) {
                return statusResult;
            }

            await this._delay(pollMs);
        }

        return { success: false, completed: false, status: 'timeout', error: 'Stream finalization timed out' };
    }

    async waitForFinalization(taskId, options = {}) {
        if (options.targetUrl) {
            return await this._waitForRemoteFinalization(options.targetUrl, taskId, options);
        }
        return await this._waitForLocalFinalization(taskId, options);
    }

    /**
     * Sender (Leader): 转发一个 chunk 到 LB/Worker (支持断点续传)
     */
    async forwardChunk(taskId, chunk, metadata) {
        const { fileName, userId, isLast, chunkIndex, totalSize, leaderUrl, chatId, msgId, sourceMsgId, targetUrl } = metadata;
        const lbUrl = getStreamConfig().lbUrl;
        const workerUrl = targetUrl || lbUrl;

        if (!workerUrl) {
            throw new Error("No target URL available (neither targetUrl nor STREAM_LB_URL configured)");
        }
        if (!metadata.ownerInstanceId) {
            throw new Error(`Stream owner instance is required for task ${taskId}`);
        }

        // 检查重试次数
        const retryKey = `${taskId}:${chunkIndex}`;
        const currentAttempts = this.chunkRetryAttempts.get(retryKey) || 0;
        if (currentAttempts >= this.maxRetryAttempts) {
            log.error(`Max retry attempts reached for chunk ${chunkIndex}, skipping.`);
            return false;
        }

        const url = `${workerUrl.replace(/\/$/, '')}/api/v2/stream/${taskId}`;
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'x-instance-secret': getStreamConfig().secret,
                    'x-file-name': encodeURIComponent(fileName),
                    'x-user-id': userId,
                    'x-is-last': isLast ? 'true' : 'false',
                    'x-chunk-index': chunkIndex.toString(),
                    'x-total-size': (totalSize || 0).toString(),
                    'x-leader-url': leaderUrl || '',
                    'x-source-instance-id': instanceCoordinator.instanceId,
                    'x-chat-id': chatId || '',
                    'x-msg-id': msgId || '',
                    'x-source-msg-id': sourceMsgId || '',
                    'x-resume-enabled': metadata.resumeEnabled ? 'true' : 'false',
                    'x-stream-mode': metadata.streamMode || 'live',
                    'x-chunk-size': String(metadata.chunkSize || DEFAULT_STREAM_CHUNK_SIZE),
                    'x-task-claimed-by': metadata.claimedBy || '',
                    'x-task-claim-lease-id': metadata.claimLeaseId || '',
                    'x-stream-owner-instance-id': metadata.ownerInstanceId || ''
                },
                body: chunk,
                signal: AbortSignal.timeout(30000)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Worker responded with ${response.status}: ${errorText}`);
            }

            // 成功后清除重试计数
            this.chunkRetryAttempts.delete(retryKey);
            return true;
        } catch (error) {
            // 记录重试次数
            this.chunkRetryAttempts.set(retryKey, currentAttempts + 1);

            log.error(`Failed to forward chunk ${chunkIndex} for task ${taskId} (attempt ${currentAttempts + 1}/${this.maxRetryAttempts}):`, error);
            throw error;
        }
    }

    /**
     * Sender (Leader): 查询 Worker 端当前的接收进度
     */
    async getRemoteProgress(lbUrl, taskId) {
        const url = `${lbUrl.replace(/\/$/, '')}/api/v2/stream/${taskId}/progress`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'x-instance-secret': getStreamConfig().secret
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            return data.lastChunkIndex;
        }
        throw new Error(`Worker returned ${response.status}`);
    }

    /**
     * Receiver (Worker): 获取任务进度
     */
    getTaskProgress(taskId) {
        const context = this.activeStreams.get(taskId);
        return context ? (context.lastChunkIndex ?? -1) : -1;
    }

    _formatProgressSnapshot(context, finalization = null) {
        const snapshot = {
            isActive: Boolean(context),
            lastChunkIndex: context?.lastChunkIndex ?? -1,
            uploadedBytes: context?.uploadedBytes ?? 0,
            totalSize: context?.totalSize ?? 0,
            status: context?.status,
            mode: context?.mode,
            phase: context?.phase
        };

        if (finalization || context?.finalizeState) {
            snapshot.finalization = finalization || context.finalizeState;
        }

        return snapshot;
    }

    /**
     * Receiver (Worker): 处理接收到的 chunk (支持断点续传)
     */
    async handleIncomingChunk(taskId, req) {
        // 校验秘钥
        if (!hasValidInstanceSecret(req.headers['x-instance-secret'], getStreamConfig().secret)) {
            return { success: false, statusCode: 401, message: "Unauthorized" };
        }

        const metadata = this._extractChunkMetadata(req.headers);
        return await this._withTaskLock(taskId, async () => {
            const ownerCheck = await this._validateLocalStreamOwner(taskId, metadata.ownerInstanceId);
            if (!ownerCheck.success) {
                for await (const _ of req) {}
                return ownerCheck;
            }

            metadata.leaderUrl = await this._resolveLeaderUrl(metadata.leaderUrl, metadata.sourceInstanceId);

            if (metadata.streamMode === 'resumable') {
                return await this._handleIncomingResumableChunk(taskId, req, metadata);
            }

            let streamContext = this.activeStreams.get(taskId);

            try {
                if (!Number.isInteger(metadata.chunkIndex) || metadata.chunkIndex < 0) {
                    for await (const _ of req) {}
                    return {
                        success: false,
                        statusCode: 400,
                        message: "Invalid chunk index"
                    };
                }

                if (!streamContext && metadata.chunkIndex !== 0) {
                    log.warn(`⚠️ 首个 Chunk 顺序错误: 期望 0, 收到 ${metadata.chunkIndex}`);
                    for await (const _ of req) {}
                    return {
                        success: false,
                        statusCode: 409,
                        message: `Unexpected chunk index: expected 0, got ${metadata.chunkIndex}`
                    };
                }

                if (!streamContext) {
                    streamContext = await this._initializeStreamContext(taskId, metadata);
                }

                // 断点续传幂等性检查：如果当前 chunkIndex 已经处理过，直接返回成功
                if (metadata.chunkIndex <= streamContext.lastChunkIndex) {
                    log.info(`⚠️ 忽略重复的 Chunk ${metadata.chunkIndex} (已处理到: ${streamContext.lastChunkIndex})`);
                    // 必须消费掉请求流，否则可能导致发送端挂起或连接泄漏
                    for await (const _ of req) {}
                    return { success: true, statusCode: 200, message: "Duplicate chunk ignored" };
                }

                const expectedChunkIndex = streamContext.lastChunkIndex + 1;
                if (metadata.chunkIndex !== expectedChunkIndex) {
                    log.warn(`⚠️ Chunk 顺序错误: 期望 ${expectedChunkIndex}, 收到 ${metadata.chunkIndex}`);
                    for await (const _ of req) {}
                    return {
                        success: false,
                        statusCode: 409,
                        message: `Unexpected chunk index: expected ${expectedChunkIndex}, got ${metadata.chunkIndex}`
                    };
                }

                // 获取 Body 数据 (Node.js req is a Readable Stream)
                for await (const chunk of req) {
                    await this._writeWithBackpressure(streamContext, chunk);
                    streamContext.uploadedBytes += chunk.length;
                }
                streamContext.lastSeen = Date.now();
                streamContext.lastChunkIndex = metadata.chunkIndex;

                await this._handlePeriodicTasks(taskId, streamContext, metadata.chunkIndex, metadata.isLast);

                if (metadata.isLast) {
                    log.info(`🏁 任务数据接收完成: ${taskId}`);
                    try { streamContext.stdin.end(); } catch {}
                }

                return { success: true, statusCode: 200 };
            } catch (error) {
                log.error(`Error handling incoming chunk for ${taskId}:`, error);
                if (streamContext) {
                    try { streamContext.stdin.end(); } catch {}
                    this.activeStreams.delete(taskId);
                    await this._deletePartialRemoteFile(streamContext);
                }
                return { success: false, statusCode: 500, message: error.message };
            }
        });
    }


    _extractChunkMetadata(headers) {
        return {
            fileName: decodeURIComponent(headers['x-file-name']),
            userId: headers['x-user-id'],
            isLast: headers['x-is-last'] === 'true',
            chunkIndex: parseInt(headers['x-chunk-index']),
            totalSize: parseInt(headers['x-total-size']),
            leaderUrl: headers['x-leader-url'],
            sourceInstanceId: headers['x-source-instance-id'],
            chatId: headers['x-chat-id'],
            msgId: headers['x-msg-id'],
            sourceMsgId: headers['x-source-msg-id'],
            isResumeEnabled: headers['x-resume-enabled'] === 'true',
            streamMode: headers['x-stream-mode'] || 'live',
            chunkSize: parseInt(headers['x-chunk-size']) || DEFAULT_STREAM_CHUNK_SIZE,
            claimedBy: headers['x-task-claimed-by'] || null,
            claimLeaseId: headers['x-task-claim-lease-id'] || null,
            ownerInstanceId: headers['x-stream-owner-instance-id'] || null
        };
    }

    async registerStreamOwner(taskId, owner) {
        if (!owner?.instanceId) {
            throw new Error(`Stream owner is required for task ${taskId}`);
        }

        const ownerRecord = {
            taskId,
            instanceId: owner.instanceId,
            url: owner.url || null,
            registeredBy: owner.registeredBy || instanceCoordinator.instanceId || null,
            registeredAt: Date.now()
        };

        await cache.set(
            CACHE_KEYS.streamOwner(taskId),
            ownerRecord,
            owner.ttlSeconds || DEFAULT_STREAM_OWNER_TTL_SECONDS
        );

        return ownerRecord;
    }

    async getStreamOwner(taskId) {
        return await cache.get(CACHE_KEYS.streamOwner(taskId));
    }

    async clearStreamOwner(taskId) {
        try {
            await cache.delete(CACHE_KEYS.streamOwner(taskId));
        } catch (error) {
            log.warn(`Failed to clear stream owner for ${taskId}:`, error.message);
        }
    }

    async _validateLocalStreamOwner(taskId, requestedOwnerId = null, options = {}) {
        const requireRequestedOwner = options.requireRequestedOwner !== false;
        if (requireRequestedOwner && !requestedOwnerId) {
            return {
                success: false,
                statusCode: 409,
                message: `Stream owner header is required for task ${taskId}`
            };
        }

        const currentInstanceId = instanceCoordinator.instanceId;
        let owner = null;
        try {
            owner = await this.getStreamOwner(taskId);
        } catch (error) {
            log.warn(`Failed to load stream owner for ${taskId}:`, error.message);
            return {
                success: false,
                statusCode: 503,
                message: `Stream owner is unavailable for task ${taskId}`
            };
        }

        if (!owner?.instanceId) {
            return {
                success: false,
                statusCode: 409,
                message: `Stream owner is not registered for task ${taskId}`
            };
        }

        if (requestedOwnerId && owner.instanceId !== requestedOwnerId) {
            return {
                success: false,
                statusCode: 409,
                message: `Stream owner mismatch: expected ${owner.instanceId}, got ${requestedOwnerId}`
            };
        }

        if (!currentInstanceId) {
            return {
                success: false,
                statusCode: 503,
                message: `Current instance id is unavailable for task ${taskId}`
            };
        }

        if (owner.instanceId !== currentInstanceId) {
            return {
                success: false,
                statusCode: 409,
                message: `Wrong stream worker: expected ${owner.instanceId}, got ${currentInstanceId}`
            };
        }

        return { success: true };
    }

    async _resolveLeaderUrl(leaderUrl, sourceInstanceId) {
        if (!leaderUrl && sourceInstanceId) {
            try {
                const instances = await instanceCoordinator.getAllInstances();
                const leader = instances.find(inst => inst.id === sourceInstanceId);
                if (leader) {
                    return resolveInstanceBaseUrl(leader);
                }
            } catch (e) {
                log.warn(`Failed to lookup leader URL from cache: ${e.message}`);
            }
        }
        return leaderUrl;
    }

    async _initializeStreamContext(taskId, metadata) {
        const cachedProgress = await this.loadProgressFromCache(taskId);

        log.info(`📦 接收到新流式任务: ${taskId} (${metadata.fileName})${cachedProgress ? ` (ignored stale live-stream progress ${cachedProgress.lastChunkIndex})` : ''}`);
        await this._markStreamUploadStarted(taskId, 'stream_context_initialized', metadata);
        const { stdin, proc, fileName: remoteFileName } = await CloudTool.createRcatStream(metadata.fileName, metadata.userId);

        const streamContext = {
            stdin,
            proc,
            lastSeen: Date.now(),
            fileName: remoteFileName || CloudTool.sanitizeRemoteFileName(metadata.fileName),
            originalFileName: metadata.fileName,
            userId: metadata.userId,
            totalSize: metadata.totalSize,
            leaderUrl: metadata.leaderUrl,
            chatId: metadata.chatId,
            msgId: metadata.msgId,
            sourceMsgId: metadata.sourceMsgId,
            uploadedBytes: 0,
            status: TASK_STATUSES.UPLOADING,
            lastChunkIndex: -1, // 记录最近处理的 Chunk Index
            stderrLog: '',
            errorReported: false
        };
        streamContext.claimedBy = metadata.claimedBy;
        streamContext.claimLeaseId = metadata.claimLeaseId;
        this.activeStreams.set(taskId, streamContext);

        // 监听 rclone 错误
        proc.stderr.on('data', (data) => {
            const msg = redactSensitiveText(data.toString());
            streamContext.stderrLog += msg;
            if (streamContext.stderrLog.length > 8000) {
                streamContext.stderrLog = streamContext.stderrLog.slice(-8000);
            }
            log.error(`rclone rcat error [${taskId}]:`, msg);
        });

        const handleProcessError = async (error) => {
            if (streamContext.errorReported) return;
            streamContext.errorReported = true;
            log.error(`rclone rcat process error [${taskId}]:`, error);
            this.activeStreams.delete(taskId);
            await this.clearProgressFromCache(taskId);
            await this._deletePartialRemoteFile(streamContext);
            await this.reportError(taskId, streamContext, error.message || String(error));
        };

        proc.on('error', handleProcessError);
        stdin.on?.('error', handleProcessError);

        proc.on('close', async (code) => {
            log.info(`rclone rcat exited with code ${code} for task ${taskId}`);
            this.activeStreams.delete(taskId);
            // 清理缓存
            await this.clearProgressFromCache(taskId);
            if (streamContext.errorReported) return;

            const hasRcloneErrors = /(^|\b)(ERROR|Failed|failed|error)(\b|:)/.test(streamContext.stderrLog || '');
            if (code === 0 && !hasRcloneErrors) {
                await this.finishTask(taskId, streamContext);
            } else {
                streamContext.errorReported = true;
                const errorTail = redactSensitiveText(streamContext.stderrLog?.slice(-500).trim());
                await this._deletePartialRemoteFile(streamContext);
                await this.reportError(taskId, streamContext, errorTail || `rclone exited with code ${code}`);
            }
        });

        return streamContext;
    }

    async _handleIncomingResumableChunk(taskId, req, metadata) {
        let context = this.activeStreams.get(taskId);

        try {
            if (!Number.isInteger(metadata.chunkIndex) || metadata.chunkIndex < 0) {
                for await (const _ of req) {}
                return { success: false, statusCode: 400, message: "Invalid chunk index" };
            }

            if (!context) {
                context = await this._initializeResumableContext(taskId, metadata);
            } else {
                const metadataError = this._validateResumableMetadata(context, metadata);
                if (metadataError) {
                    for await (const _ of req) {}
                    return { success: false, statusCode: 409, message: metadataError };
                }
            }

            if (metadata.chunkIndex <= context.lastChunkIndex) {
                for await (const _ of req) {}
                return { success: true, statusCode: 200, message: "Duplicate chunk ignored" };
            }

            const expectedChunkIndex = context.lastChunkIndex + 1;
            if (metadata.chunkIndex !== expectedChunkIndex) {
                for await (const _ of req) {}
                return {
                    success: false,
                    statusCode: 409,
                    message: `Unexpected chunk index: expected ${expectedChunkIndex}, got ${metadata.chunkIndex}`
                };
            }

            for await (const chunk of req) {
                if (context.phase !== 'receiving') {
                    throw new Error(`Cannot accept chunks while stream is ${context.phase}`);
                }
                await this._writeFileWithBackpressure(context.writeStream, chunk);
                context.uploadedBytes += chunk.length;
            }

            context.lastSeen = Date.now();
            context.lastChunkIndex = metadata.chunkIndex;
            await this._handlePeriodicTasks(taskId, context, metadata.chunkIndex, metadata.isLast);

            if (metadata.isLast) {
                await this._closeWriteStream(context.writeStream);
                const expectedSize = Number(context.totalSize || 0);
                const stat = await fs.promises.stat(context.localPath);
                if (expectedSize > 0 && stat.size !== expectedSize) {
                    throw new Error(`Staging validation failed: local(${stat.size}) vs expected(${expectedSize})`);
                }

                this._startResumableFinalization(taskId, context);
            }

            return { success: true, statusCode: 200 };
        } catch (error) {
            log.error(`Error handling resumable chunk for ${taskId}:`, error);
            if (context) {
                await this._closeWriteStream(context.writeStream).catch(() => {});
                this.activeStreams.delete(taskId);
                await this.saveProgressToCache(taskId, context);
                await this.reportError(taskId, context, error);
            }
            return { success: false, statusCode: 500, message: error.message };
        }
    }

    async _initializeResumableContext(taskId, metadata) {
        const progress = await this._getResumableProgress(taskId, metadata);
        await this._markStreamUploadStarted(taskId, 'stream_resumable_context_initialized', metadata);
        const writeStream = this._isResumableDataComplete(progress)
            ? null
            : fs.createWriteStream(progress.localPath, { flags: 'a' });
        const context = this._buildResumableContext(taskId, metadata, progress, writeStream);

        this.activeStreams.set(taskId, context);

        await this.saveProgressToCache(taskId, context);
        if (this._isResumableDataComplete(context)) {
            this._startResumableFinalization(taskId, context);
        }
        return context;
    }

    _startResumableFinalization(taskId, context) {
        if (context.finalizePromise) {
            return context.finalizePromise;
        }

        const token = `${Date.now()}:${crypto.randomUUID().replace(/-/g, '')}`;
        context.phase = 'finalizing';
        context.finalizeToken = token;
        context.finalizeState = {
            status: 'uploading',
            uploadedBytes: context.uploadedBytes,
            totalSize: context.totalSize,
            startedAt: Date.now()
        };
        context.abortController = new AbortController();

        context.finalizePromise = this._completeResumableUpload(taskId, context, token)
            .then(async (result) => {
                context.phase = result.completed ? 'completed' : 'failed';
                context.finalizeState = {
                    status: result.completed ? 'completed' : 'failed',
                    error: result.completed ? null : (result.error || 'Finalization did not complete'),
                    uploadedBytes: context.uploadedBytes,
                    totalSize: context.totalSize,
                    finishedAt: Date.now()
                };
                await this._saveFinalizationStatus(taskId, context.finalizeState);
                return result;
            })
            .catch(async (error) => {
                context.phase = context.cancelled ? 'cancelled' : 'failed';
                context.finalizeState = {
                    status: context.cancelled ? 'cancelled' : 'failed',
                    error: error.message,
                    uploadedBytes: context.uploadedBytes,
                    totalSize: context.totalSize,
                    finishedAt: Date.now()
                };
                await this._saveFinalizationStatus(taskId, context.finalizeState);
                if (!context.cancelled) {
                    await this.saveProgressToCache(taskId, context);
                    await this.reportError(taskId, context, error);
                }
                return { success: false, completed: false, error: error.message };
            });

        void this._saveFinalizationStatus(taskId, context.finalizeState);
        return context.finalizePromise;
    }

    async _completeResumableUpload(taskId, context, token) {
        await this._closeWriteStream(context.writeStream);

        if (context.cancelled || context.finalizeToken !== token) {
            throw new Error("Resumable stream finalization cancelled");
        }

        const expectedSize = Number(context.totalSize || 0);
        const stat = await fs.promises.stat(context.localPath);
        if (expectedSize > 0 && stat.size !== expectedSize) {
            throw new Error(`Staging validation failed: local(${stat.size}) vs expected(${expectedSize})`);
        }

        const uploadResult = await CloudTool.uploadLocalFileToRemote(
            context.localPath,
            context.fileName,
            context.userId,
            async (progress) => {
                await this.updateTelegramUI(taskId, {
                    ...context,
                    uploadedBytes: progress?.bytes || context.uploadedBytes,
                    totalSize: progress?.size || context.totalSize
                });
            },
            { signal: context.abortController?.signal }
        );

        if (!uploadResult?.success) {
            throw new StreamTransferFinalizationError(uploadResult?.error || "Resumable stream upload failed", uploadResult);
        }

        if (context.cancelled || context.finalizeToken !== token) {
            throw new Error("Resumable stream finalization cancelled");
        }

        await this.clearProgressFromCache(taskId);
        const completed = await this.finishTask(taskId, context);

        if (completed) {
            try {
                await fs.promises.unlink(context.localPath);
            } catch (error) {
                if (error.code !== "ENOENT") {
                    log.warn(`Failed to remove stream staging file for ${taskId}: ${error.message}`);
                }
            }
        }

        if (completed) {
            this.activeStreams.delete(taskId);
            return { success: true, completed: true };
        }

        return { success: false, completed: false, error: "Task completion was blocked or remote validation failed" };
    }

    async _handlePeriodicTasks(taskId, streamContext, chunkIndex, isLast) {
        // 定期保存进度到缓存（断点续传）
        if (chunkIndex % 10 === 0 || isLast) {
            await this.saveProgressToCache(taskId, streamContext);
        }

        // 定期更新 Telegram UI (使用 Bot API)
        if (chunkIndex % 20 === 0 || isLast) {
            await this.updateTelegramUI(taskId, streamContext);
        }

        // 定期上报进度到 Leader (用于 Leader 端的任务追踪)
        if (chunkIndex % 50 === 0 || isLast) {
            await this.reportProgressToLeader(taskId, streamContext);
        }
    }

    async updateTelegramUI(taskId, context) {
        if (!context.chatId || !context.msgId) return;

        // 简单的节流：每 3 秒最多更新一次
        const now = Date.now();
        if (context.lastUITime && now - context.lastUITime < 3000) {
            return;
        }
        context.lastUITime = now;

        try {
            const { UIHelper } = await import("../ui/templates.js");
            const { STRINGS } = await import("../locales/zh-CN.js");

            const text = UIHelper.renderProgress(context.uploadedBytes, context.totalSize, STRINGS.task.uploading, context.fileName);
            
            // 使用 Bot API 异步更新
            await TelegramBotApi.editMessageText(context.chatId, parseInt(context.msgId), text);
        } catch (error) {
            log.warn(`Failed to update Telegram UI for ${taskId}:`, error.message);
        }
    }

    /**
     * Worker 向 Leader 汇报进度
     */
    async reportProgressToLeader(taskId, context) {
        if (!context.leaderUrl) return;

        const url = `${context.leaderUrl.replace(/\/$/, '')}/api/v2/tasks/${taskId}/status`;
        try {
            await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-instance-secret': getStreamConfig().secret
                },
                body: JSON.stringify({
                    uploadedBytes: context.uploadedBytes,
                    totalSize: context.totalSize,
                    status: context.status,
                    claimedBy: context.claimedBy,
                    claimLeaseId: context.claimLeaseId
                })
            });
        } catch (error) {
            log.warn(`Failed to report progress to leader for ${taskId}:`, error.message);
        }
    }

    /**
     * Leader 接收进度上报并更新任务状态
     */
    async handleStatusUpdate(taskId, reqBody, headers) {
        if (!hasValidInstanceSecret(headers['x-instance-secret'], getStreamConfig().secret)) {
            return { success: false, statusCode: 401, message: "Unauthorized" };
        }

        const { status, error, claimedBy, claimLeaseId } = reqBody;
        
        if (status === TASK_STATUSES.COMPLETED || status === TASK_STATUSES.FAILED) {
            const event = status === TASK_STATUSES.COMPLETED ? TASK_EVENTS.COMPLETE : TASK_EVENTS.FAIL;
            await TaskRepository.transitionStatus(taskId, event, error, {
                ...getClaimFenceOptions({ claimedBy, claimLeaseId }),
                allowNoop: true,
                source: 'stream_status_update'
            });
        }

        return { success: true, statusCode: 200 };
    }

    /**
     * 断点续传：恢复任务传输
     */
    async resumeTask(taskId, metadata, targetUrl = null) {
        try {
            if (targetUrl) {
                if (!metadata?.ownerInstanceId) {
                    throw new Error(`Stream owner instance is required for task ${taskId}`);
                }
                const url = `${targetUrl.replace(/\/$/, '')}/api/v2/stream/${taskId}/resume`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-instance-secret': getStreamConfig().secret
                    },
                    body: JSON.stringify(metadata || {}),
                    signal: AbortSignal.timeout(10000)
                });
                if (!response.ok) {
                    const errorText = await response.text().catch(() => '');
                    throw new Error(`Worker resume failed with ${response.status}: ${errorText}`);
                }
                return await response.json();
            }

            const ownerCheck = await this._validateLocalStreamOwner(taskId, metadata?.ownerInstanceId);
            if (!ownerCheck.success) {
                return { ...ownerCheck, canResume: false };
            }

            if (metadata?.streamMode === 'resumable') {
                return await this._withTaskLock(taskId, async () => {
                    let context = this.activeStreams.get(taskId);
                    if (context) {
                        const metadataError = this._validateResumableMetadata(context, metadata);
                        if (metadataError) {
                            return { success: false, error: metadataError, canResume: false };
                        }
                    } else {
                        const progress = await this._getResumableProgress(taskId, metadata);
                        const finalization = await this._loadFinalizationStatus(taskId);
                        if (finalization?.status === 'completed') {
                            return {
                                success: true,
                                lastChunkIndex: progress.lastChunkIndex,
                                uploadedBytes: progress.uploadedBytes,
                                totalSize: progress.totalSize,
                                chunkSize: progress.chunkSize,
                                canResume: false,
                                complete: true,
                                finalization,
                                fileName: progress.fileName
                            };
                        }

                        if (this._isResumableDataComplete(progress)) {
                            await this._markStreamUploadStarted(taskId, 'stream_resumable_resume_complete_staging', metadata);
                            context = this._buildResumableContext(taskId, metadata, progress, null);
                            this.activeStreams.set(taskId, context);
                            await this.saveProgressToCache(taskId, context);
                            this._startResumableFinalization(taskId, context);
                        } else {
                            await this.saveProgressToCache(taskId, {
                                ...metadata,
                                ...progress,
                                mode: 'resumable'
                            });

                            return {
                                success: true,
                                lastChunkIndex: progress.lastChunkIndex,
                                uploadedBytes: progress.uploadedBytes,
                                totalSize: progress.totalSize,
                                chunkSize: progress.chunkSize,
                                canResume: progress.uploadedBytes > 0,
                                finalizing: false,
                                fileName: progress.fileName
                            };
                        }
                    }

                    return {
                        success: true,
                        lastChunkIndex: context.lastChunkIndex,
                        uploadedBytes: context.uploadedBytes,
                        totalSize: context.totalSize,
                        chunkSize: context.chunkSize,
                        canResume: !this._isResumableDataComplete(context) && context.uploadedBytes > 0,
                        finalizing: context.phase === 'finalizing',
                        complete: context.phase === 'completed',
                        finalization: context.finalizeState,
                        fileName: context.fileName
                    };
                });
            }

            const fullProgress = await this.getTaskFullProgress(taskId);
            
            if (!fullProgress.isCached && !fullProgress.isActive) {
                throw new Error(`Task ${taskId} not found for resume`);
            }

            const lastChunkIndex = fullProgress.lastChunkIndex;
            log.info(`🔄 Resuming task ${taskId} from chunk ${lastChunkIndex}`);

            return {
                success: true,
                lastChunkIndex,
                uploadedBytes: fullProgress.uploadedBytes,
                totalSize: fullProgress.totalSize,
                canResume: true
            };
        } catch (error) {
            log.error(`Failed to resume task ${taskId}:`, error);
            return {
                success: false,
                error: error.message,
                canResume: false
            };
        }
    }

    /**
     * 断点续传：清除任务的所有状态（强制重新开始）
     */
    async resetTask(taskId, targetUrl = null, options = {}) {
        try {
            if (targetUrl) {
                if (!options.ownerInstanceId) {
                    throw new Error(`Stream owner instance is required for task ${taskId}`);
                }
                const url = `${targetUrl.replace(/\/$/, '')}/api/v2/stream/${taskId}/reset`;
                const response = await fetch(url, {
                    method: 'DELETE',
                    headers: {
                        'x-instance-secret': getStreamConfig().secret,
                        'x-stream-owner-instance-id': options.ownerInstanceId
                    },
                    signal: AbortSignal.timeout(10000)
                });
                if (!response.ok) {
                    const errorText = await response.text().catch(() => '');
                    throw new Error(`Worker reset failed with ${response.status}: ${errorText}`);
                }
                return await response.json().catch(() => ({ success: true }));
            }

            return await this._withTaskLock(taskId, async () => {
                const ownerCheck = await this._validateLocalStreamOwner(taskId, options.ownerInstanceId || null, {
                    requireRequestedOwner: Boolean(options.requireOwnerHeader)
                });
                if (!ownerCheck.success) {
                    return ownerCheck;
                }

                // 清理活动流
                const context = this.activeStreams.get(taskId);
                if (context) {
                    if (context.mode === 'resumable') {
                        context.cancelled = true;
                        context.finalizeToken = null;
                        try { context.abortController?.abort(); } catch {}
                        await this._closeWriteStream(context.writeStream).catch(() => {});
                    } else {
                        try { context.stdin.end(); } catch {}
                        try { context.proc.kill(); } catch {}
                        await this._deletePartialRemoteFile(context);
                    }
                    this.activeStreams.delete(taskId);
                }

                // 清理缓存
                await this.clearProgressFromCache(taskId);
                await this._clearFinalizationStatus(taskId);
                await this.clearStreamOwner(taskId);
                await this._deleteResumableStaging(taskId).catch(error => {
                    log.warn(`Failed to delete resumable staging for ${taskId}: ${error.message}`);
                });

                // 清理重试计数
                for (const key of this.chunkRetryAttempts.keys()) {
                    if (key.startsWith(`${taskId}:`)) {
                        this.chunkRetryAttempts.delete(key);
                    }
                }

                log.info(`🗑️ Reset task ${taskId} - all state cleared`);
                return { success: true };
            });
        } catch (error) {
            log.error(`Failed to reset task ${taskId}:`, error);
            if (targetUrl) {
                throw error;
            }
            return { success: false, error: error.message };
        }
    }

    /**
     * 任务完成后的处理 (Worker 端)
     */
    async finishTask(taskId, context) {
        log.info(`✅ 任务上传完成: ${taskId}`);
        try {
            const remoteFile = await CloudTool.getRemoteFileInfo(context.fileName, context.userId, 2, true);
            const remoteSize = Number(remoteFile?.Size);
            const expectedSize = Number(context.totalSize || 0);
            if (!remoteFile || (expectedSize > 0 && remoteSize !== expectedSize)) {
                await this.reportError(taskId, context, `Validation failed: remote(${Number.isFinite(remoteSize) ? remoteSize : 'not found'}) vs expected(${expectedSize})`);
                return false;
            }
        } catch (error) {
            await this.reportError(taskId, context, `Validation failed: ${error.message}`);
            return false;
        }

        const transition = await TaskRepository.transitionStatus(taskId, TASK_EVENTS.COMPLETE, null, {
            ...getClaimFenceOptions(context),
            returnResult: true,
            allowNoop: true,
            source: 'stream_finish_task'
        });
        if (transition.blocked) return false;
        
        try {
            const { STRINGS, format } = await import("../locales/zh-CN.js");
            const originalMsgId = context.sourceMsgId || context.msgId;
            const fileLink = `tg://openmessage?chat_id=${context.chatId}&message_id=${originalMsgId}`;
            const fileNameHtml = `<a href="${fileLink}">${escapeHTML(context.fileName)}</a>`;
            const text = format(STRINGS.task.success, { name: fileNameHtml, folder: getConfig().remoteFolder });
            await TelegramBotApi.editMessageText(context.chatId, parseInt(context.msgId), text);
        } catch (error) {
            log.warn('Failed to update Telegram message after task completion', {
                taskId,
                chatId: context.chatId,
                msgId: context.msgId,
                error: error.message
            });
        }

        if (context.leaderUrl) {
            await this.reportProgressToLeader(taskId, { ...context, status: TASK_STATUSES.COMPLETED });
        }
        return true;
    }

    async _deletePartialRemoteFile(context) {
        if (!context?.fileName || !context?.userId || typeof CloudTool.deleteRemoteFile !== 'function') {
            return;
        }

        try {
            const result = await CloudTool.deleteRemoteFile(context.fileName, context.userId);
            if (result?.success === false) {
                log.warn('Failed to delete partial stream remote file', {
                    fileName: context.fileName,
                    userId: context.userId,
                    error: result.error
                });
            }
        } catch (error) {
            log.warn('Failed to delete partial stream remote file', {
                fileName: context.fileName,
                userId: context.userId,
                error: error.message
            });
        }
    }

    async _deleteResumableStaging(taskId) {
        const resumeDir = this._getResumeDir();
        let entries = [];
        try {
            entries = await fs.promises.readdir(resumeDir);
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
        }

        const prefix = `${sanitizeTaskPathSegment(taskId)}.`;
        await Promise.all(entries
            .filter(entry => entry.startsWith(prefix) && entry.endsWith('.part'))
            .map(entry => fs.promises.unlink(path.join(resumeDir, entry)).catch(error => {
                if (error.code !== "ENOENT") throw error;
            })));
    }

    async reportError(taskId, context, errorMsg, failure = null) {
        const metadata = failure || (errorMsg && typeof errorMsg === 'object' ? errorMsg : null);
        const rawErrorMsg = metadata instanceof Error
            ? metadata.message
            : metadata?.diagnosticMessage || metadata?.error || metadata?.message || errorMsg;
        const safeErrorMsg = String(redactSensitiveText(rawErrorMsg || "Stream transfer failed") || "Stream transfer failed");
        const classification = resolveRcloneFailureMetadata({
            ...metadata,
            error: safeErrorMsg
        }, {
            operation: "stream",
            remotePathScoped: true
        });
        const userMessage = classification.userMessage ? redactSensitiveText(classification.userMessage) : null;
        const displayMessage = userMessage || safeErrorMsg;
        log.error(`❌ 任务上传失败: ${taskId} - ${safeErrorMsg}`);
        const transition = await TaskRepository.transitionStatus(taskId, TASK_EVENTS.FAIL, safeErrorMsg, {
            ...getClaimFenceOptions(context),
            returnResult: true,
            allowNoop: true,
            source: 'stream_report_error'
        });
        if (transition.blocked) return;
        
        try {
            const text = `❌ 上传失败: ${displayMessage}`;
            await TelegramBotApi.editMessageText(context.chatId, parseInt(context.msgId), text);
        } catch (error) {
            log.warn('Failed to update Telegram message after task error', {
                taskId,
                chatId: context.chatId,
                msgId: context.msgId,
                error: error.message
            });
        }

        if (context.leaderUrl) {
            await this.reportProgressToLeader(taskId, { ...context, status: TASK_STATUSES.FAILED, error: safeErrorMsg });
        }
    }

    /**
     * 保存进度到缓存 (断点续传)
     */
    async saveProgressToCache(taskId, context) {
        try {
            const progressData = {
                taskId,
                fileName: context.fileName,
                userId: context.userId,
                totalSize: context.totalSize,
                uploadedBytes: context.uploadedBytes,
                lastChunkIndex: context.lastChunkIndex,
                leaderUrl: context.leaderUrl,
                chatId: context.chatId,
                msgId: context.msgId,
                sourceMsgId: context.sourceMsgId,
                localPath: context.localPath,
                chunkSize: context.chunkSize,
                mode: context.mode,
                timestamp: Date.now()
            };
            
            const cacheKey = CACHE_KEYS.streamProgress(taskId);
            await cache.set(cacheKey, progressData, this.progressCacheTTL);
            log.debug(`Progress saved to cache for task ${taskId}, chunk ${context.lastChunkIndex}`);
        } catch (error) {
            log.warn(`Failed to save progress to cache for ${taskId}:`, error.message);
        }
    }

    /**
     * 从缓存加载进度 (断点续传)
     */
    async loadProgressFromCache(taskId) {
        try {
            const cacheKey = CACHE_KEYS.streamProgress(taskId);
            const progressData = await cache.get(cacheKey);
            
            if (progressData) {
                log.info(`Progress loaded from cache for task ${taskId}, chunk ${progressData.lastChunkIndex}`);
                return progressData;
            }
        } catch (error) {
            log.warn(`Failed to load progress from cache for ${taskId}:`, error.message);
        }
        return null;
    }

    /**
     * 清理缓存中的进度 (断点续传)
     */
    async clearProgressFromCache(taskId) {
        try {
            const cacheKey = CACHE_KEYS.streamProgress(taskId);
            await cache.delete(cacheKey);
            log.debug(`Progress cleared from cache for task ${taskId}`);
        } catch (error) {
            log.warn(`Failed to clear progress from cache for ${taskId}:`, error.message);
        }
    }

    /**
     * 获取任务的完整进度信息（包含缓存状态）
     */
    async getTaskFullProgress(taskId) {
        const context = this.activeStreams.get(taskId);
        if (context) {
            return this._formatProgressSnapshot(context);
        }

        const loadedFinalization = await this._loadFinalizationStatus(taskId);
        const finalization = loadedFinalization?.status ? loadedFinalization : null;

        // 如果不在内存中，尝试从缓存获取
        const cachedProgress = await this.loadProgressFromCache(taskId);
        if (cachedProgress) {
            return {
                isActive: false,
                isCached: true,
                lastChunkIndex: cachedProgress.lastChunkIndex,
                uploadedBytes: cachedProgress.uploadedBytes,
                totalSize: cachedProgress.totalSize,
                mode: cachedProgress.mode,
                phase: cachedProgress.phase,
                finalization: finalization || undefined,
                cachedAt: cachedProgress.timestamp
            };
        }

        return {
            isActive: false,
            isCached: false,
            lastChunkIndex: -1,
            uploadedBytes: 0,
            totalSize: 0,
            finalization: finalization || undefined
        };
    }

    /**
     * 清理过期的流和重试计数 (Worker 端)
     */
    cleanupStaleStreams() {
        const now = Date.now();
        const timeout = 300000; // 5分钟
        
        for (const [taskId, context] of this.activeStreams.entries()) {
            if (now - context.lastSeen > timeout) {
                log.warn(`清理过期流任务: ${taskId}`);
                if (context.mode === 'resumable') {
                    this._closeWriteStream(context.writeStream).catch(() => {});
                    this.saveProgressToCache(taskId, context).catch(() => {});
                } else {
                    try { context.stdin.end(); } catch {}
                    try { context.proc.kill(); } catch {}
                }
                this.activeStreams.delete(taskId);
            }
        }

        // 清理过期的重试计数
        for (const [key, attempts] of this.chunkRetryAttempts.entries()) {
            if (attempts >= this.maxRetryAttempts) {
                // 检查是否超过了清理时间
                const [taskId] = key.split(':');
                const context = this.activeStreams.get(taskId);
                if (!context || now - context.lastSeen > timeout) {
                    this.chunkRetryAttempts.delete(key);
                    log.debug(`Cleaned up stale retry attempts for ${key}`);
                }
            }
        }
    }
}

export const streamTransferService = new StreamTransferService();

class StreamTransferFinalizationError extends Error {
    constructor(message, metadata = {}) {
        super(message);
        this.name = "StreamTransferFinalizationError";
        this.errorCode = metadata.errorCode;
        this.userMessage = metadata.userMessage;
        this.retryable = metadata.retryable;
        this.userRetryable = metadata.userRetryable;
    }
}
export default streamTransferService;
