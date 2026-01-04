import { Client, Receiver } from "@upstash/qstash";
import { getConfig } from "../config/index.js";
import { logger } from "./logger.js";

/**
 * QStash 服务层
 */
export class QStashService {
    constructor() {
        this.client = null;
        this.receiver = null;
        this.isMockMode = true;
        this.isInitialized = false;
        this.topics = {
            downloadTasks: "download-tasks",
            uploadTasks: "upload-tasks",
            systemEvents: "system-events"
        };
    }

    /**
     * 显式初始化
     */
    async initialize() {
        if (this.isInitialized) return;

        const config = getConfig();
        if (!config.qstash?.token) {
            logger.warn('⚠️ QStash Token 未找到，使用模拟模式。');
            this.isMockMode = true;
        } else {
            this.client = new Client({ token: config.qstash.token });
            this.isMockMode = false;
        }

        this.receiver = new Receiver({
            currentSigningKey: config.qstash.currentSigningKey,
            nextSigningKey: config.qstash.nextSigningKey
        });

        this.isInitialized = true;
        logger.info(`[QStash] Service initialized (Mode: ${this.isMockMode ? 'Mock' : 'Real'})`);
    }

    _checkMockMode() {
        if (!this.isInitialized) throw new Error("QStashService not initialized");
        if (this.isMockMode) {
            logger.info('📤 [模拟模式] QStash 未配置，跳过操作');
            return true;
        }
        return false;
    }

    async publish(topic, message, options = {}) {
        if (this._checkMockMode()) return { messageId: "mock-message-id" };
        
        const config = getConfig();
        const url = `${config.qstash.webhookUrl}/api/tasks/${topic}`;

        return this._executeWithRetry(async () => {
            const result = await this.client.publishJSON({
                url,
                body: message,
                ...options
            });
            logger.info(`[QStash] Published to ${topic}, MsgID: ${result.messageId}`);
            return result;
        }, "publish");
    }

    async batchPublish(messages) {
        if (this._checkMockMode()) {
            return messages.map(() => ({ status: "fulfilled", value: { messageId: "mock-message-id" } }));
        }

        // 并发执行所有消息的发布
        const results = await Promise.allSettled(messages.map(async (msg) => {
            return this._executeWithRetry(async () => {
                const config = getConfig();
                const url = `${config.qstash.webhookUrl}/api/tasks/${msg.topic}`;
                return await this.client.publishJSON({
                    url,
                    body: msg.message
                });
            }, "batchPublish");
        }));
        return results;
    }

    async _executeWithRetry(operation, operationName) {
        const maxRetries = 3;
        const baseDelay = 100;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                const errorCode = this._extractErrorCode(error.message);
                
                // 4xx errors should not be retried
                if (errorCode && errorCode >= 400 && errorCode < 500) {
                    logger.error(`[QStash] ${operationName} failed with ${errorCode}, not retrying`);
                    throw error;
                }

                // If it's the last attempt, throw the error
                if (attempt === maxRetries) {
                    logger.error(`[QStash] ${operationName} failed after ${maxRetries} attempts`);
                    throw error;
                }

                // Calculate delay with fixed jitter in test environment
                // In test: fixed 25ms jitter (0.5 * 50)
                // In production: random jitter (Math.random() * 50)
                const jitter = process.env.NODE_ENV === 'test' ? 25 : Math.random() * 50;
                const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
                logger.warn(`[QStash] ${operationName} attempt ${attempt} failed, retrying in ${delay.toFixed(0)}ms`);

                // In test environment, use jest-compatible delay
                if (process.env.NODE_ENV === 'test' && typeof jest !== 'undefined') {
                    // Use a simple promise that resolves after the delay
                    // Jest's fake timers will handle this automatically
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    }

    _extractErrorCode(errorMessage) {
        const match = errorMessage.match(/(\d{3})/);
        return match ? parseInt(match[1]) : null;
    }

    async verifyWebhookSignature(signature, body) {
        if (this.isMockMode) return true;
        // Defensive check: if signature is missing, return false immediately
        if (!signature) {
            logger.warn('[QStash] Signature verification failed: missing signature');
            return false;
        }
        try {
            await this.receiver.verify({ signature, body });
            return true;
        } catch (error) {
            logger.error('[QStash] Signature verification failed', error);
            return false;
        }
    }

    async enqueueDownloadTask(taskId, taskData = {}) {
        return this.publish(this.topics.downloadTasks, { taskId, type: 'download', ...taskData });
    }

    async enqueueUploadTask(taskId, taskData = {}) {
        return this.publish(this.topics.uploadTasks, { taskId, type: 'upload', ...taskData });
    }

    async broadcastSystemEvent(event, data = {}) {
        return this.publish(this.topics.systemEvents, { event, ...data });
    }
}

export const qstashService = new QStashService();