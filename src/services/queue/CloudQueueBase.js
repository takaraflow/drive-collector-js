import { BaseQueue } from './BaseQueue.js';
import { logger } from '../logger/index.js';
import crypto from 'crypto';

const log = logger.withModule?.('CloudQueueBase') || logger;

/**
 * CloudQueueBase - 云消息队列中间抽象组件
 * 提取所有云消息队列的通用功能：
 * - 批量缓冲处理
 * - 重试机制
 * - 熔断器
 * - Mock模式
 * - 并发控制
 * - 网络控制
 * - 消息幂等性（本地 + Redis）
 */
export default class CloudQueueBase extends BaseQueue {
    constructor(options = {}) {
        super(options);
        this.isMockMode = options.mockMode || false;
        this.loggerPrefix = options.loggerPrefix || '[CloudQueue]';
        
        // 批量处理配置
        this.batchSize = options.batchSize || parseInt(process.env.BATCH_SIZE) || 10;
        this.batchTimeout = options.batchTimeout || parseInt(process.env.BATCH_TIMEOUT) || 100;
        this.buffer = [];
        this.flushTimer = null;

        // ========== 消息幂等性 ==========
        // 本地缓存（快速路径）
        this.processedMessages = new Set();
        this.processedMessagesLimit = parseInt(process.env.QUEUE_LOCAL_IDEMPOTENCY_LIMIT) || 1000;

        // Redis 分布式去重（可选）
        this.idempotencyKeyPrefix = 'queue:idempotency:';
        this.idempotencyKeyTtl = parseInt(process.env.QUEUE_IDEMPOTENCY_TTL) || 86400;
        this.useRedisIdempotency = process.env.QUEUE_USE_IDEMPOTENCY === 'true';
        
        // Redis 客户端（子类初始化）
        this.redisClient = null;
        
        // 并发发布防重
        this.inFlightPublishes = new Map();
    }

