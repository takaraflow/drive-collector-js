import { Client, Receiver } from "@upstash/qstash";
import { config } from "../config/index.js";
import { logger } from "./logger.js";

/**
 * QStash 服务层
 * 封装 QStash 消息队列和发布订阅功能
 */
class QStashService {
    constructor() {
        // 检查 QStash 配置是否存在
        if (!config.qstash?.token) {
            logger.warn('⚠️ QStash Token 未找到，使用模拟模式。请设置 QSTASH_TOKEN 环境变量以启用真实功能。');
            this.client = null;
            this.isMockMode = true;
        } else {
            this.client = new Client({
                token: config.qstash.token
            });
            this.isMockMode = false;
        }

        // Topics 配置
        this.topics = {
            downloadTasks: "download-tasks",
            uploadTasks: "upload-tasks",
            systemEvents: "system-events"
        };

        // 初始化 QStash Receiver 用于签名验证
        this.receiver = new Receiver({
            currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
            nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY
        });

        logger.info(`[QStash] Service initialized (Mode: ${this.isMockMode ? 'Mock' : 'Real'})`);
    }

    /**
     * 检查是否为模拟模式
     */
    _checkMockMode() {
        if (this.isMockMode) {
            logger.info('📤 [模拟模式] QStash 未配置，跳过操作');
            return true;
        }
        return false;
    }

