import { once } from "events";
import path from "path";
import { randomUUID } from "crypto";
import { getConfig } from "../config/index.js";
import { CloudTool } from "./rclone.js";
import { logger } from "./logger/index.js";
import { redactSensitiveText } from "../utils/serializer.js";

const log = logger.withModule ? logger.withModule("DirectTransferService") : logger;

const DEFAULT_SMALL_CHUNK_SIZE = 128 * 1024;
const DEFAULT_LARGE_CHUNK_SIZE = 512 * 1024;
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
const MAX_RCLONE_ERROR_LOG = 8000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const LOCAL_STAGING_REQUIRED_DRIVE_TYPES = new Set(["oss", "r2", "s3"]);

export class DirectTransferService {
    constructor(cloudTool = CloudTool, options = {}) {
        this.cloudTool = cloudTool;
        this.validationRetryDelayMs = Number.isFinite(options.validationRetryDelayMs)
            ? Math.max(0, options.validationRetryDelayMs)
            : 1000;
    }

    canAttempt(config = getConfig(), options = {}) {
        if (config.directTransfer?.enabled === false) {
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

    async transferTelegramMediaToRemote({
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
            return { success: false, fallback: true, reason: capability.reason };
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

        if (existingRemoteFile === undefined) {
            existingRemoteFile = await this.cloudTool.getRemoteFileInfo(finalFileName, task.userId, 1, true);
        }
        if (existingRemoteFile) {
            if (this._isSizeMatch(existingRemoteFile.Size, totalSize)) {
                return this._buildExistingRemoteResult(finalFileName, totalSize, uploadedBytes);
            }
            return { success: false, fallback: true, reason: "remote-name-conflict" };
        }

        try {
            const rcat = await this.cloudTool.createRcatStream(stagingFileName, task.userId, { size: totalSize });
            stdin = rcat.stdin;
            proc = rcat.proc;
            const remoteStagingName = rcat.fileName;
            stagedRemoteName = remoteStagingName || stagingFileName;
            const transferTimeoutMs = this._resolveTransferTimeoutMs(config);
            const rcloneCompletion = this._watchRcloneProcess(proc, task.id, transferTimeoutMs);

            const downloadIterator = client.iterDownload({
                file: message.media,
                requestSize: effectiveChunkSize,
                chunkSize: effectiveChunkSize,
                stride: effectiveChunkSize
            });

            for await (const chunk of downloadIterator) {
                if (isCancelled?.()) {
                    throw new Error("CANCELLED");
                }
                await this._writeWithBackpressure(stdin, chunk);
                uploadedBytes += chunk.length;
                await onProgress?.({
                    bytes: Math.min(uploadedBytes, totalSize || uploadedBytes),
                    size: totalSize || uploadedBytes,
                    method: "direct_stream"
                });
            }

            await this._endWritable(stdin);
            const rcloneResult = await rcloneCompletion;
            if (!rcloneResult.success) {
                throw new DirectTransferFallbackError(rcloneResult.error || "rclone rcat failed");
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
            this._abortRclone(stdin, proc);
            if (!movedToFinal) {
                await this._cleanupRemote(stagedRemoteName, task.userId, "transfer_failed");
            }
            if (error?.message === "CANCELLED") {
                throw error;
            }

            const fallbackAllowed = config.directTransfer?.fallbackToLocal !== false;
            const message = redactSensitiveText(error?.message || String(error));
            if (!fallbackAllowed) {
                return { success: false, fallback: false, error: message };
            }

            log.warn("Direct transfer failed; falling back to local staging", {
                taskId: task.id,
                fileName,
                reason: message
            });
            return { success: false, fallback: true, error: message };
        }
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
                    safeResolve({ success: false, error: `rclone rcat timed out after ${timeoutMs}ms` });
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
                safeResolve({ success: false, error: errorTail || `rclone rcat exited with code ${code}` });
            });

            proc.on("error", (error) => {
                safeResolve({ success: false, error: redactSensitiveText(error.message) });
            });
        }).catch((error) => {
            log.warn("Direct transfer rclone watcher failed", { taskId, error: redactSensitiveText(error.message) });
            return { success: false, error: redactSensitiveText(error.message) };
        });
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
                    error: result?.error
                });
            }
        } catch (error) {
            log.warn("Direct-transfer remote cleanup threw", {
                fileName,
                userId,
                reason,
                error: error.message
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

    _isSizeMatch(actual, expected) {
        const actualSize = Number(actual);
        const expectedSize = Number(expected);
        if (!Number.isFinite(expectedSize) || expectedSize <= 0) return Number.isFinite(actualSize);
        return Number.isFinite(actualSize) && actualSize === expectedSize;
    }
}

class DirectTransferFallbackError extends Error {
    constructor(message) {
        super(message);
        this.name = "DirectTransferFallbackError";
        this.code = "DIRECT_TRANSFER_FALLBACK";
    }
}

export const directTransferService = new DirectTransferService();
