import { config } from "../config/index.js";
import { logger } from "./logger/index.js";
import { CloudTool } from "./rclone.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import { updateStatus, escapeHTML, sanitizeHeaders } from "../utils/common.js";
import { TaskRepository } from "../repositories/TaskRepository.js";
import { TelegramBotApi } from "../utils/telegramBotApi.js";
import { CacheService } from "./CacheService.js";

const log = logger.withModule('StreamTransferService');

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
        this.maxRetryAttempts = 3;
        this.progressCacheTTL = 3600; // 1小时
    }

    /**
     * Sender (Leader): 转发一个 chunk 到 LB/Worker (支持断点续传)
     */
    async forwardChunk(taskId, chunk, metadata) {
        const { fileName, userId, isLast, chunkIndex, totalSize, leaderUrl, chatId, msgId, sourceMsgId } = metadata;
        const lbUrl = config.streamForwarding.lbUrl;
        
        if (!lbUrl) {
            throw new Error("STREAM_LB_URL (LB_WEBHOOK_URL) not configured");
        }

        // 检查重试次数
        const retryKey = `${taskId}:${chunkIndex}`;
        const currentAttempts = this.chunkRetryAttempts.get(retryKey) || 0;
        if (currentAttempts >= this.maxRetryAttempts) {
            log.error(`Max retry attempts reached for chunk ${chunkIndex}, skipping.`);
            return false;
        }

        // 先检查远程进度，避免不必要的传输
        try {
            const remoteProgress = await this.getRemoteProgress(lbUrl, taskId);
            if (remoteProgress >= chunkIndex) {
                log.info(`Chunk ${chunkIndex} already received by worker (progress: ${remoteProgress}), skipping.`);
                // 清除重试计数
                this.chunkRetryAttempts.delete(retryKey);
                return true;
            }
        } catch (queryError) {
            log.debug(`Failed to query remote progress before sending: ${queryError.message}`);
        }

        const url = `${lbUrl.replace(/\/$/, '')}/api/v2/stream/${taskId}`;
        
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    'x-instance-secret': config.streamForwarding.secret,
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
                    // 断点续传标识头
                    'x-resume-enabled': 'true'
                },
                body: chunk,
                // 增加超时时间
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

            // 如果是网络超时，再次查询进度
            if (error.name === 'AbortError' || error.message.includes('timeout')) {
                try {
                    const remoteProgress = await this.getRemoteProgress(lbUrl, taskId);
                    if (remoteProgress >= chunkIndex) {
                        log.info(`Chunk ${chunkIndex} was received despite timeout (progress: ${remoteProgress}), skipping retry.`);
                        this.chunkRetryAttempts.delete(retryKey);
                        return true;
                    }
                } catch (queryError) {
                    log.warn(`Failed to query remote progress after timeout: ${queryError.message}`);
                }
            }

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
                'x-instance-secret': config.streamForwarding.secret
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

    /**
     * Receiver (Worker): 处理接收到的 chunk (支持断点续传)
     */
    async handleIncomingChunk(taskId, req) {
        // 校验秘钥
        const secret = req.headers['x-instance-secret'];
        if (secret !== config.streamForwarding.secret) {
            return { success: false, statusCode: 401, message: "Unauthorized" };
        }

        const metadata = this._extractChunkMetadata(req.headers);
        metadata.leaderUrl = await this._resolveLeaderUrl(metadata.leaderUrl, metadata.sourceInstanceId);

        let streamContext = this.activeStreams.get(taskId);

        try {
            // 断点续传：从缓存恢复进度信息
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

            // 断点续传检查：如果当前 chunkIndex 超过预期的下一个 chunk，可能是丢失了中间的 chunk
            const expectedChunkIndex = streamContext.lastChunkIndex + 1;
            if (metadata.chunkIndex > expectedChunkIndex && metadata.isResumeEnabled) {
                log.warn(`⚠️ Chunk 跳跃检测: 期望 ${expectedChunkIndex}, 收到 ${metadata.chunkIndex}, 可能存在丢包`);
                // 仍然继续处理，但记录警告
            }

            // 获取 Body 数据 (Node.js req is a Readable Stream)
            for await (const chunk of req) {
                streamContext.stdin.write(chunk);
                streamContext.uploadedBytes += chunk.length;
            }
            streamContext.lastSeen = Date.now();
            streamContext.lastChunkIndex = metadata.chunkIndex;

            await this._handlePeriodicTasks(taskId, streamContext, metadata.chunkIndex, metadata.isLast);

            if (metadata.isLast) {
                log.info(`🏁 任务数据接收完成: ${taskId}`);
                streamContext.stdin.end();
            }

            return { success: true, statusCode: 200 };
        } catch (error) {
            log.error(`Error handling incoming chunk for ${taskId}:`, error);
            if (streamContext) {
                streamContext.stdin.end();
                this.activeStreams.delete(taskId);
            }
            return { success: false, statusCode: 500, message: error.message };
        }
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
            isResumeEnabled: headers['x-resume-enabled'] === 'true'
        };
    }

    async _resolveLeaderUrl(leaderUrl, sourceInstanceId) {
        if (!leaderUrl && sourceInstanceId) {
            try {
                const instances = await instanceCoordinator.getAllInstances();
                const leader = instances.find(inst => inst.id === sourceInstanceId);
                if (leader) {
                    return leader.tunnelUrl || leader.url;
                }
            } catch (e) {
                log.warn(`Failed to lookup leader URL from cache: ${e.message}`);
            }
        }
        return leaderUrl;
    }

    async _initializeStreamContext(taskId, metadata) {
        const cachedProgress = await this.loadProgressFromCache(taskId);

        log.info(`📦 接收到新流式任务: ${taskId} (${metadata.fileName})${cachedProgress ? ` (resume from chunk ${cachedProgress.lastChunkIndex})` : ''}`);
        const { stdin, proc } = await CloudTool.createRcatStream(metadata.fileName, metadata.userId);

        const streamContext = {
            stdin,
            proc,
            lastSeen: Date.now(),
            fileName: metadata.fileName,
            userId: metadata.userId,
            totalSize: metadata.totalSize,
            leaderUrl: metadata.leaderUrl,
            chatId: metadata.chatId,
            msgId: metadata.msgId,
            sourceMsgId: metadata.sourceMsgId,
            uploadedBytes: cachedProgress?.uploadedBytes || 0,
            status: 'uploading',
            lastChunkIndex: cachedProgress?.lastChunkIndex || -1, // 记录最近处理的 Chunk Index
            resumeMode: !!cachedProgress
        };
        this.activeStreams.set(taskId, streamContext);

        // 监听 rclone 错误
        proc.stderr.on('data', (data) => {
            const msg = data.toString();
            log.error(`rclone rcat error [${taskId}]:`, msg);
        });

        proc.on('close', async (code) => {
            log.info(`rclone rcat exited with code ${code} for task ${taskId}`);
            this.activeStreams.delete(taskId);
            // 清理缓存
            await this.clearProgressFromCache(taskId);

            if (code === 0) {
                await this.finishTask(taskId, streamContext);
            } else {
                await this.reportError(taskId, streamContext, `rclone exited with code ${code}`);
            }
        });

        return streamContext;
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
                    'x-instance-secret': config.streamForwarding.secret
                },
                body: JSON.stringify({
                    uploadedBytes: context.uploadedBytes,
                    totalSize: context.totalSize,
                    status: context.status
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
        const secret = headers['x-instance-secret'];
        if (secret !== config.streamForwarding.secret) {
            return { success: false, statusCode: 401, message: "Unauthorized" };
        }

        const { status, error } = reqBody;
        
        if (status === 'completed' || status === 'failed') {
            await TaskRepository.updateStatus(taskId, status, error);
        }

        return { success: true, statusCode: 200 };
    }

    /**
     * 断点续传：恢复任务传输
     */
    async resumeTask(taskId, metadata) {
        try {
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
    async resetTask(taskId) {
        try {
            // 清理活动流
            const context = this.activeStreams.get(taskId);
            if (context) {
                context.stdin.end();
                context.proc.kill();
                this.activeStreams.delete(taskId);
            }

            // 清理缓存
            await this.clearProgressFromCache(taskId);

            // 清理重试计数
            for (const key of this.chunkRetryAttempts.keys()) {
                if (key.startsWith(`${taskId}:`)) {
                    this.chunkRetryAttempts.delete(key);
                }
            }

            log.info(`🗑️ Reset task ${taskId} - all state cleared`);
            return { success: true };
        } catch (error) {
            log.error(`Failed to reset task ${taskId}:`, error);
            return { success: false, error: error.message };
        }
    }

    /**
     * 任务完成后的处理 (Worker 端)
     */
    async finishTask(taskId, context) {
        log.info(`✅ 任务上传完成: ${taskId}`);
        await TaskRepository.updateStatus(taskId, 'completed');
        
        try {
            const { STRINGS, format } = await import("../locales/zh-CN.js");
            const originalMsgId = context.sourceMsgId || context.msgId;
            const fileLink = `tg://openmessage?chat_id=${context.chatId}&message_id=${originalMsgId}`;
            const fileNameHtml = `<a href="${fileLink}">${escapeHTML(context.fileName)}</a>`;
            const text = format(STRINGS.task.success, { name: fileNameHtml, folder: config.remoteFolder });
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
            await this.reportProgressToLeader(taskId, { ...context, status: 'completed' });
        }
    }

    async reportError(taskId, context, errorMsg) {
        log.error(`❌ 任务上传失败: ${taskId} - ${errorMsg}`);
        await TaskRepository.updateStatus(taskId, 'failed', errorMsg);
        
        try {
            const text = `❌ 上传失败: ${errorMsg}`;
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
            await this.reportProgressToLeader(taskId, { ...context, status: 'failed', error: errorMsg });
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
                timestamp: Date.now()
            };
            
            const cacheKey = `stream:progress:${taskId}`;
            await CacheService.set(cacheKey, progressData, this.progressCacheTTL);
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
            const cacheKey = `stream:progress:${taskId}`;
            const progressData = await CacheService.get(cacheKey);
            
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
            const cacheKey = `stream:progress:${taskId}`;
            await CacheService.delete(cacheKey);
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
            return {
                isActive: true,
                lastChunkIndex: context.lastChunkIndex,
                uploadedBytes: context.uploadedBytes,
                totalSize: context.totalSize,
                status: context.status
            };
        }

        // 如果不在内存中，尝试从缓存获取
        const cachedProgress = await this.loadProgressFromCache(taskId);
        if (cachedProgress) {
            return {
                isActive: false,
                isCached: true,
                lastChunkIndex: cachedProgress.lastChunkIndex,
                uploadedBytes: cachedProgress.uploadedBytes,
                totalSize: cachedProgress.totalSize,
                cachedAt: cachedProgress.timestamp
            };
        }

        return {
            isActive: false,
            isCached: false,
            lastChunkIndex: -1,
            uploadedBytes: 0,
            totalSize: 0
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
                context.stdin.end();
                context.proc.kill();
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
export default streamTransferService;