import { once } from "events";
import path from "path";
import { randomUUID } from "crypto";
import { getConfig } from "../config/index.js";
import { parseBoolean } from "../config/boolean.js";
import { CloudTool } from "./rclone.js";
import { logger } from "./logger/index.js";
import { redactSensitiveText } from "../utils/serializer.js";
import { RCLONE_ERROR_CODES } from "../domain/rclone-error.js";
import { resolveRcloneFailureMetadata } from "../utils/rcloneErrorMessage.js";

const log = logger.withModule ? logger.withModule("DirectTransferService") : logger;

const DEFAULT_SMALL_CHUNK_SIZE = 128 * 1024;
const DEFAULT_LARGE_CHUNK_SIZE = 512 * 1024;
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
const MAX_RCLONE_ERROR_LOG = 8000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_STALL_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_MAX_DIRECT_ATTEMPTS = 5;
const DEFAULT_DIRECT_RETRY_DELAY_MS = 2000;
// 连接抖动(telegram_source)时用指数退避,让大文件能活过 15-30s 的断连-重连窗口;
// 封顶避免单任务重试拖太久。
const MAX_DIRECT_RETRY_DELAY_MS = 30000;
const RCLONE_DIAGNOSTIC_GRACE_MS = 1500;

// Adaptive stall timeout constants
const ADAPTIVE_STALL_WINDOW_MS = 60_000;
const ADAPTIVE_STALL_MIN_TIMEOUT_MS = 90_000;
const ADAPTIVE_STALL_MAX_TIMEOUT_MS = 30 * 60 * 1000;
const ADAPTIVE_STALL_SAFETY_FACTOR = 5;
const ADAPTIVE_STALL_WARMUP_BYTES = 512 * 1024;
const LOCAL_STAGING_REQUIRED_DRIVE_TYPES = new Set(["oss", "r2", "s3"]);
// Proton 的服务端 move(moveto)最不可靠:目录最终一致性会让它稳定报
// "Server side directory move failed: directory not found",而此时 staging 文件的字节
// 其实早已完整传上去了 —— 整段转存只死在最后这一步。直写最终路径把这次 move 整个跳过。
// 失败残留由 rclone 的 replace_existing_draft 在重试时替换(见 ProtonDriveProvider),
// 因为最终名不是 _isManagedStagingFile 认的 staging 名,不能走 _cleanupRemote 删。
const DIRECT_WRITE_DRIVE_TYPES = new Set(["protondrive"]);
const TELEGRAM_SOURCE_TRANSIENT_ERROR_CODE = "TELEGRAM_SOURCE_TRANSIENT";
const TELEGRAM_SOURCE_TRANSIENT_ERROR_PATTERNS = [
    /^TIMEOUT$/i,
    /CONNECTION_NOT_INITED/i,
    /Cannot send requests while disconnected/i,
    /Not connected/i,
    /Connection closed/i,
    /Client not initialized/i,
    /upload\.GetFile/i,
    /Cannot read propert(?:y|ies) of undefined \(reading ['"]dcId['"]\)/i
];
const NON_FALLBACK_RCLONE_ERROR_CODES = new Set([
    RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID,
    RCLONE_ERROR_CODES.DRIVE_CONFIG_INVALID,
    RCLONE_ERROR_CODES.DRIVE_REMOTE_NOT_FOUND,
    RCLONE_ERROR_CODES.DRIVE_QUOTA_EXCEEDED,
    RCLONE_ERROR_CODES.DRIVE_PERMISSION_DENIED
]);

const RCLONE_TARGET_RETRY_SCOPE = "rclone_target";
// 我们自己的 staging 命名:.drive-collector-<taskId>-<创建时间戳>-<uuid>.part.<原文件名>
// 第 3 段的毫秒时间戳既用来识别"自己人文件",也用来判断它是不是早于本次启动的孤儿。
const MANAGED_STAGING_FILE_PATTERN = /^\.drive-collector-[a-zA-Z0-9_-]+-(\d+)-[0-9a-f-]{36}\.part\./;
const DEFAULT_ORPHAN_STAGING_MAX_AGE_MS = 30 * 60 * 1000;

class TransferSpeedMonitor {
    constructor({ windowMs = ADAPTIVE_STALL_WINDOW_MS } = {}) {
        this._windowMs = windowMs;
        this._samples = [];
        this._totalBytes = 0;
        this._startTime = Date.now();
    }

    record(bytes) {
        const now = Date.now();
        this._samples.push({ bytes, ts: now });
        this._totalBytes += bytes;
        const cutoff = now - this._windowMs;
        while (this._samples.length > 1 && this._samples[0].ts < cutoff) {
            this._samples.shift();
        }
    }

    getBytesPerSecond() {
        if (this._samples.length < 2) return null;
        const first = this._samples[0];
        const last = this._samples[this._samples.length - 1];
        const elapsedMs = last.ts - first.ts;
        if (elapsedMs <= 0) return null;
        let windowBytes = 0;
        for (let i = 1; i < this._samples.length; i++) {
            windowBytes += this._samples[i].bytes;
        }
        return (windowBytes / elapsedMs) * 1000;
    }

    getElapsedMs() {
        return Date.now() - this._startTime;
    }

    getTotalBytes() {
        return this._totalBytes;
    }

    getAdaptiveStallTimeoutMs(chunkSize, configTimeoutMs, { minTimeoutMs } = {}) {
        const baseTimeout = Number.isFinite(configTimeoutMs) && configTimeoutMs > 0
            ? configTimeoutMs
            : DEFAULT_STALL_TIMEOUT_MS;
        const effectiveMin = Number.isFinite(minTimeoutMs) && minTimeoutMs >= 0
            ? minTimeoutMs
            : ADAPTIVE_STALL_MIN_TIMEOUT_MS;
        if (this._totalBytes < ADAPTIVE_STALL_WARMUP_BYTES) {
            return Math.max(baseTimeout, effectiveMin);
        }
        const speed = this.getBytesPerSecond();
        if (!speed || speed <= 0) {
            return Math.max(baseTimeout, effectiveMin);
        }
        const estimatedMs = (chunkSize / speed) * 1000 * ADAPTIVE_STALL_SAFETY_FACTOR;
        return Math.min(
            Math.max(estimatedMs, effectiveMin),
            ADAPTIVE_STALL_MAX_TIMEOUT_MS
        );
    }
}

export class DirectTransferService {
    constructor(cloudTool = CloudTool, options = {}) {
        this.cloudTool = cloudTool;
        this.validationRetryDelayMs = Number.isFinite(options.validationRetryDelayMs)
            ? Math.max(0, options.validationRetryDelayMs)
            : 1000;
    }

    canAttempt(config = getConfig(), options = {}) {
        if (!parseBoolean(config.directTransfer?.enabled, true)) {
            return { supported: false, reason: "disabled" };
        }

        const driveType = String(options.driveType || "").toLowerCase();
        if (LOCAL_STAGING_REQUIRED_DRIVE_TYPES.has(driveType)) {
            return { supported: false, reason: `${driveType}-local-staging-required` };
        }
        const hasObjectStorageBucket = Boolean(config.oss?.bucket || config.oss?.r2?.bucket);
        if (!driveType && config.remoteName === "r2" && hasObjectStorageBucket) {
            return { supported: false, reason: "oss-local-staging-required" };
        }

        const required = ["createRcatStream", "moveRemoteFile", "deleteRemoteFile", "getRemoteFileInfo"];
        const missing = required.filter(method => typeof this.cloudTool?.[method] !== "function");
        if (missing.length > 0) {
            return { supported: false, reason: `missing-cloud-tool-methods:${missing.join(",")}` };
        }

        return { supported: true, reason: "rclone-rcat" };
    }

    async transferTelegramMediaToRemote(args) {
        const config = args?.config || getConfig();
        const maxAttempts = this._resolveMaxAttempts(config);
        const retryDelayMs = this._resolveRetryDelayMs(config);
        let lastResult = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            lastResult = await this._transferTelegramMediaToRemoteOnce(args);
            if (lastResult?.success) return lastResult;

            const shouldRetry = lastResult?.retryable === true && attempt < maxAttempts;
            if (!shouldRetry) {
                this._logFinalDirectTransferFailure(args, lastResult, attempt);
                return {
                    ...lastResult,
                    directTransferAttempts: attempt
                };
            }

            // 指数退避 + 封顶: retryDelayMs * 2^(attempt-1),比线性更能活过持续断连窗口。
            const backoffMs = Math.min(retryDelayMs * (2 ** (attempt - 1)), MAX_DIRECT_RETRY_DELAY_MS);
            log.info("Retrying direct transfer after retryable failure", {
                taskId: args?.task?.id,
                userId: args?.task?.userId,
                fileName: args?.fileName,
                attempt,
                maxAttempts,
                errorCode: lastResult.errorCode,
                retryScope: lastResult.retryScope,
                backoffMs,
                reason: redactSensitiveText(lastResult.error || lastResult.reason || "retryable direct transfer failure")
            });

            // 源端 sender 卡死(CONNECTION_NOT_INITED 等)时,拆掉该文件 DC 的导出下载 sender,
            // 让下次 iterDownload 拿到全新 sender 并重发 InitConnection——否则原地重试必然复撞同一错。
            // 只对 telegram_source 生效,不动 rclone_target(网盘侧)的重试。
            if (
                lastResult.retryScope === "telegram_source" &&
                parseBoolean(config?.directTransfer?.resetSenderOnRetry, true) &&
                typeof args?.resetSource === "function"
            ) {
                await Promise.resolve(args.resetSource()).catch(() => {});
            }

            await this._delay(backoffMs);
        }

        return {
            ...(lastResult || this._buildFallbackResult(config, "direct-transfer-not-attempted")),
            directTransferAttempts: maxAttempts
        };
    }

    async _transferTelegramMediaToRemoteOnce({
        task,
        message,
        client,
        info,
        fileName,
        chunkSize,
        config = getConfig(),
        existingRemoteFile,
        driveType = null,
        onProgress,
        isCancelled
    }) {
        const capability = this.canAttempt(config, { driveType });
        if (!capability.supported) {
            return this._buildFallbackResult(config, capability.reason);
        }

        const totalSize = Number(info?.size || 0);
        const effectiveChunkSize = Number.isFinite(chunkSize) && chunkSize > 0
            ? chunkSize
            : (totalSize > LARGE_FILE_THRESHOLD ? DEFAULT_LARGE_CHUNK_SIZE : DEFAULT_SMALL_CHUNK_SIZE);
        const finalFileName = this.cloudTool.sanitizeRemoteFileName?.(fileName) || path.basename(String(fileName || "unnamed.bin"));
        const directWrite = DIRECT_WRITE_DRIVE_TYPES.has(String(driveType || "").toLowerCase());
        const stagingFileName = directWrite
            ? finalFileName
            : this._buildStagingFileName(task.id, finalFileName);
        let stagedRemoteName = stagingFileName;
        let movedToFinal = false;
        let uploadedBytes = 0;
        let stdin = null;
        let proc = null;
        let rcloneCompletion = null;
        let sourceIterator = null;

        if (existingRemoteFile === undefined) {
            existingRemoteFile = await this.cloudTool.getRemoteFileInfo(finalFileName, task.userId, 1, true);
        }
        if (existingRemoteFile) {
            if (this._isSizeMatch(existingRemoteFile.Size, totalSize)) {
                return this._buildExistingRemoteResult(finalFileName, totalSize, uploadedBytes);
            }
            return this._buildFallbackResult(config, "remote-name-conflict");
        }

        try {
            const rcat = await this.cloudTool.createRcatStream(stagingFileName, task.userId, { size: totalSize });
            stdin = rcat.stdin;
            proc = rcat.proc;
            const remoteStagingName = rcat.fileName;
            stagedRemoteName = remoteStagingName || stagingFileName;
            const transferTimeoutMs = this._resolveTransferTimeoutMs(config);
            const stallTimeoutMs = this._resolveStallTimeoutMs(config);
            const minStallTimeoutMs = this._resolveMinStallTimeoutMs(config);
            const speedMonitor = new TransferSpeedMonitor();
            rcloneCompletion = this._watchRcloneProcess(proc, task.id, transferTimeoutMs);

            const downloadIterator = client.iterDownload({
                file: message.media,
                requestSize: effectiveChunkSize,
                chunkSize: effectiveChunkSize,
                stride: effectiveChunkSize
            });
            sourceIterator = downloadIterator?.[Symbol.asyncIterator]?.() || downloadIterator;

            let lastLoggedTimeout = 0;
            while (true) {
                const adaptiveTimeout = speedMonitor.getAdaptiveStallTimeoutMs(effectiveChunkSize, stallTimeoutMs, { minTimeoutMs: minStallTimeoutMs });
                if (Math.abs(adaptiveTimeout - lastLoggedTimeout) > 30000) {
                    log.info("Adaptive stall timeout adjusted", {
                        taskId: task.id,
                        adaptiveTimeoutMs: Math.round(adaptiveTimeout),
                        baseTimeoutMs: stallTimeoutMs,
                        speedBps: speedMonitor.getBytesPerSecond() ? Math.round(speedMonitor.getBytesPerSecond()) : null,
                        totalBytes: speedMonitor.getTotalBytes()
                    });
                    lastLoggedTimeout = adaptiveTimeout;
                }
                let nextChunk;
                try {
                    nextChunk = await this._withStallTimeout(
                        () => sourceIterator.next(),
                        {
                            taskId: task.id,
                            timeoutMs: adaptiveTimeout,
                            phase: "telegram_source",
                            onTimeout: () => this._abortRclone(stdin, proc)
                        }
                    );
                } catch (sourceError) {
                    if (this._isTelegramSourceTransientError(sourceError)) {
                        sourceError.errorCode = TELEGRAM_SOURCE_TRANSIENT_ERROR_CODE;
                        sourceError.retryScope = "telegram_source";
                    }
                    throw sourceError;
                }
                if (nextChunk.done) break;
                const chunk = nextChunk.value;
                if (isCancelled?.()) {
                    throw new Error("CANCELLED");
                }
                await this._withStallTimeout(
                    () => this._writeWithBackpressure(stdin, chunk),
                    {
                        taskId: task.id,
                        timeoutMs: adaptiveTimeout,
                        phase: "rclone_stdin",
                        onTimeout: () => this._abortRclone(stdin, proc)
                    }
                );
                uploadedBytes += chunk.length;
                speedMonitor.record(chunk.length);
                await this._withStallTimeout(
                    () => onProgress?.({
                        bytes: Math.min(uploadedBytes, totalSize || uploadedBytes),
                        size: totalSize || uploadedBytes,
                        method: "direct_stream"
                    }),
                    {
                        taskId: task.id,
                        timeoutMs: adaptiveTimeout,
                        phase: "progress_callback",
                        onTimeout: () => this._abortRclone(stdin, proc)
                    }
                );
            }

            // gramjs 在照片解析的任一步失败时都静默返回空 buffer(downloads.js 的
            // _downloadPhoto / 未知 media 分支都是 return Buffer.alloc(0)),不抛错。
            // 0 字节喂给 rclone 会被报成 "sizes differ src 0",既误导又跳过重试——
            // 实为源侧失败。归类成 telegram_source 瞬时错误,让它走既有的重置 sender + 重试。
            if (uploadedBytes === 0) {
                const emptyStreamError = new Error(
                    `Telegram source produced an empty stream (expected ${totalSize} bytes) for "${finalFileName}"`
                );
                emptyStreamError.errorCode = TELEGRAM_SOURCE_TRANSIENT_ERROR_CODE;
                emptyStreamError.retryScope = "telegram_source";
                throw emptyStreamError;
            }

            // gramjs 在照片解析的任一步失败时都静默返回空 buffer(downloads.js 的
            // _downloadPhoto / 未知 media 分支都是 return Buffer.alloc(0)),不抛错。
            // 0 字节喂给 rclone 会被报成 "sizes differ src 0",既误导又跳过重试——
            // 实为源侧失败。归类成 telegram_source 瞬时错误,让它走既有的重置 sender + 重试。
            if (uploadedBytes === 0) {
                const emptyStreamError = new Error(
                    `Telegram source produced an empty stream (expected ${totalSize} bytes) for "${finalFileName}"`
                );
                emptyStreamError.errorCode = TELEGRAM_SOURCE_TRANSIENT_ERROR_CODE;
                emptyStreamError.retryScope = "telegram_source";
                throw emptyStreamError;
            }

            const endAdaptiveTimeout = speedMonitor.getAdaptiveStallTimeoutMs(effectiveChunkSize, stallTimeoutMs, { minTimeoutMs: minStallTimeoutMs });
            await this._withStallTimeout(
                () => this._endWritable(stdin),
                {
                    taskId: task.id,
                    timeoutMs: endAdaptiveTimeout,
                    phase: "rclone_stdin_end",
                    onTimeout: () => this._abortRclone(stdin, proc)
                }
            );
            const completionAdaptiveTimeout = speedMonitor.getAdaptiveStallTimeoutMs(effectiveChunkSize, stallTimeoutMs, { minTimeoutMs: minStallTimeoutMs });
            const rcloneResult = await this._withStallTimeout(
                () => rcloneCompletion,
                {
                    taskId: task.id,
                    timeoutMs: completionAdaptiveTimeout,
                    phase: "rclone_completion",
                    onTimeout: () => this._abortRclone(stdin, proc)
                }
            );
            if (!rcloneResult.success) {
                throw new DirectTransferFallbackError(rcloneResult.error || "rclone rcat failed", rcloneResult);
            }

            const preMoveRemote = await this.cloudTool.getRemoteFileInfo(finalFileName, task.userId, 1, true);
            if (preMoveRemote) {
                if (this._isSizeMatch(preMoveRemote.Size, totalSize)) {
                    // 直写模式下 stagedRemoteName 就是 finalFileName,删它等于删掉本次要交付的文件
                    if (!directWrite) {
                        await this._cleanupRemote(stagedRemoteName, task.userId, "remote_completed_concurrently");
                    }
                    return this._buildExistingRemoteResult(finalFileName, totalSize, uploadedBytes);
                }
                throw new DirectTransferFallbackError(
                    `Remote file name conflict before finalize: local(${totalSize}) vs remote(${preMoveRemote.Size ?? "unknown"})`
                );
            }

            if (directWrite) {
                // rcat 已把字节写在最终路径上,没有 staging,也就没有那次服务端 move
                movedToFinal = true;
            } else {
                const moveResult = await this.cloudTool.moveRemoteFile(stagedRemoteName, finalFileName, task.userId);
                if (!moveResult?.success) {
                    throw new DirectTransferFallbackError(moveResult?.error || "rclone moveto failed");
                }
                movedToFinal = true;
            }

            const finalRemote = await this._waitForRemoteValidation(finalFileName, task.userId, totalSize);
            if (!this._isSizeMatch(finalRemote?.Size, totalSize)) {
                throw new DirectTransferFallbackError(
                    `Direct transfer validation failed: local(${totalSize}) vs remote(${finalRemote?.Size ?? "not found"})`
                );
            }

            return {
                success: true,
                method: "direct_stream",
                fileName: finalFileName,
                bytes: totalSize || uploadedBytes
            };
        } catch (error) {
            const rcloneFailure = await this._resolveRcloneFailureAfterStreamError(rcloneCompletion, task.id, error);
            this._abortRclone(stdin, proc);
            await this._closeSourceIterator(sourceIterator, task.id);
            if (!movedToFinal && !directWrite) {
                await this._cleanupRemote(stagedRemoteName, task.userId, "transfer_failed");
            }
            if (error?.message === "CANCELLED") {
                throw error;
            }

            // 源侧定性 vs rclone 死信号:源侧 stall 是我们自己的超时钩子 SIGTERM 掉 rclone 的,
            // rclone 只会报 "terminated by signal SIGTERM",说不出是谁掐的。拿它当 effectiveError
            // 会把 Telegram 下载故障误标成 rclone_target,重试时便跳过 resetExportedDownloadSender
            // ——卡死的导出下载 sender 每次重试原地复撞,必然次次全死。
            // 但只要 rclone 带上了自己的诊断(stderr 尾巴或非零 exit code),那就是另一个独立的、
            // 可能是永久性的网盘故障,定性交给它自己的分类——我们只把源侧原因留在 message 里不丢证据。
            const effectiveError = rcloneFailure?.success === false ? rcloneFailure : error;
            const rcloneOnlyGotKilled = Boolean(rcloneFailure?.error)
                && /terminated by signal \w+$/.test(String(rcloneFailure.error).trim());
            const sourceScoped = error?.retryScope === "telegram_source" && (!rcloneFailure || rcloneOnlyGotKilled);
            const message = redactSensitiveText(
                [
                    error?.retryScope === "telegram_source" ? error?.message : null,
                    effectiveError?.error || effectiveError?.message || String(effectiveError)
                ].filter(Boolean).join("; ")
            );
            if (sourceScoped) {
                return {
                    success: false,
                    fallback: false,
                    error: message,
                    errorCode: TELEGRAM_SOURCE_TRANSIENT_ERROR_CODE,
                    retryable: true,
                    userRetryable: true,
                    retryScope: "telegram_source"
                };
            }

            const fallbackAllowed = this._isLocalFallbackAllowed(config);
            const failureMetadata = resolveRcloneFailureMetadata({
                ...effectiveError,
                error: message
            }, {
                operation: "rcat",
                remotePathScoped: true
            });
            const errorCode = failureMetadata.errorCode;
            const isPermanentDriveFailure = NON_FALLBACK_RCLONE_ERROR_CODES.has(errorCode);
            const scopedFailureMetadata = failureMetadata.retryable
                ? { ...failureMetadata, retryScope: RCLONE_TARGET_RETRY_SCOPE }
                : failureMetadata;
            if (!fallbackAllowed || isPermanentDriveFailure) {
                return { success: false, fallback: false, error: message, ...scopedFailureMetadata };
            }

            return { success: false, fallback: true, error: message, ...scopedFailureMetadata };
        }
    }

    _isTelegramSourceTransientError(error) {
        if (error?.phase === "telegram_source") return true;
        const text = [
            error?.name,
            error?.code,
            error?.message,
            error?.errorMessage,
            error?.cause?.message
        ].filter(Boolean).join(" ");
        return TELEGRAM_SOURCE_TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(text));
    }

    _logFinalDirectTransferFailure(args, result, attempts) {
        if (!result || result.success) return;

        const task = args?.task || {};
        const payload = {
            taskId: task.id,
            userId: task.userId,
            fileName: args?.fileName,
            driveType: args?.driveType,
            attempts,
            errorCode: result.errorCode,
            retryable: result.retryable,
            userRetryable: result.userRetryable,
            reason: redactSensitiveText(result.error || result.reason || "direct transfer failed")
        };

        if (result.fallback) {
            log.warn("Direct transfer failed; falling back to local staging", payload);
            return;
        }

        log.warn("Direct transfer failed closed", {
            ...payload,
            fallbackAllowed: this._isLocalFallbackAllowed(args?.config || getConfig())
        });
    }

    _isLocalFallbackAllowed(config) {
        return parseBoolean(config?.directTransfer?.fallbackToLocal, false);
    }

    _buildFallbackResult(config, reason, extra = {}) {
        return {
            success: false,
            fallback: this._isLocalFallbackAllowed(config),
            reason,
            ...extra
        };
    }

    async _resolveRcloneFailureAfterStreamError(rcloneCompletion, taskId, error) {
        if (!rcloneCompletion) return null;

        try {
            const result = await Promise.race([
                rcloneCompletion,
                this._delay(RCLONE_DIAGNOSTIC_GRACE_MS).then(() => null)
            ]);
            if (result?.success === false) return result;
        } catch (watchError) {
            log.warn("Direct transfer failed to resolve rclone diagnostic after stream error", {
                taskId,
                error: redactSensitiveText(watchError?.message || String(watchError))
            });
        }

        return null;
    }

    _abortRclone(stdin, proc) {
        try {
            if (stdin && !stdin.destroyed) stdin.destroy();
        } catch {}
        try {
            if (proc && !proc.killed) proc.kill("SIGTERM");
        } catch {}
    }

    _buildStagingFileName(taskId, finalFileName) {
        const safeTaskId = String(taskId || "task").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
        const safeFinalName = path.basename(String(finalFileName || "unnamed.bin"));
        return `.drive-collector-${safeTaskId}-${Date.now()}-${randomUUID()}.part.${safeFinalName}`;
    }

    async _writeWithBackpressure(writable, chunk) {
        if (!writable?.writable || writable.destroyed) {
            throw new Error("rcat stdin is not writable");
        }

        const canContinue = writable.write(chunk);
        if (!canContinue) {
            await Promise.race([
                once(writable, "drain"),
                once(writable, "error").then(([error]) => {
                    throw error;
                })
            ]);
        }
    }

    async _withStallTimeout(operation, { taskId, timeoutMs, phase, onTimeout } = {}) {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            return await operation();
        }

        let timeout = null;
        let settled = false;
        const timeoutPromise = new Promise((_, reject) => {
            timeout = setTimeout(() => {
                if (settled) return;
                const error = new DirectTransferStallError(
                    `direct transfer stall timeout after ${timeoutMs}ms during ${phase || "unknown"}`,
                    { phase, timeoutMs }
                );
                try {
                    onTimeout?.(error);
                } catch (abortError) {
                    log.warn("Direct transfer stall abort hook failed", {
                        taskId,
                        phase,
                        error: redactSensitiveText(abortError?.message || String(abortError))
                    });
                }
                reject(error);
            }, timeoutMs);
            timeout.unref?.();
        });

        try {
            return await Promise.race([
                Promise.resolve().then(operation),
                timeoutPromise
            ]);
        } finally {
            settled = true;
            if (timeout) clearTimeout(timeout);
        }
    }

    async _endWritable(writable) {
        if (!writable || writable.destroyed || writable.closed) return;
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
                writable.off?.("error", onError);
                writable.off?.("finish", onFinish);
            };

            writable.once("error", onError);
            writable.once("finish", onFinish);
            writable.end();
        });
    }

    async _closeSourceIterator(sourceIterator, taskId) {
        if (!sourceIterator || typeof sourceIterator.return !== "function") return;
        try {
            await Promise.race([
                Promise.resolve(sourceIterator.return()),
                this._delay(500)
            ]);
        } catch (error) {
            log.warn("Direct transfer source iterator cleanup failed", {
                taskId,
                error: redactSensitiveText(error?.message || String(error))
            });
        }
    }

    _watchRcloneProcess(proc, taskId, timeoutMs = DEFAULT_TRANSFER_TIMEOUT_MS) {
        return new Promise((resolve) => {
            let stderrLog = "";
            let resolved = false;
            let timeout = null;
            const safeResolve = (result) => {
                if (resolved) return;
                resolved = true;
                if (timeout) clearTimeout(timeout);
                resolve(result);
            };

            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                timeout = setTimeout(() => {
                    try {
                        if (proc && !proc.killed) proc.kill("SIGTERM");
                    } catch {}
                    safeResolve(this._buildRcloneFailure(`rclone rcat timed out after ${timeoutMs}ms`));
                }, timeoutMs);
            }

            proc.stderr?.on("data", (data) => {
                stderrLog += data.toString();
                if (stderrLog.length > MAX_RCLONE_ERROR_LOG) {
                    stderrLog = stderrLog.slice(-MAX_RCLONE_ERROR_LOG);
                }
            });

            proc.on("close", (code, signal) => {
                const hasErrors = /(^|\b)(ERROR|Failed|failed|error)(\b|:)/.test(stderrLog || "");
                if (code === 0 && !hasErrors) {
                    safeResolve({ success: true });
                    return;
                }
                const fallbackMessage = signal
                    ? `rclone rcat terminated by signal ${signal}`
                    : code === null || code === undefined
                        ? "rclone rcat exited without an exit code"
                        : `rclone rcat exited with code ${code}`;
                const errorTail = redactSensitiveText(stderrLog.slice(-500).trim());
                const diagnosticMessage = errorTail
                    ? `${fallbackMessage}; ${errorTail}`
                    : fallbackMessage;
                safeResolve(this._buildRcloneFailure(diagnosticMessage));
            });

            proc.on("error", (error) => {
                safeResolve(this._buildRcloneFailure(error.message));
            });
        }).catch((error) => {
            log.warn("Direct transfer rclone watcher failed", { taskId, error: redactSensitiveText(error.message) });
            return this._buildRcloneFailure(error.message);
        });
    }

    _buildRcloneFailure(errorMessage) {
        const message = String(redactSensitiveText(errorMessage || "rclone failed") || "rclone failed");
        const failureMetadata = resolveRcloneFailureMetadata({ error: message }, {
            operation: "rcat",
            remotePathScoped: true
        });
        return {
            success: false,
            error: message,
            ...failureMetadata
        };
    }

    async _cleanupRemote(fileName, userId, reason) {
        if (!fileName || typeof this.cloudTool.deleteRemoteFile !== "function") return;
        if (!this._isManagedStagingFile(fileName)) {
            log.warn("Refusing to cleanup non-staging direct-transfer remote file", {
                fileName,
                userId,
                reason
            });
            return;
        }
        try {
            const result = await this.cloudTool.deleteRemoteFile(fileName, userId);
            if (!result?.success) {
                log.warn("Failed to cleanup direct-transfer remote staging file", {
                    fileName,
                    userId,
                    reason,
                    error: redactSensitiveText(result?.error || "delete remote staging file failed")
                });
            }
        } catch (error) {
            log.warn("Direct-transfer remote cleanup threw", {
                fileName,
                userId,
                reason,
                error: redactSensitiveText(error?.message || String(error))
            });
        }
    }

    async _waitForRemoteValidation(fileName, userId, expectedSize) {
        const attempts = 5;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const remoteFile = await this.cloudTool.getRemoteFileInfo(fileName, userId, attempt === attempts ? 2 : 1);
            if (this._isSizeMatch(remoteFile?.Size, expectedSize)) {
                return remoteFile;
            }

            if (attempt < attempts) {
                await this._delay(attempt * this.validationRetryDelayMs);
            }
        }

        return await this.cloudTool.getRemoteFileInfo(fileName, userId, 2);
    }

    _isManagedStagingFile(fileName) {
        return MANAGED_STAGING_FILE_PATTERN.test(String(fileName || ""));
    }

    _getStagingCreatedAt(fileName) {
        const matched = MANAGED_STAGING_FILE_PATTERN.exec(String(fileName || ""));
        return matched ? Number(matched[1]) : null;
    }

    /**
     * 清掉上一次进程被杀(部署重启/OOM/实例切换)时留在用户网盘里的半截 staging 文件。
     *
     * 失败当场的那次清理只覆盖"进程活着走到 catch"的路径;进程中途没了,这些 .part. 文件
     * 就永久留着——用户转存的都是几百 MB 起步的大文件,砍几次就把网盘塞满,Proton 直接
     * 200002,之后所有任务全挂。只删我们自己这个命名格式、且创建时间超过 maxAgeMs 的:
     * 在途传输的时间戳是新的,天然碰不到;用户自己的文件根本不符合格式。
     */
    async sweepOrphanStagingFiles({
        userId,
        maxAgeMs = DEFAULT_ORPHAN_STAGING_MAX_AGE_MS,
        now = Date.now()
    } = {}) {
        const empty = { deleted: 0, failed: 0 };
        if (!userId || typeof this.cloudTool?.listRemoteFiles !== "function") return empty;

        let files;
        try {
            files = await this.cloudTool.listRemoteFiles(userId);
        } catch (error) {
            log.warn("孤儿 staging 扫描失败,跳过清理", {
                userId,
                error: redactSensitiveText(error?.message || String(error))
            });
            return empty;
        }

        let deleted = 0;
        let failed = 0;
        for (const file of Array.isArray(files) ? files : []) {
            if (file?.IsDir) continue;
            const createdAt = this._getStagingCreatedAt(file?.Name);
            if (!createdAt || now - createdAt < maxAgeMs) continue;

            try {
                const result = await this.cloudTool.deleteRemoteFile(file.Name, userId);
                if (result?.success) {
                    deleted++;
                    log.info("已清理遗留的直传临时文件", {
                        userId,
                        fileName: file.Name,
                        sizeBytes: file.Size,
                        ageMs: now - createdAt
                    });
                } else {
                    failed++;
                    log.warn("清理遗留直传临时文件失败", {
                        userId,
                        fileName: file.Name,
                        error: redactSensitiveText(result?.error || "delete remote staging file failed")
                    });
                }
            } catch (error) {
                failed++;
                log.warn("清理遗留直传临时文件抛错", {
                    userId,
                    fileName: file.Name,
                    error: redactSensitiveText(error?.message || String(error))
                });
            }
        }

        if (deleted || failed) {
            log.info("遗留直传临时文件清理完成", { userId, deleted, failed });
        }
        return { deleted, failed };
    }

    _delay(ms) {
        if (!ms) return Promise.resolve();
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    _buildExistingRemoteResult(fileName, totalSize, uploadedBytes = 0) {
        return {
            success: true,
            method: "remote_existing",
            fileName,
            bytes: totalSize || uploadedBytes
        };
    }

    _resolveTransferTimeoutMs(config) {
        const value = Number(config?.directTransfer?.timeoutMs);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_TRANSFER_TIMEOUT_MS;
    }

    _resolveStallTimeoutMs(config) {
        const value = Number(config?.directTransfer?.stallTimeoutMs);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALL_TIMEOUT_MS;
    }

    _resolveMinStallTimeoutMs(config) {
        const value = Number(config?.directTransfer?.minStallTimeoutMs);
        return Number.isFinite(value) && value >= 0 ? value : undefined;
    }

    _resolveMaxAttempts(config) {
        const value = Number(config?.directTransfer?.maxAttempts);
        return Number.isFinite(value) && value > 0
            ? Math.floor(value)
            : DEFAULT_MAX_DIRECT_ATTEMPTS;
    }

    _resolveRetryDelayMs(config) {
        const value = Number(config?.directTransfer?.retryDelayMs);
        return Number.isFinite(value) && value >= 0
            ? Math.floor(value)
            : DEFAULT_DIRECT_RETRY_DELAY_MS;
    }

    _isSizeMatch(actual, expected) {
        const actualSize = Number(actual);
        const expectedSize = Number(expected);
        if (!Number.isFinite(expectedSize) || expectedSize <= 0) return Number.isFinite(actualSize);
        return Number.isFinite(actualSize) && actualSize === expectedSize;
    }
}

class DirectTransferFallbackError extends Error {
    constructor(message, metadata = {}) {
        super(message);
        this.name = "DirectTransferFallbackError";
        this.code = "DIRECT_TRANSFER_FALLBACK";
        this.errorCode = metadata.errorCode;
        this.userMessage = metadata.userMessage;
        this.retryable = metadata.retryable;
        this.userRetryable = metadata.userRetryable;
    }
}

class DirectTransferStallError extends Error {
    constructor(message, metadata = {}) {
        super(message);
        this.name = "DirectTransferStallError";
        this.code = "DIRECT_TRANSFER_STALL_TIMEOUT";
        this.errorCode = RCLONE_ERROR_CODES.RCLONE_TRANSIENT;
        this.retryable = true;
        this.userRetryable = true;
        this.phase = metadata.phase;
        this.timeoutMs = metadata.timeoutMs;
    }
}

export { TransferSpeedMonitor };
export const directTransferService = new DirectTransferService();
