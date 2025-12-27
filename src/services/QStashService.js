import { Client, Receiver } from "@upstash/qstash";
import { config } from "../config/index.js";
import logger from "./logger.js";

/**
 * QStash 服务层
 * 封装 QStash 消息队列和发布订阅功能
 */
class QStashService {
    constructor() {
        // 检查 QStash 配置是否存在
        if (!config.qstash) {
            logger.warn('⚠️ QStash 配置未找到，使用模拟模式');
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
     * 发布消息到指定 topic
     * @param {string} topic - 目标 topic
     * @param {object} message - 消息内容
     * @param {object} options - 发布选项（延迟等）
     */
    async publish(topic, message, options = {}) {
        if (this._checkMockMode()) {
            return { messageId: "mock-message-id" };
        }

        const url = `${config.qstash.webhookUrl}/api/tasks/${topic}`;

        const publishOptions = {
            url,
            body: JSON.stringify(message),
            headers: {
                "Content-Type": "application/json"
            },
            ...options
        };

        try {
            const result = await this.client.publishJSON(publishOptions);
            logger.info(`📤 发布消息到 ${topic}:`, message);
            return result;
        } catch (error) {
            logger.error(`❌ 发布消息失败 ${topic}:`, error);
            throw error;
        }
    }

    /**
     * 批量发布消息
     * @param {Array<{topic: string, message: object, options?: object}>} messages
     */
    async batchPublish(messages) {
        if (this._checkMockMode()) {
            return messages.map(() => ({ status: "fulfilled", value: { messageId: "mock-message-id" } }));
        }

        const publishPromises = messages.map(({ topic, message, options = {} }) =>
            this.publish(topic, message, options)
        );

        try {
            const results = await Promise.allSettled(publishPromises);
            const successful = results.filter(r => r.status === 'fulfilled').length;
            const failed = results.filter(r => r.status === 'rejected').length;

            logger.info(`📤 批量发布完成: ${successful} 成功, ${failed} 失败`);

            if (failed > 0) {
                logger.warn('失败的消息:', results.filter(r => r.status === 'rejected'));
            }

            return results;
        } catch (error) {
            logger.error('❌ 批量发布失败:', error);
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
            return true;
        } catch (error) {
            logger.error('❌ Webhook 签名验证失败:', error);
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