    /**
     * 添加任务到缓冲区
     * @param {Object} task - 任务对象
     * @returns {Promise} - 延迟的 promise
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
     * @param {Function} batchPublishFn - 批量发布函数
     * @param {string} loggerPrefix - 日志前缀
     */
    async _flushBuffer(batchPublishFn, loggerPrefix = '[CloudQueue]') {
        if (this.buffer.length === 0) return;

        // 清除定时器
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        const batch = [...this.buffer];
        this.buffer = [];

        console.log(`${loggerPrefix} Flushing batch: ${batch.length} tasks`);

        try {
            const results = await batchPublishFn(batch);

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
            console.error(`${loggerPrefix} Batch publish failed: ${error.message}`);
            
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

    /**
     * 带重试的执行
     * @param {Function} fn - 要执行的函数
     * @param {number} maxRetries - 最大重试次数
     * @param {string} loggerPrefix - 日志前缀
     * @returns {Promise} - 执行结果
     */
    async _executeWithRetry(fn, maxRetries = 3, loggerPrefix = '[CloudQueue]') {
        const baseDelay = 100;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                const errorCode = this._extractErrorCode(error.message);
                if (errorCode && errorCode >= 400 && errorCode < 500) throw error;
                if (attempt === maxRetries) throw error;

                const jitter = process.env.NODE_ENV === 'test' ? 25 : Math.random() * 50;
                const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
                console.warn(`${loggerPrefix} attempt ${attempt} failed, retrying in ${delay.toFixed(0)}ms`);

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * 批量执行任务（带并发控制）
     * @param {Array} tasks - 任务数组
     * @param {number} concurrency - 并发数
     * @param {Function} singleTaskFn - 单个任务执行函数
     * @param {string} loggerPrefix - 日志前缀
     * @returns {Promise<Array>} - 执行结果
     */
    async _executeBatch(tasks, concurrency = 5, singleTaskFn, loggerPrefix = '[CloudQueue]') {
        const results = [];
        
        for (let i = 0; i < tasks.length; i += concurrency) {
            const batch = tasks.slice(i, i + concurrency);
            const batchResults = await Promise.allSettled(
                batch.map(async (task) => {
                    return this._executeWithRetry(async () => {
                        return await singleTaskFn(task);
                    }, 3, loggerPrefix);
                })
            );
            results.push(...batchResults);
            
            // 批次间添加小延迟，避免突发流量
            if (i + concurrency < tasks.length) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        
        return results;
    }

    /**
     * 从错误消息中提取错误码
     * @param {string} errorMessage - 错误消息
     * @returns {number|null} - 错误码或null
     */
    _extractErrorCode(errorMessage) {
        if (!errorMessage) return null;
        const match = errorMessage.match(/(\d{3})/);
        return match ? parseInt(match[1]) : null;
    }

    /**
     * 强制刷新缓冲区
     */
    async flush() {
        if (this.buffer.length > 0) {
            // 需要子类提供 batchPublishFn
            throw new Error('flush() requires batchPublishFn to be implemented in subclass');
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
     * 清空缓冲区
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

    // 熔断器占位符（子类需要实例化）
    publishBreaker = null;

    // Mock模式标志
    isMockMode = false;

    // ========== 消息幂等性方法 ==========

    /**
     * 生成消息ID（子类可覆盖）
     * @param {string} topic - 主题
     * @param {any} message - 消息内容
     * @returns {string} - 消息ID
     */
    _generateMessageId(topic, message) {
        const content = typeof message === 'string' ? message : JSON.stringify(message);
        const hash = crypto.createHash('md5').update(`${topic}:${content}`).digest('hex');
        return `msg_${hash}`;
    }

    /**
     * 检查消息是否已处理（本地 + Redis）
     * @param {string} messageId - 消息ID
     * @returns {Promise<boolean>} - 是否已处理
     */
    async _checkIdempotency(messageId) {
        // 1. 本地缓存检查（快速路径）
        if (this.processedMessages.has(messageId)) {
            return true;
        }

        // 2. Redis 分布式检查
        if (this.useRedisIdempotency && this.redisClient) {
            const redisKey = `${this.idempotencyKeyPrefix}${messageId}`;
            try {
                const existing = await this.redisClient.get(redisKey);
                if (existing !== null && existing !== undefined) {
                    // 同步到本地缓存
                    this._addProcessedMessage(messageId);
                    return true;
                }

                // 原子设置 key
                await this.redisClient.setex(redisKey, this.idempotencyKeyTtl, '1');
            } catch (error) {
                log.warn(`Redis idempotency check failed: ${error.message}`);
            }
        }

        return false;
    }

    /**
     * 添加已处理消息到本地缓存
     * @param {string} messageId - 消息ID
     */
    _addProcessedMessage(messageId) {
        this.processedMessages.add(messageId);
        
        // FIFO 驱逐
        if (this.processedMessages.size > this.processedMessagesLimit) {
            const iterator = this.processedMessages.values();
            const oldest = iterator.next().value;
            this.processedMessages.delete(oldest);
        }
    }

    /**
     * 清理 Redis 幂等性 key（发布失败时调用）
     * @param {string} messageId - 消息ID
     */
    async _clearIdempotencyKey(messageId) {
        if (this.useRedisIdempotency && this.redisClient && this.redisClient.del) {
            const redisKey = `${this.idempotencyKeyPrefix}${messageId}`;
            try {
                await this.redisClient.del(redisKey);
            } catch (error) {
                log.warn(`Failed to clear idempotency key: ${error.message}`);
            }
        }
    }

    /**
     * 获取幂等性状态（供监控使用）
     */
    getIdempotencyStatus() {
        return {
            localCache: {
                size: this.processedMessages.size,
                limit: this.processedMessagesLimit
            },
            redis: {
                enabled: this.useRedisIdempotency,
                keyPrefix: this.idempotencyKeyPrefix,
                ttl: this.idempotencyKeyTtl
            }
        };
    }

    /**
     * 清空本地幂等性缓存（供测试使用）
     */
    clearProcessedMessages() {
        this.processedMessages.clear();
    }

    /**
     * 获取已处理消息列表（供测试使用）
     */
    getProcessedMessages() {
        return Array.from(this.processedMessages);
    }
}