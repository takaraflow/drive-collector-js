import { config } from "../config/index.js";
import { logger } from "./logger/index.js";
import { CloudTool } from "./rclone.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import { updateStatus } from "../utils/common.js";
import { TaskRepository } from "../repositories/TaskRepository.js";
import { TelegramBotApi } from "../utils/telegramBotApi.js";

const log = logger.withModule('StreamTransferService');

/**
 * 实时流式转发服务 (StreamTransferService)
 * 负责在多实例环境下，由 Leader 转发 Telegram 下载流给 Worker 实例进行上传
 */
class StreamTransferService {
    constructor() {
        this.activeStreams = new Map(); // Worker 端：taskId -> { stdin, proc, lastSeen, fileName, userId, totalBytes, chatId, msgId }
        this.cleanupInterval = setInterval(() => this.cleanupStaleStreams(), 60000);
    }

    /**
     * Sender (Leader): 转发一个 chunk 到 LB/Worker
     */
    async forwardChunk(taskId, chunk, metadata) {
        const { fileName, userId, isLast, chunkIndex, totalSize, leaderUrl, chatId, msgId } = metadata;
        const lbUrl = config.streamForwarding.lbUrl;
        
        if (!lbUrl) {
            throw new Error("STREAM_LB_URL (LB_WEBHOOK_URL) not configured");
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
                    'x-total-size': totalSize.toString(),
                    'x-leader-url': leaderUrl || '',
                    'x-source-instance-id': instanceCoordinator.instanceId,
                    'x-chat-id': chatId || '',
                    'x-msg-id': msgId || ''
                },
                body: chunk
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Worker responded with ${response.status}: ${errorText}`);
            }

            return true;
        } catch (error) {
            log.error(`Failed to forward chunk ${chunkIndex} for task ${taskId}:`, error);
            throw error;
        }
    }

    /**
     * Receiver (Worker): 处理接收到的 chunk
     */
    async handleIncomingChunk(taskId, req) {
        // 校验秘钥
        const secret = req.headers['x-instance-secret'];
        if (secret !== config.streamForwarding.secret) {
            return { success: false, statusCode: 401, message: "Unauthorized" };
        }

        const fileName = decodeURIComponent(req.headers['x-file-name']);
        const userId = req.headers['x-user-id'];
        const isLast = req.headers['x-is-last'] === 'true';
        const chunkIndex = parseInt(req.headers['x-chunk-index']);
        const totalSize = parseInt(req.headers['x-total-size']);
        let leaderUrl = req.headers['x-leader-url'];
        const sourceInstanceId = req.headers['x-source-instance-id'];
        const chatId = req.headers['x-chat-id'];
        const msgId = req.headers['x-msg-id'];

        // 增强：如果请求头没带 leaderUrl，尝试从 Cache 中根据 sourceInstanceId 查找
        if (!leaderUrl && sourceInstanceId) {
            try {
                const instances = await instanceCoordinator.getAllInstances();
                const leader = instances.find(inst => inst.id === sourceInstanceId);
                if (leader) {
                    leaderUrl = leader.tunnelUrl || leader.url;
                }
            } catch (e) {
                log.warn(`Failed to lookup leader URL from cache: ${e.message}`);
            }
        }

        let streamContext = this.activeStreams.get(taskId);

        try {
            if (!streamContext) {
                log.info(`📦 接收到新流式任务: ${taskId} (${fileName})`);
                const { stdin, proc } = await CloudTool.createRcatStream(fileName, userId);
                
                streamContext = {
                    stdin,
                    proc,
                    lastSeen: Date.now(),
                    fileName,
                    userId,
                    totalSize,
                    leaderUrl,
                    chatId,
                    msgId,
                    uploadedBytes: 0,
                    status: 'uploading'
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
                    
                    if (code === 0) {
                        await this.finishTask(taskId, streamContext);
                    } else {
                        await this.reportError(taskId, streamContext, `rclone exited with code ${code}`);
                    }
                });
            }

            // 获取 Body 数据 (Node.js req is a Readable Stream)
            for await (const chunk of req) {
                streamContext.stdin.write(chunk);
                streamContext.uploadedBytes += chunk.length;
            }
            streamContext.lastSeen = Date.now();

            // 定期更新 Telegram UI (使用 Bot API)
            if (chunkIndex % 20 === 0 || isLast) {
                await this.updateTelegramUI(taskId, streamContext);
            }

            // 定期上报进度到 Leader (用于 Leader 端的任务追踪)
            if (chunkIndex % 50 === 0 || isLast) {
                await this.reportProgressToLeader(taskId, streamContext);
            }

            if (isLast) {
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

    /**
     * Worker 直接调用 Bot API 更新界面
     */
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
     * 任务完成后的处理 (Worker 端)
     */
    async finishTask(taskId, context) {
        log.info(`✅ 任务上传完成: ${taskId}`);
        await TaskRepository.updateStatus(taskId, 'completed');
        
        try {
            const { STRINGS, format } = await import("../locales/zh-CN.js");
            const fileLink = `tg://openmessage?chat_id=${context.chatId}&message_id=${context.msgId}`;
            const fileNameHtml = `<a href="${fileLink}">${encodeURIComponent(context.fileName)}</a>`;
            const text = format(STRINGS.task.success, { name: fileNameHtml, folder: config.remoteFolder });
            await TelegramBotApi.editMessageText(context.chatId, parseInt(context.msgId), text);
        } catch (e) {}

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
        } catch (e) {}

        if (context.leaderUrl) {
            await this.reportProgressToLeader(taskId, { ...context, status: 'failed', error: errorMsg });
        }
    }

    /**
     * 清理过期的流 (Worker 端)
     */
    cleanupStaleStreams() {
        const now = Date.now();
        const timeout = 300000; 
        
        for (const [taskId, context] of this.activeStreams.entries()) {
            if (now - context.lastSeen > timeout) {
                log.warn(`清理过期流任务: ${taskId}`);
                context.stdin.end();
                context.proc.kill();
                this.activeStreams.delete(taskId);
            }
        }
    }
}

export const streamTransferService = new StreamTransferService();
export default streamTransferService;