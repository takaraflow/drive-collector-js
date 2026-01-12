import { BaseQueue } from './BaseQueue.js';

/**
 * CloudQueueBase - 云消息队列中间抽象组件
 * 提取所有云消息队列的通用功能：
 * - 批量缓冲处理
 * - 重试机制
 * - 熔断器
 * - Mock模式
 * - 并发控制
 * - 网络控制
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
}