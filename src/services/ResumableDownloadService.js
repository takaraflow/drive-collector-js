import fs from "fs";
import { once } from "events";
import bigInt from "big-integer";
import { logger } from "./logger/index.js";

const log = logger.withModule
    ? logger.withModule("ResumableDownloadService")
    : logger;

const DEFAULT_SMALL_CHUNK_SIZE = 128 * 1024;
const DEFAULT_LARGE_CHUNK_SIZE = 512 * 1024;
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;
const DEFAULT_STAGING_TTL_MS = 24 * 60 * 60 * 1000;
const PART_SUFFIX = ".part";

/**
 * 可断点续传的本地暂存下载。
 *
 * 设计要点(与用户约束对齐):
 * - 进度 = 本地 .part 文件的大小,不额外记 D1。换机器时新 pod 上没有 .part → 从头下,
 *   天然正确,不会误判"已下完"。
 * - .part 半成品设 TTL(默认 24h)定时清理,避免占满盘。清理是机会式的(每次下载入口扫一遍),
 *   不新起后台 timer,避免幽灵进程。
 * - gramjs 的 downloadMedia 是截断重写(每次重试从 0 开始),扛不住 Telegram 连接慢性断连;
 *   这里用 iterDownload({offset}) 边下边 append,断了下次从 .part 末尾接着下。
 */
export class ResumableDownloadService {
    constructor({ fsImpl = fs } = {}) {
        this.fs = fsImpl;
    }

    _resolveChunkSize(chunkSize, totalSize) {
        if (Number.isFinite(chunkSize) && chunkSize > 0) return chunkSize;
        return totalSize > LARGE_FILE_THRESHOLD
            ? DEFAULT_LARGE_CHUNK_SIZE
            : DEFAULT_SMALL_CHUNK_SIZE;
    }

    /**
     * 下载到本地 localPath。成功后 .part 会被 rename 成 localPath。
     * @returns {{success:true, localPath:string, bytes:number, resumedFrom:number}}
     * @throws 下载中断/不完整时抛出可重试错误(.part 保留供下次续传)
     */
    async downloadToLocal({
        client,
        message,
        info,
        localPath,
        chunkSize,
        onProgress,
        isCancelled,
    }) {
        const totalSize = Number(info?.size || 0);
        const partPath = `${localPath}${PART_SUFFIX}`;
        const effChunk = this._resolveChunkSize(chunkSize, totalSize);

        // 从已有 .part 恢复进度,对齐到 chunk 边界(丢弃可能不完整的尾块,保证 append 干净)。
        let startOffset = 0;
        try {
            const st = await this.fs.promises.stat(partPath);
            startOffset = Math.floor(st.size / effChunk) * effChunk;
            if (totalSize > 0 && startOffset >= totalSize) {
                // .part 已 >= 目标大小(异常/旧残留),从头来。
                startOffset = 0;
            }
            if (startOffset !== st.size) {
                await this.fs.promises.truncate(partPath, startOffset);
            }
        } catch {
            startOffset = 0; // 无 .part → 从头下
        }

        const remaining =
            totalSize > 0 ? Math.max(0, totalSize - startOffset) : 0;
        if (totalSize > 0 && remaining === 0 && startOffset > 0) {
            // .part 恰好等于目标大小 → 直接完成
            await this.fs.promises.rename(partPath, localPath);
            return {
                success: true,
                localPath,
                bytes: startOffset,
                resumedFrom: startOffset,
            };
        }

        log.info("Resumable local staging download start", {
            localPath,
            totalSize,
            startOffset,
            chunkSize: effChunk,
        });

        const ws = this.fs.createWriteStream(partPath, {
            flags: startOffset > 0 ? "a" : "w",
        });
        let written = startOffset;
        try {
            const downloadOptions = {
                file: message.media,
                requestSize: effChunk,
                chunkSize: effChunk,
                stride: effChunk,
            };
            if (startOffset > 0) {
                downloadOptions.offset = bigInt(startOffset);
                if (totalSize > 0) {
                    downloadOptions.fileSize = bigInt(totalSize);
                    downloadOptions.limit = Math.ceil(remaining / effChunk);
                }
            }

            for await (const chunk of client.iterDownload(downloadOptions)) {
                if (isCancelled?.()) throw new Error("CANCELLED");
                await this._writeWithBackpressure(ws, chunk);
                written += chunk.length;
                await onProgress?.({
                    bytes:
                        totalSize > 0 ? Math.min(written, totalSize) : written,
                    size: totalSize > 0 ? totalSize : written,
                    method: "resumable_local_staging",
                });
            }

            await this._endWritable(ws);

            const finalSize = (await this.fs.promises.stat(partPath)).size;
            if (totalSize > 0 && finalSize !== totalSize) {
                const err = new Error(
                    `Resumable download incomplete: local(${finalSize}) vs expected(${totalSize})`,
                );
                err.retryable = true;
                err.userRetryable = true;
                throw err;
            }

            await this.fs.promises.rename(partPath, localPath);
            log.info("Resumable local staging download complete", {
                localPath,
                bytes: finalSize,
                resumedFrom: startOffset,
            });
            return {
                success: true,
                localPath,
                bytes: finalSize,
                resumedFrom: startOffset,
            };
        } catch (error) {
            // 保留 .part 供下次续传:优雅 end() 把缓冲字节 flush 到盘,不能 destroy(会丢缓冲)。
            try {
                await this._endWritable(ws);
            } catch {
                /* end 失败也不删 .part,已落盘部分仍可续 */
            }
            if (
                error?.message !== "CANCELLED" &&
                error?.retryable === undefined
            ) {
                // Telegram 断连类错误默认可重试(下次从 .part 续)
                error.retryable = true;
            }
            throw error;
        }
    }