    /**
     * 发布消息到指定 topic（带重试逻辑）
     * @param {string} topic - 目标 topic
     * @param {object} message - 消息内容
     * @param {object} options - 发布选项（延迟等）
     */
    async publish(topic, message, options = {}) {
        if (this._checkMockMode()) {
            return { messageId: "mock-message-id" };
        }

        const maxAttempts = 3;
        const baseDelay = 500;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const result = await this._tryPublish(topic, message, options);
                return result;
            } catch (error) {
                // 如果是 4xx 错误（客户端错误），不重试
                if (error.message && (error.message.includes('400') || error.message.includes('401') || error.message.includes('403') || error.message.includes('422'))) {
                    logger.error(`[QStash] Publish failed with 4xx error, not retrying: ${error.message}`);
                    throw error;
                }

                // 如果是最后一次尝试，抛出错误
                if (attempt === maxAttempts) {
                    logger.error(`[QStash] Publish failed after ${maxAttempts} attempts: ${error.message}`);
                    throw error;
                }

                // 计算延迟时间：500ms * attempt
                const delay = baseDelay * attempt;
                logger.warn(`[QStash] Publish attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * 内部方法：单次尝试发布
     * @param {string} topic - 目标 topic
     * @param {object} message - 消息内容
     * @param {object} options - 发布选项
     */
    async _tryPublish(topic, message, options = {}) {
        const url = `${config.qstash.webhookUrl}/api/tasks/${topic}`;

        const publishOptions = {
            url,
            body: JSON.stringify(message),
            headers: {
                "Content-Type": "application/json"
            },
            ...options
        };

        const startTime = performance.now();
        logger.debug(`[QStash] Publishing to ${topic}, URL: ${url}, Payload: ${JSON.stringify(message)}`);

        try {
            const result = await this.client.publishJSON(publishOptions);
            const duration = performance.now() - startTime;
            logger.info(`[QStash] Published to ${topic}, MsgID: ${result.messageId}, Duration: ${duration.toFixed(2)}ms`);
            return result;
        } catch (error) {
            const duration = performance.now() - startTime;
            logger.error(`[QStash] Publish failed for ${topic}, Error: ${error.message}, Duration: ${duration.toFixed(2)}ms`, error);
            throw error;
        }
    }

    /**
     * 批量发布消息（带重试逻辑）
     * @param {Array<{topic: string, message: object, options?: object}>} messages
     */
    async batchPublish(messages) {
        if (this._checkMockMode()) {
            return messages.map(() => ({ status: "fulfilled", value: { messageId: "mock-message-id" } }));
        }

        const maxAttempts = 3;
        const baseDelay = 500;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const results = await this._tryBatchPublish(messages);
                
                // Check if any results are rejected
                const hasFailures = results.some(r => r.status === 'rejected');
                
                if (hasFailures) {
                    // Check if any failures are 4xx errors
                    const has4xxError = results.some(r => 
                        r.status === 'rejected' && 
                        r.reason?.message && 
                        (r.reason.message.includes('400') || r.reason.message.includes('401') || 
                         r.reason.message.includes('403') || r.reason.message.includes('422'))
                    );
                    
                    if (has4xxError) {
                        const firstError = results.find(r => r.status === 'rejected');
                        logger.error(`[QStash] Batch publish failed with 4xx error, not retrying: ${firstError.reason.message}`);
                        throw firstError.reason;
                    }
                    
                    // If it's the last attempt, throw error
                    if (attempt === maxAttempts) {
                        const firstError = results.find(r => r.status === 'rejected');
                        logger.error(`[QStash] Batch publish failed after ${maxAttempts} attempts`);
                        throw firstError.reason;
                    }
                    
                    // Retry
                    const delay = baseDelay * attempt;
                    logger.warn(`[QStash] Batch publish attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    // All succeeded
                    return results;
                }
            } catch (error) {
                // This catches errors from _tryBatchPublish itself (not individual message failures)
                // If it's a 4xx error, don't retry
                if (error.message && (error.message.includes('400') || error.message.includes('401') || error.message.includes('403') || error.message.includes('422'))) {
                    logger.error(`[QStash] Batch publish failed with 4xx error, not retrying: ${error.message}`);
                    throw error;
                }

                // If it's the last attempt, throw
                if (attempt === maxAttempts) {
                    logger.error(`[QStash] Batch publish failed after ${maxAttempts} attempts: ${error.message}`);
                    throw error;
                }

                // Retry
                const delay = baseDelay * attempt;
                logger.warn(`[QStash] Batch publish attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * 内部方法：单次尝试批量发布
     * @param {Array<{topic: string, message: object, options?: object}>} messages
     */
    async _tryBatchPublish(messages) {
        const publishPromises = messages.map(({ topic, message, options = {} }) =>
            this._tryPublish(topic, message, options)
        );

        try {
            const results = await Promise.allSettled(publishPromises);
            const successful = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;

            logger.info(`[QStash] Batch published: ${successful} successful, ${failed} failed`);

            if (failed > 0) {
                const failedReasons = results
                    .filter(r => r.status === 'rejected')
                    .map((r, index) => ({
                        index,
                        reason: r.reason?.message || r.reason
                    }));
                logger.error(`[QStash] Batch publish failures: ${JSON.stringify(failedReasons)}`);
            }

            return results;
        } catch (error) {
            logger.error('[QStash] Batch publish failed:', error);
            throw error;
        }
    }

    /**
     * 延迟发布消息（用于媒体组聚合）
     * @param {string} topic - 目标 topic
     * @param {object} message - 消息内容
     * @param {number} delaySeconds - 延迟秒数
     */
    async publishDelayed(topic, message, delaySeconds) {
        if (this._checkMockMode()) {
            return { messageId: "mock-message-id" };
        }

        return this.publish(topic, message, {
            delay: delaySeconds
        });
    }

    /**
     * 验证 QStash Webhook 签名
     * @param {string} signature - 请求头中的签名
     * @param {string} body - 请求体
     * @returns {Promise<boolean>} 签名是否有效
     */
    async verifyWebhookSignature(signature, body) {
        if (this.isMockMode) {
            logger.warn('⚠️ 处于模拟模式，跳过签名验证');
            return true; // 模拟模式跳过
        }

        try {
            await this.receiver.verify({
                signature,
                body
            });
            logger.info('[QStash] Signature verification successful');
            return true;
        } catch (error) {
            logger.error('[QStash] Signature verification failed', error);
            return false;
        }
    }

    /**
     * 发送下载任务消息
     * @param {string} taskId - 任务 ID
     * @param {object} taskData - 任务数据
     */
    async enqueueDownloadTask(taskId, taskData = {}) {
        return this.publish(this.topics.downloadTasks, {
            taskId,
            type: 'download',
            ...taskData
        });
    }

    /**
     * 发送上传任务消息
     * @param {string} taskId - 任务 ID
     * @param {object} taskData - 任务数据
     */
    async enqueueUploadTask(taskId, taskData = {}) {
        return this.publish(this.topics.uploadTasks, {
            taskId,
            type: 'upload',
            ...taskData
        });
    }

    /**
     * 发送系统事件消息
     * @param {string} event - 事件名称
     * @param {object} data - 事件数据
     */
    async broadcastSystemEvent(event, data = {}) {
        return this.publish(this.topics.systemEvents, {
            event,
            ...data
        });
    }

    /**
     * 调度媒体组批处理任务
     * @param {string} groupId - 媒体组 ID
     * @param {Array} taskIds - 任务 ID 列表
     * @param {number} delaySeconds - 延迟秒数（默认为1秒）
     */
    async scheduleMediaGroupBatch(groupId, taskIds, delaySeconds = 1) {
        return this.publishDelayed('media-batch', {
            groupId,
            taskIds,
            type: 'media-group-batch'
        }, delaySeconds);
    }
}

export const qstashService = new QStashService();

export { QStashService };