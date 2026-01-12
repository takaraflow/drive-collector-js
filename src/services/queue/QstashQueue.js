import { Client, Receiver } from "@upstash/qstash";
import { getConfig } from "../../config/index.js";
import { logger } from "../../services/logger/index.js";
import { CircuitBreakerManager } from "../../services/CircuitBreaker.js";
import { BaseQueue } from "./BaseQueue.js";

const log = logger.withModule?.('QstashQueue') || logger;

export class QstashQueue extends BaseQueue {
    constructor(options = {}) {
        super(options);
        this.client = null;
        this.receiver = null;
        this.isMockMode = true;
        this.publishBreaker = CircuitBreakerManager.get('qstash_publish', {
            failureThreshold: 3,
            successThreshold: 2,
            timeout: 10000
        });

        // 批量处理配置
        this.batchSize = options.batchSize || parseInt(process.env.QSTASH_BATCH_SIZE) || 10;
        this.batchTimeout = options.batchTimeout || parseInt(process.env.QSTASH_BATCH_TIMEOUT) || 100;
        this.buffer = [];
        this.flushTimer = null;
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
            }, "publish"),
            () => ({ messageId: "fallback-message-id", fallback: true })
        );
    }

    /**
     * 添加任务到缓冲区
     */
    async _addToBuffer(task) {
        this.buffer.push(task);
        
        // 立即刷新如果达到批量大小
        if (this.buffer.length >= this.batchSize) {
            return this._flushBuffer();
        }

        // 设置定时刷新
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => {
                this._flushBuffer();
            }, this.batchTimeout);
        }

        // 返回延迟的 promise
        return new Promise((resolve) => {
            task.resolve = resolve;
        });
    }

    /**
     * 刷新缓冲区 - 发送批量任务
     */
    async _flushBuffer() {
        if (this.buffer.length === 0) return;

        // 清除定时器
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        const batch = [...this.buffer];
        this.buffer = [];

        log.info(`Flushing batch: ${batch.length} tasks`);

        try {
            const results = await this._batchPublish(batch.map(task => ({
                topic: task.topic,
                message: task.message
            })));

            // 处理结果
            results.forEach((result, index) => {
                if (batch[index].resolve) {
                    if (result.status === 'fulfilled') {
                        batch[index].resolve(result.value);
                    } else {
                        batch[index].resolve({
                            messageId: "fallback-message-id",
                            fallback: true,
                            error: result.reason?.message
                        });
                    }
                }
            });

            return results;
        } catch (error) {
            log.error(`Batch publish failed: ${error.message}`);
            
            // 所有任务都返回降级结果
            batch.forEach(task => {
                if (task.resolve) {
                    task.resolve({
                        messageId: "fallback-message-id",
                        fallback: true,
                        error: error.message
                    });
                }
            });
        }
    }

    async _batchPublish(messages) {
        if (this.isMockMode) {
            return messages.map(() => ({ messageId: "mock-message-id" }));
        }

        return this.publishBreaker.execute(
            () => this._executeBatch(messages),
            () => messages.map(() => ({ messageId: "fallback-message-id", fallback: true }))
        );
    }

    async _executeBatch(messages) {
        // 使用并发控制，避免同时发送过多请求
        const maxConcurrent = parseInt(process.env.QSTASH_MAX_CONCURRENT) || 5;
        const results = [];
        
        for (let i = 0; i < messages.length; i += maxConcurrent) {
            const batch = messages.slice(i, i + maxConcurrent);
            const batchResults = await Promise.allSettled(
                batch.map(async (msg) => {
                    return this._executeWithRetry(async () => {
                        return await this.client.publishJSON({
                            url: msg.topic,
                            body: msg.message
                        });
                    }, "batchPublish");
                })
            );
            results.push(...batchResults);
            
            // 批次间添加小延迟，避免突发流量
            if (i + maxConcurrent < messages.length) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        
        return results;
    }

    /**
     * 强制刷新缓冲区（用于关闭或紧急情况）
     */
    async flush() {
        if (this.buffer.length > 0) {
            return this._flushBuffer();
        }
    }

    /**
     * 获取缓冲区状态
     */
    getBufferStatus() {
        return {
            size: this.buffer.length,
            batchSize: this.batchSize,
            batchTimeout: this.batchTimeout,
            hasActiveTimer: !!this.flushTimer
        };
    }

    /**
     * 清空缓冲区（用于测试或紧急情况）
     */
    clearBuffer() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const cleared = this.buffer.length;
        this.buffer = [];
        return cleared;
    }

    /**
     * 关闭队列，确保所有缓冲任务都已发送
     */
    async close() {
        await this.flush();
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
    }

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

    async _executeWithRetry(operation, operationName) {
        const maxRetries = 3;
        const baseDelay = 100;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                const errorCode = this._extractErrorCode(error.message);
                if (errorCode && errorCode >= 400 && errorCode < 500) throw error;
                if (attempt === maxRetries) throw error;

                const jitter = process.env.NODE_ENV === 'test' ? 25 : Math.random() * 50;
                const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
                log.warn(`${operationName} attempt ${attempt} failed, retrying in ${delay.toFixed(0)}ms`);

                if (process.env.NODE_ENV === 'test' && typeof jest !== 'undefined') {
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

    getCircuitBreakerStatus() {
        return this.publishBreaker.getStatus();
    }

    resetCircuitBreaker() {
        this.publishBreaker.reset();
    }
}