    async _writeWithBackpressure(writable, chunk) {
        const canContinue = writable.write(chunk);
        if (!canContinue) {
            await Promise.race([
                once(writable, "drain"),
                once(writable, "error").then(([err]) => {
                    throw err;
                }),
            ]);
        }
    }

    async _endWritable(writable) {
        if (!writable || writable.destroyed || writable.closed) return;
        await new Promise((resolve, reject) => {
            const cleanup = () => {
                writable.off?.("error", onError);
                writable.off?.("finish", onFinish);
            };
            const onError = (err) => {
                cleanup();
                reject(err);
            };
            const onFinish = () => {
                cleanup();
                resolve();
            };
            writable.once("error", onError);
            writable.once("finish", onFinish);
            writable.end();
        });
    }

    /**
     * 机会式清理过期 .part 半成品(TTL 默认 24h)。在下载入口调用,不新起 timer。
     * 只删本 pod 本地盘上的 .part,进度丢失即从头下,符合"换机器"约束。
     */
    async cleanupStalePartFiles(dir, ttlMs = DEFAULT_STAGING_TTL_MS) {
        if (!dir) return { removed: 0 };
        let removed = 0;
        try {
            const entries = await this.fs.promises.readdir(dir);
            const now = Date.now();
            for (const name of entries) {
                if (!name.endsWith(PART_SUFFIX)) continue;
                const full = `${dir}/${name}`;
                try {
                    const st = await this.fs.promises.stat(full);
                    if (now - st.mtimeMs > ttlMs) {
                        await this.fs.promises.unlink(full);
                        removed++;
                        log.info("Removed stale local staging part file", {
                            file: full,
                            ageMs: now - st.mtimeMs,
                        });
                    }
                } catch {
                    /* 单个文件失败不影响整体 */
                }
            }
        } catch (e) {
            log.warn("Stale part cleanup skipped", { dir, error: e.message });
        }
        return { removed };
    }
}

export const resumableDownloadService = new ResumableDownloadService();
