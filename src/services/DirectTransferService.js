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
const DEFAULT_MAX_DIRECT_ATTEMPTS = 3;
const DEFAULT_DIRECT_RETRY_DELAY_MS = 1000;
const RCLONE_DIAGNOSTIC_GRACE_MS = 1500;
const LOCAL_STAGING_REQUIRED_DRIVE_TYPES = new Set(["oss", "r2", "s3"]);
const TELEGRAM_SOURCE_TRANSIENT_ERROR_CODE = "TELEGRAM_SOURCE_TRANSIENT";
const TELEGRAM_SOURCE_TRANSIENT_ERROR_PATTERNS = [
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

            log.info("Retrying direct transfer after retryable failure", {
                taskId: args?.task?.id,
                userId: args?.task?.userId,
                fileName: args?.fileName,
                attempt,
                maxAttempts,
                errorCode: lastResult.errorCode,
                reason: redactSensitiveText(lastResult.error || lastResult.reason || "retryable direct transfer failure")
            });

            await this._delay(retryDelayMs * attempt);
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
        const stagingFileName = this._buildStagingFileName(task.id, finalFileName);
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
            rcloneCompletion = this._watchRcloneProcess(proc, task.id, transferTimeoutMs);

            const downloadIterator = client.iterDownload({
                file: message.media,
                requestSize: effectiveChunkSize,
                chunkSize: effectiveChunkSize,
                stride: effectiveChunkSize
            });
            sourceIterator = downloadIterator?.[Symbol.asyncIterator]?.() || downloadIterator;

            while (true) {
                let nextChunk;
                try {
                    nextChunk = await this._withStallTimeout(
                        () => sourceIterator.next(),
                        {
                            taskId: task.id,
                            timeoutMs: stallTimeoutMs,
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
                        timeoutMs: stallTimeoutMs,
                        phase: "rclone_stdin",
                        onTimeout: () => this._abortRclone(stdin, proc)
                    }
                );
                uploadedBytes += chunk.length;
                await this._withStallTimeout(
                    () => onProgress?.({
                        bytes: Math.min(uploadedBytes, totalSize || uploadedBytes),
                        size: totalSize || uploadedBytes,
                        method: "direct_stream"
                    }),
                    {
                        taskId: task.id,
                        timeoutMs: stallTimeoutMs,
                        phase: "progress_callback",
                        onTimeout: () => this._abortRclone(stdin, proc)
                    }
                );
            }

            await this._withStallTimeout(
                () => this._endWritable(stdin),
                {
                    taskId: task.id,
                    timeoutMs: stallTimeoutMs,
                    phase: "rclone_stdin_end",
                    onTimeout: () => this._abortRclone(stdin, proc)
                }
            );
            const rcloneResult = await this._withStallTimeout(
                () => rcloneCompletion,
                {
                    taskId: task.id,
                    timeoutMs: stallTimeoutMs,
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
                    await this._cleanupRemote(stagedRemoteName, task.userId, "remote_completed_concurrently");
                    return this._buildExistingRemoteResult(finalFileName, totalSize, uploadedBytes);
                }
                throw new DirectTransferFallbackError(
                    `Remote file name conflict before finalize: local(${totalSize}) vs remote(${preMoveRemote.Size ?? "unknown"})`
                );
            }

            const moveResult = await this.cloudTool.moveRemoteFile(stagedRemoteName, finalFileName, task.userId);
            if (!moveResult?.success) {
                throw new DirectTransferFallbackError(moveResult?.error || "rclone moveto failed");
            }
            movedToFinal = true;

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
            if (!movedToFinal) {
                await this._cleanupRemote(stagedRemoteName, task.userId, "transfer_failed");
            }
            if (error?.message === "CANCELLED") {
                throw error;
            }

            const effectiveError = rcloneFailure?.success === false ? rcloneFailure : error;
            const message = redactSensitiveText(effectiveError?.error || effectiveError?.message || String(effectiveError));
            if (!rcloneFailure && effectiveError?.retryScope === "telegram_source") {
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
            if (!fallbackAllowed || isPermanentDriveFailure) {
                return { success: false, fallback: false, error: message, ...failureMetadata };
            }

            return { success: false, fallback: true, error: message, ...failureMetadata };
        }
    }

    _isTelegramSourceTransientError(error) {
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

        const message = String(error?.message || error || "");
        const isLikelyRclonePipeFailure = /EPIPE|ERR_STREAM_DESTROYED|write after end|stdin is not writable/i.test(message);
        if (!isLikelyRclonePipeFailure) return null;

        try {
            const result = await Promise.race([
                rcloneCompletion,
                this._delay(RCLONE_DIAGNOSTIC_GRACE_MS).then(() => null)
            ]);
            if (result?.success === false) return result;
        } catch (watchError) {
            log.warn("Direct transfer failed to resolve rclone diagnostic after stream write error", {
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

            proc.on("close", (code) => {
                const hasErrors = /(^|\b)(ERROR|Failed|failed|error)(\b|:)/.test(stderrLog || "");
                if (code === 0 && !hasErrors) {
                    safeResolve({ success: true });
                    return;
                }
                const errorTail = redactSensitiveText(stderrLog.slice(-500).trim());
                safeResolve(this._buildRcloneFailure(errorTail || `rclone rcat exited with code ${code}`));
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
        return /^\.drive-collector-[a-zA-Z0-9_-]+-\d+-[0-9a-f-]{36}\.part\./.test(String(fileName || ""));
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

export const directTransferService = new DirectTransferService();
