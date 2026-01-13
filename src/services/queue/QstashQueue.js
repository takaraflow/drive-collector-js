import { Client, Receiver } from "@upstash/qstash";
import { Mutex } from "async-mutex";
import { getConfig } from "../../config/index.js";
import { logger } from "../../services/logger/index.js";
import { CircuitBreakerManager } from "../../services/CircuitBreaker.js";
import CloudQueueBase from "./CloudQueueBase.js";
import { BaseQueue } from "./BaseQueue.js";

const log = logger.withModule?.('QstashQueue') || logger;

/**
 * QstashQueue - QStash 消息队列实现
 * 继承 CloudQueueBase 的通用功能，添加 QStash 特有功能
 */
export class QstashQueue extends CloudQueueBase {
    constructor(options = {}) {
        super(options);
        this.client = null;
        this.bufferMutex = new Mutex();
        this.receiver = null;
        
        // QStash 特有的熔断器
        this.publishBreaker = CircuitBreakerManager.get('qstash_publish', {
            failureThreshold: 3,
            successThreshold: 2,
            timeout: 10000
        });

        // 覆盖批量配置为 QStash 优化
        this.batchSize = options.batchSize || parseInt(process.env.QSTASH_BATCH_SIZE) || 10;
        this.batchTimeout = options.batchTimeout || parseInt(process.env.QSTASH_BATCH_TIMEOUT) || 100;
    }

    async initialize() {
        await super.initialize();
        const config = getConfig();

        if (!config.qstash?.token) {
            log.warn('QStash Token 未找到，使用模拟模式');
            this.isMockMode = true;
        } else {
            this.client = new Client({ token: config.qstash.token });
            this.isMockMode = false;
        }

        this.receiver = new Receiver({
            currentSigningKey: config.qstash.currentSigningKey,
            nextSigningKey: config.qstash.nextSigningKey
        });

        await this.connect();
    }

    async _connect() {
        log.info(`QstashQueue connected (Mode: ${this.isMockMode ? 'Mock' : 'Real'})`);
    }

    async _publish(topic, message, options = {}) {
        // 如果启用了批量处理，将任务加入缓冲区
        if (this.batchSize > 1 && !options.forceDirect) {
            return this._addToBuffer({ topic, message, options });
        }

        if (this.isMockMode) return { messageId: "mock-message-id" };

        return this.publishBreaker.execute(
            () => this._executeWithRetry(async () => {
                const result = await this.client.publishJSON({
                    url: topic,
                    body: message,
                    ...options
                });
                log.info(`Qstash Published, MsgID: ${result.messageId}`);
                return result;
            }, 3, '[QstashQueue]'),
            () => ({ messageId: "fallback-message-id", fallback: true })
        );
    }

    /**
     * 刷新缓冲区 - 发送批量任务（重写父类方法）
     */
    async _flushBuffer() {
        if (this.buffer.length === 0) return;

        // 调用父类的 _flushBuffer，传入 QStash 特有的批量发布函数
        return super._flushBuffer(async (batch) => {
            const messages = batch.map(task => ({
                topic: task.topic,
                message: task.message
            }));

            if (this.isMockMode) {
                return messages.map(() => ({ messageId: "mock-message-id" }));
            }

            return this.publishBreaker.execute(
                () => this._executeBatch(messages),
                () => messages.map(() => ({ messageId: "fallback-message-id", fallback: true }))
            );
        }, '[QstashQueue]');
    }

    /**
     * 批量发布（QStash 特有实现）
     */
    async _batchPublish(messages) {
        if (this.isMockMode) {
            return messages.map(() => ({ messageId: "mock-message-id" }));
        }

        return this.publishBreaker.execute(
            () => this._executeBatch(messages),
            () => messages.map(() => ({ messageId: "fallback-message-id", fallback: true }))
        );
    }

    /**
     * 执行批量任务（QStash 特有实现）
     */
    async _executeBatch(messages) {
        const maxConcurrent = parseInt(process.env.QSTASH_MAX_CONCURRENT) || 5;
        
        // 调用父类的 _executeBatch，传入 QStash 特有的单个任务执行函数
        return super._executeBatch(
            messages,
            maxConcurrent,
            async (msg) => {
                return await this.client.publishJSON({
                    url: msg.topic,
                    body: msg.message
                });
            },
            '[QstashQueue]'
        );
    }

    /**
     * 验证 Webhook 签名（QStash 特有功能）
     */
    async _verifyWebhook(signature, body) {
        if (this.isMockMode) return true;
        if (!signature) {
            log.warn('Signature verification failed: missing signature');
            return false;
        }
        try {
            await this.receiver.verify({ signature, body });
            return true;
        } catch (error) {
            log.error('Signature verification failed', error);
            return false;
        }
    }

    /**
     * 强制刷新缓冲区（重写父类方法）
     */
    async flush() {
        if (this.buffer.length > 0) {
            return this._flushBuffer();
        }
    }

    /**
     * 关闭队列（重写父类方法）
     */
    async close() {
        await this.flush();
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

    /**
     * 获取熔断器状态
     */
    getCircuitBreakerStatus() {
        return this.publishBreaker.getStatus();
    }

    /**
     * 重置熔断器
     */
    resetCircuitBreaker() {
        this.publishBreaker.reset();
    }
}