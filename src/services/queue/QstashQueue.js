import { Client, Receiver } from "@upstash/qstash";
import { Mutex } from "async-mutex";
import { getConfig } from "../../config/index.js";
import { logger } from "../../services/logger/index.js";
import { CircuitBreakerManager } from "../../services/CircuitBreaker.js";
import CloudQueueBase from "./CloudQueueBase.js";
import { BaseQueue } from "./BaseQueue.js";
import { metrics } from "../../services/MetricsService.js";

const log = logger.withModule?.('QstashQueue') || logger;

function isQstashDebugEnabled() {
    const value = (process.env.QSTASH_DEBUG || '').toLowerCase();
    return value === 'true' || value === '1' || value === 'yes';
}

function summarizeTargetUrl(url) {
    try {
        const parsed = new URL(url);
        return { host: parsed.host, path: parsed.pathname };
    } catch {
        return { url };
    }
}

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

        // 1. 缓冲区管理优化 - 最大缓冲区大小
        this.maxBufferSize = parseInt(process.env.QSTASH_MAX_BUFFER_SIZE) || 1000;

        // 3. 死信队列 - 存储失败消息
        this.deadLetterQueue = [];
        this.maxDeadLetterQueueSize = parseInt(process.env.QSTASH_DLQ_SIZE) || 100;

        // 6. 监控指标 - 性能追踪
        this.metrics = {
            bufferOverflowCount: 0,
            deadLetterCount: 0,
            duplicateMessageCount: 0,
            circuitBreakerTrips: 0,
            processingTime: []
        };
    }

    async initialize() {
        await super.initialize();
        const config = getConfig();

        if (isQstashDebugEnabled()) {
            log.info('QStash debug enabled (QSTASH_DEBUG=true)');
        }

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

        // 5. 分布式熔断器 - 尝试初始化 Redis 客户端
        await this._initializeRedisClient();

        await this.connect();
    }

    /**
     * 5. 分布式熔断器 - 初始化 Redis 客户端
     */
    async _initializeRedisClient() {
        if (process.env.NODE_ENV === 'test') {
            return;
        }
        try {
            // 尝试从 CacheService 获取 Redis 客户端
            const { cache } = await import("../CacheService.js");
            const rawClient = cache?.primaryProvider?.client;

            if (rawClient && typeof rawClient.get === 'function' && typeof rawClient.setex === 'function') {
                this.redisClient = rawClient;
                log.info('QStashQueue: Redis raw client initialized for distributed circuit breaker');
                return;
            }

            if (cache && typeof cache.get === 'function' && typeof cache.set === 'function') {
                // Fallback: use CacheService as the distributed storage backend.
                // Keep TTL deterministic and avoid L1 cache for this control-plane key.
                this.redisClient = {
                    get: async (key) => {
                        return await cache.get(key, 'text', { skipL1: true });
                    },
                    setex: async (key, ttlSeconds, value) => {
                        await cache.set(key, value, ttlSeconds, { skipTtlRandomization: true, skipL1: true });
                    },
                    del: async (key) => {
                        await cache.set(key, '', 0, { skipL1: true });
                    }
                };
                log.info('QueueBase: CacheService wrapper initialized for distributed idempotency');
            } else {
                log.warn('QStashQueue: Redis client not available, using local circuit breaker');
            }
        } catch (error) {
            log.warn('QStashQueue: Failed to initialize Redis client, using local circuit breaker', error.message);
        }
    }

    async _connect() {
        log.info(`QstashQueue connected (Mode: ${this.isMockMode ? 'Mock' : 'Real'})`);
    }

    async _publish(topic, message, options = {}) {
        const effectiveOptions = process.env.QSTASH_FORCE_DIRECT === 'true'
            ? { ...options, forceDirect: true }
            : options;

        if (isQstashDebugEnabled()) {
            log.debug('QStash publish requested', {
                target: summarizeTargetUrl(topic),
                taskId: message?.taskId,
                messageType: message?.type,
                triggerSource: message?._meta?.triggerSource,
                forceDirect: Boolean(effectiveOptions.forceDirect),
                batchSize: this.batchSize,
                batchTimeout: this.batchTimeout,
                bufferSize: this.buffer.length,
                mockMode: this.isMockMode
            });
        }

        // 如果启用了批量处理，将任务加入缓冲区
        if (this.batchSize > 1 && !effectiveOptions.forceDirect) {
            return this._addToBuffer({ topic, message, options: effectiveOptions });
        }

        // 使用新的幂等性发布机制
        return this._publishWithIdempotency(topic, message, effectiveOptions);
    }

    /**
     * 1. 缓冲区管理优化 - 添加到缓冲区（重写父类方法）
     */
    async _addToBuffer(task) {
        // 使用互斥锁确保线程安全
        return await this.bufferMutex.runExclusive(async () => {
            // 检查缓冲区溢出
            if (this.buffer.length >= this.maxBufferSize) {
                // 丢弃最旧的10%消息
                const dropCount = Math.floor(this.maxBufferSize * 0.1);
                const droppedMessages = this.buffer.splice(0, dropCount);
                
                // 记录缓冲区溢出指标
                this.metrics.bufferOverflowCount += dropCount;
                metrics.increment('buffer.overflow', dropCount);
                
                log.warn(`Buffer overflow: dropped ${dropCount} oldest messages`);
                
                // 将丢弃的消息移入死信队列
                for (const droppedMsg of droppedMessages) {
                    this._addToDeadLetterQueue(droppedMsg, 'buffer_overflow');
                    if (typeof droppedMsg.reject === 'function') {
                        droppedMsg.reject(new Error('Buffer overflow: message dropped'));
                    } else if (typeof droppedMsg.resolve === 'function') {
                        droppedMsg.resolve({
                            messageId: 'fallback-message-id',
                            fallback: true,
                            error: 'Buffer overflow: message dropped'
                        });
                    }
                }
            }

            // 添加新消息到缓冲区
            this.buffer.push(task);
            metrics.gauge('buffer.size', this.buffer.length);

            if (isQstashDebugEnabled()) {
                log.debug('QStash buffered message', {
                    target: summarizeTargetUrl(task.topic),
                    taskId: task.message?.taskId,
                    triggerSource: task.message?._meta?.triggerSource,
                    bufferSize: this.buffer.length,
                    batchSize: this.batchSize,
                    batchTimeout: this.batchTimeout
                });
            }

            // 达到批量大小时，尽快触发刷新（避免在锁内直接 await 导致死锁）
            if (this.buffer.length >= this.batchSize) {
                queueMicrotask(() => {
                    this._flushBuffer();
                });
            }

            // 设置定时刷新
            if (!this.flushTimer) {
                this.flushTimer = setTimeout(() => {
                    this._flushBuffer();
                }, this.batchTimeout);
            }

            // 返回延迟的 promise
            return new Promise((resolve, reject) => {
                task.resolve = resolve;
                task.reject = reject;
            });
        });
    }

    /**
     * 刷新缓冲区 - 发送批量任务（重写父类方法）
     */
    async _flushBuffer() {
        if (this.buffer.length === 0) return;

        // 使用互斥锁确保线程安全
        return await this.bufferMutex.runExclusive(async () => {
            // 清除定时器
            if (this.flushTimer) {
                clearTimeout(this.flushTimer);
                this.flushTimer = null;
            }

            const batch = [...this.buffer];
            this.buffer = [];

            if (isQstashDebugEnabled()) {
                log.debug('QStash flushing buffer', {
                    batchSize: batch.length,
                    configuredBatchSize: this.batchSize,
                    batchTimeout: this.batchTimeout
                });
            }

            // 2. 消息顺序性保障 - 顺序发送
            const results = await this._batchPublishSequential(batch);

            // 处理结果
            results.forEach((result, index) => {
                if (batch[index].resolve) {
                    if (result.status === 'fulfilled') {
                        batch[index].resolve(result.value);
                    } else {
                        // 失败时加入死信队列
                        this._addToDeadLetterQueue(batch[index], 'publish_failed', result.reason);
                        if (typeof batch[index].reject === 'function') {
                            batch[index].reject(result.reason);
                        } else {
                            batch[index].resolve({
                                messageId: "fallback-message-id",
                                fallback: true,
                                error: result.reason?.message
                            });
                        }
                    }
                }
            });

            // 更新监控指标
            metrics.gauge('buffer.size', this.buffer.length);

            return results;
        }).catch((error) => {
            // 兜底：确保批次内所有 promise 都能结束，避免调用方永远等待
            const pending = [...this.buffer];
            this.buffer = [];
            pending.forEach(task => {
                if (typeof task.reject === 'function') task.reject(error);
                else if (typeof task.resolve === 'function') {
                    task.resolve({ messageId: "fallback-message-id", fallback: true, error: error.message });
                }
            });
            throw error;
        });
    }

    clearBuffer() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        const pending = [...this.buffer];
        this.buffer = [];
        pending.forEach(task => {
            if (typeof task.reject === 'function') task.reject(new Error('Buffer cleared'));
        });
        return pending.length;
    }

    /**
     * 2. 消息顺序性保障 - 顺序批量发布
     */
    async _batchPublishSequential(batch) {
        const startTime = Date.now();
        const results = [];

        for (let i = 0; i < batch.length; i++) {
            const task = batch[i];
            try {
                const result = await this._publishWithIdempotency(task.topic, task.message, task.options);
                results.push({ status: 'fulfilled', value: result });
                
                // 记录成功指标
                metrics.increment('messages.processed.total');
                metrics.timing('queue.processing.time', Date.now() - startTime);
            } catch (error) {
                results.push({ status: 'rejected', reason: error });
                
                // 记录失败指标
                metrics.increment(`messages.status.${error.code || 500}`);
            }
        }

        return results;
    }

    /**
     * 4. 消息幂等性处理 - 带幂等性检查的发布
     */
    async _publishWithIdempotency(topic, message, options = {}) {
        // 生成消息ID（基于 topic + message 内容）
        const messageId = this._generateMessageId(topic, message);

        if (isQstashDebugEnabled()) {
            log.debug('QStash publish begin', {
                messageId,
                target: summarizeTargetUrl(topic),
                taskId: message?.taskId,
                triggerSource: message?._meta?.triggerSource,
                mockMode: this.isMockMode
            });
        }
        
        // 检查是否已处理（使用父类的幂等性检查）
        const isDuplicate = await this._checkIdempotency(messageId);
        if (isDuplicate) {
            this.metrics.duplicateMessageCount++;
            metrics.increment('messages.duplicate');
            log.warn(`Duplicate message detected: ${messageId}`);
            return { messageId, duplicate: true };
        }

        // 合并并发中的同一消息发布，避免重复请求
        if (this.inFlightPublishes.has(messageId)) {
            return this.inFlightPublishes.get(messageId);
        }

        const publishPromise = (async () => {
            if (this.isMockMode) {
                // Mock 模式：不触发真实发布，但仍返回稳定 messageId 供链路追踪
                this._addProcessedMessage(messageId);
                return { messageId, mock: true };
            }

            // 实际发布：不使用 fallback 静默吞错，避免"看似入队成功但实际未发送"
            const startTime = Date.now();
            try {
                const result = await this.publishBreaker.execute(() => this._executeWithRetry(async () => {
                    return await this.client.publishJSON({
                        url: topic,
                        body: message,
                        ...options
                    });
                }, 3, '[QstashQueue]'));

                // 只有成功发布后才标记为已处理，避免失败导致后续重试被误判为 duplicate
                this._addProcessedMessage(messageId);

                metrics.timing('publish.time', Date.now() - startTime);
                if (isQstashDebugEnabled()) {
                    log.debug('QStash publish success', {
                        messageId,
                        target: summarizeTargetUrl(topic),
                        taskId: message?.taskId,
                        durationMs: Date.now() - startTime
                    });
                }
                return result;
            } catch (error) {
                // 如果是熔断器错误，记录指标
                if (error?.message?.includes('CircuitBreaker') || error?.message?.includes('OPEN')) {
                    this.metrics.circuitBreakerTrips++;
                    metrics.increment('circuit.breaker.trips');
                }

                // 发布失败时清理 Redis key，允许后续重试
                await this._clearIdempotencyKey(messageId);

                // 失败时加入死信队列，避免静默丢消息
                this._addToDeadLetterQueue({ topic, message, options }, 'publish_failed', error);
                if (isQstashDebugEnabled()) {
                    log.error('QStash publish failed', {
                        messageId,
                        target: summarizeTargetUrl(topic),
                        taskId: message?.taskId,
                        error: error?.message
                    });
                }
                throw error;
            }
        })();

        this.inFlightPublishes.set(messageId, publishPromise);
        try {
            return await publishPromise;
        } finally {
            this.inFlightPublishes.delete(messageId);
        }
    }

    /**
     * 3. 死信队列实现 - 添加到死信队列
     */
    _addToDeadLetterQueue(message, reason, error = null) {
        const dlqMessage = {
            message,
            reason,
            error: error?.message,
            timestamp: Date.now(),
            id: `dlq_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        };

        this.deadLetterQueue.push(dlqMessage);
        this.metrics.deadLetterCount++;
        metrics.increment('deadletter.queue', 1);

        // 限制死信队列大小
        if (this.deadLetterQueue.length > this.maxDeadLetterQueueSize) {
            const removed = this.deadLetterQueue.shift();
            log.warn(`Dead letter queue full, removed oldest message: ${removed.id}`);
        }

        log.error(`Added to dead letter queue: ${reason}`, {
            messageId: dlqMessage.id,
            error: error?.message
        });
    }

    /**
     * 3. 死信队列实现 - 获取死信队列
     */
    getDeadLetterQueue() {
        return this.deadLetterQueue;
    }

    /**
     * 3. 死信队列实现 - 清空死信队列
     */
    clearDeadLetterQueue() {
        const count = this.deadLetterQueue.length;
        this.deadLetterQueue = [];
        return count;
    }

    /**
     * 3. 死信队列实现 - 重试死信消息
     */
    async retryDeadLetterMessage(dlqId) {
        const index = this.deadLetterQueue.findIndex(msg => msg.id === dlqId);
        if (index === -1) {
            throw new Error(`DLQ message ${dlqId} not found`);
        }

        const dlqMessage = this.deadLetterQueue[index];
        
        try {
            // 重新发布消息
            const result = await this._publishWithIdempotency(
                dlqMessage.message.topic,
                dlqMessage.message.message,
                dlqMessage.message.options
            );

            // 从死信队列移除
            this.deadLetterQueue.splice(index, 1);
            
            log.info(`Successfully retried DLQ message: ${dlqId}`);
            return result;
        } catch (error) {
            log.error(`Failed to retry DLQ message: ${dlqId}`, error);
            throw error;
        }
    }

    /**
     * 5. 分布式熔断器 - 获取全局熔断器状态
     */
    async getGlobalCircuitState() {
        if (!this.redisClient) {
            // 降级到本地状态
            return this.publishBreaker.getStatus();
        }

        try {
            const state = await this.redisClient.get('qstash:circuit:state');
            return state ? JSON.parse(state) : this.publishBreaker.getStatus();
        } catch (error) {
            log.warn('Failed to get global circuit state from Redis, using local state');
            return this.publishBreaker.getStatus();
        }
    }

    /**
     * 5. 分布式熔断器 - 更新全局熔断器状态
     */
    async updateGlobalCircuitState(state) {
        if (!this.redisClient) {
            return;
        }

        try {
            await this.redisClient.setex(
                'qstash:circuit:state',
                60, // 60秒过期
                JSON.stringify(state)
            );
        } catch (error) {
            log.warn('Failed to update global circuit state in Redis', error.message);
        }
    }

    /**
     * 5. 分布式熔断器 - 检查并同步熔断器状态
     */
    async _syncCircuitBreakerState() {
        if (!this.redisClient) return;

        try {
            const globalState = await this.getGlobalCircuitState();
            const localState = this.publishBreaker.getStatus();

            // 如果全局状态是打开的，而本地是关闭的，同步状态
            if (globalState.state === 'open' && localState.state === 'closed') {
                this.publishBreaker.forceOpen();
                log.info('Circuit breaker synchronized to open state from global');
            }
        } catch (error) {
            log.warn('Failed to sync circuit breaker state', error.message);
        }
    }

    /**
     * 6. 监控指标增强 - 获取详细指标
     */
    getMetrics() {
        const baseMetrics = metrics.getMetrics();
        
        return {
            ...baseMetrics,
            // 兼容测试期望的属性
            totalProcessed: baseMetrics.messages?.processed?.total || 0,
            bufferOverflowCount: this.metrics.bufferOverflowCount,
            deadLetterCount: this.metrics.deadLetterCount,
            duplicateMessageCount: this.metrics.duplicateMessageCount,
            circuitBreakerTrips: this.metrics.circuitBreakerTrips,
            // 新的结构化属性
            queue: {
                bufferSize: this.buffer.length,
                maxBufferSize: this.maxBufferSize,
                batchTimeout: this.batchTimeout,
                batchSize: this.batchSize,
                flushTimerActive: !!this.flushTimer
            },
            deadLetter: {
                count: this.deadLetterQueue.length,
                max: this.maxDeadLetterQueueSize,
                messages: this.deadLetterQueue.slice(-5) // 最近5条
            },
            idempotency: {
                processedCount: this.processedMessages.size,
                limit: this.processedMessagesLimit,
                duplicateCount: this.metrics.duplicateMessageCount
            },
            circuitBreaker: {
                localState: this.publishBreaker.getStatus(),
                trips: this.metrics.circuitBreakerTrips
            },
            overflow: {
                count: this.metrics.bufferOverflowCount
            }
        };
    }

    /**
     * 6. 监控指标增强 - 重置指标
     */
    resetMetrics() {
        this.metrics = {
            bufferOverflowCount: 0,
            deadLetterCount: 0,
            duplicateMessageCount: 0,
            circuitBreakerTrips: 0,
            processingTime: []
        };
        metrics.reset();
    }

    /**
     * 7. Mock模式增强 - 模拟延迟
     */
    async _mockDelay(duration) {
        if (this.isMockMode && process.env.NODE_ENV === 'test') {
            return new Promise(resolve => setTimeout(resolve, duration));
        }
    }

    /**
     * 7. Mock模式增强 - 注入错误
     */
    _mockInjectError(errorType) {
        if (this.isMockMode && process.env.NODE_ENV === 'test') {
            throw new Error(`MOCK_ERROR_${errorType}`);
        }
    }

    /**
      * 7. Mock模式增强 - 增强Mock功能（供测试使用）
      */
    simulateDelay(duration) {
        if (this.isMockMode) {
            return new Promise(resolve => setTimeout(resolve, duration));
        }
        return Promise.resolve();
    }

    injectError(errorType) {
        if (this.isMockMode) {
            // 不直接抛出错误，而是设置错误状态，让 enqueue 在内部处理
            this._mockInjectError(errorType);
        }
    }

    /**
     * 7. Mock模式增强 - 获取增强的Mock对象（供测试使用）
     */
    getEnhancedMock() {
        if (!this.isMockMode) {
            throw new Error('Not in mock mode');
        }
        
        return {
            simulateDelay: (duration) => this.simulateDelay(duration),
            injectError: (errorType) => this.injectError(errorType),
            getMetrics: () => this.getMetrics(),
            getDeadLetterQueue: () => this.getDeadLetterQueue(),
            getProcessedMessages: () => this.getProcessedMessages(),
            clearProcessedMessages: () => this.clearProcessedMessages(),
            clearDeadLetterQueue: () => this.clearDeadLetterQueue(),
            getQueueStatus: () => this.getQueueStatus(),
            // 模拟缓冲区溢出
            simulateBufferOverflow: async (messageCount) => {
                if (!this.isMockMode) return;
                const originalMax = this.maxBufferSize;
                this.maxBufferSize = Math.min(messageCount - 1, 10); // 强制溢出
                for (let i = 0; i < messageCount; i++) {
                    await this._addToBuffer({
                        topic: 'test',
                        message: { id: i },
                        options: {},
                        resolve: () => {}
                    });
                }
                this.maxBufferSize = originalMax;
            },
            // 模拟熔断器触发
            simulateCircuitBreaker: async () => {
                if (!this.isMockMode) return;
                // 强制打开熔断器
                this.publishBreaker.forceOpen();
            },
            // 模拟重复消息
            simulateDuplicateMessage: async (topic, message) => {
                if (!this.isMockMode) return;
                // 发送两次相同的消息
                const result1 = await this._publishWithIdempotency(topic, message);
                const result2 = await this._publishWithIdempotency(topic, message);
                return { first: result1, second: result2 };
            },
            // 模拟死信队列重试
            simulateDLQRetry: async (dlqId) => {
                if (!this.isMockMode) return;
                return await this.retryDeadLetterMessage(dlqId);
            },
            // 获取缓冲区内容（用于测试验证）
            getBufferContent: () => {
                return this.buffer;
            },
            // 清空所有状态
            clearAllState: () => {
                this.buffer = [];
                this.processedMessages.clear();
                this.deadLetterQueue = [];
                this.resetMetrics();
            },
            // 设置配置（用于测试）
            setConfig: (config) => {
                if (config.maxBufferSize !== undefined) this.maxBufferSize = config.maxBufferSize;
                if (config.batchSize !== undefined) this.batchSize = config.batchSize;
                if (config.batchTimeout !== undefined) this.batchTimeout = config.batchTimeout;
                if (config.maxDeadLetterQueueSize !== undefined) this.maxDeadLetterQueueSize = config.maxDeadLetterQueueSize;
                if (config.processedMessagesLimit !== undefined) this.processedMessagesLimit = config.processedMessagesLimit;
            },
            // 获取内部状态（用于测试验证）
            getInternalState: () => {
                return {
                    buffer: this.buffer,
                    processedMessages: Array.from(this.processedMessages),
                    deadLetterQueue: this.deadLetterQueue,
                    metrics: this.metrics,
                    maxBufferSize: this.maxBufferSize,
                    processedMessagesLimit: this.processedMessagesLimit,
                    maxDeadLetterQueueSize: this.maxDeadLetterQueueSize
                };
            },
            // 模拟分布式熔断器状态同步
            simulateDistributedCircuitSync: async (globalState) => {
                if (!this.isMockMode) return;
                if (this.redisClient) {
                    await this.redisClient.setex(
                        'qstash:circuit:state',
                        60,
                        JSON.stringify(globalState)
                    );
                }
            },
            // 模拟处理消息（用于测试幂等性）
            simulateProcessMessage: async (topic, message) => {
                if (!this.isMockMode) return;
                const messageId = this._generateMessageId(topic, message);
                const isDuplicate = this.processedMessages.has(messageId);
                if (!isDuplicate) {
                    this._addProcessedMessage(messageId);
                }
                return { messageId, isDuplicate };
            },
            // 模拟批量处理
            simulateBatchProcessing: async (batchSize) => {
                if (!this.isMockMode) return;
                const results = [];
                for (let i = 0; i < batchSize; i++) {
                    const result = await this._publishWithIdempotency('test', { id: i });
                    results.push(result);
                }
                return results;
            },
            // 模拟顺序处理验证
            simulateSequentialProcessing: async (messageCount) => {
                if (!this.isMockMode) return;
                const processingOrder = [];
                for (let i = 0; i < messageCount; i++) {
                    processingOrder.push(i);
                    await this._publishWithIdempotency('test', { order: i });
                }
                return processingOrder;
            },
            // 模拟缓冲区刷新
            simulateBufferFlush: async () => {
                if (!this.isMockMode) return;
                if (this.buffer.length > 0) {
                    return await this._flushBuffer();
                }
            }
        };
    }

    // 这些方法已在前面定义过，移除重复

    /**
     * 获取队列状态（供监控使用）
     */
    getQueueStatus() {
        return {
            buffer: {
                size: this.buffer.length,
                maxSize: this.maxBufferSize,
                batchTimeout: this.batchTimeout,
                batchSize: this.batchSize
            },
            deadLetter: {
                count: this.deadLetterQueue.length,
                max: this.maxDeadLetterQueueSize
            },
            idempotency: {
                processedCount: this.processedMessages.size,
                limit: this.processedMessagesLimit
            },
            circuitBreaker: this.publishBreaker.getStatus(),
            metrics: this.metrics,
            isMockMode: this.isMockMode
        };
    }

    /**
     * 添加任务到队列（供测试使用）
     */
    async enqueue(topic, message, options = {}) {
        // 在 Mock 模式下，直接处理消息而不等待缓冲区刷新
        if (this.isMockMode) {
            // 检查缓冲区大小限制
            if (this.buffer.length >= this.maxBufferSize) {
                // 触发溢出处理
                const dropCount = Math.floor(this.maxBufferSize * 0.1);
                const droppedMessages = this.buffer.splice(0, dropCount);
                this.metrics.bufferOverflowCount += dropCount;
                
                for (const droppedMsg of droppedMessages) {
                    this._addToDeadLetterQueue(droppedMsg, 'buffer_overflow');
                }
            }

            // 检查是否需要直接发送（不使用缓冲区）
            if (this.batchSize <= 1 || options.forceDirect) {
                try {
                    const result = await this._publishWithIdempotency(topic, message, options);
                    return result;
                } catch (error) {
                    // 加入死信队列
                    this._addToDeadLetterQueue({ topic, message, options }, 'publish_failed', error);
                    return {
                        messageId: "fallback-message-id",
                        fallback: true,
                        error: error.message
                    };
                }
            } else {
                // 使用缓冲区
                return this._addToBuffer({ topic, message, options });
            }
        } else {
            // 生产模式，使用原有逻辑
            return this._publish(topic, message, options);
        }
    }

    /**
     * 重写父类方法 - 批量发布（QStash 特有实现）
     */
    async _batchPublish(messages) {
        if (this.isMockMode) {
            // 模拟延迟（如果配置）
            if (process.env.QSTASH_MOCK_DELAY) {
                await this._mockDelay(parseInt(process.env.QSTASH_MOCK_DELAY));
            }
            
            // 模拟错误注入
            if (process.env.QSTASH_MOCK_ERROR) {
                this._mockInjectError(process.env.QSTASH_MOCK_ERROR);
            }

            return messages.map(() => ({ messageId: "mock-message-id" }));
        }

        // 5. 分布式熔断器 - 同步状态
        await this._syncCircuitBreakerState();

        return this.publishBreaker.execute(
            () => this._executeBatch(messages),
            () => messages.map(() => ({ messageId: "fallback-message-id", fallback: true }))
        );
    }

    /**
     * 重写父类方法 - 执行批量任务（QStash 特有实现）
     */
    async _executeBatch(messages) {
        const maxConcurrent = parseInt(process.env.QSTASH_MAX_CONCURRENT) || 5;
        
        // 6. 监控指标 - 记录开始时间
        const batchStartTime = Date.now();
        
        // 调用父类的 _executeBatch，传入 QStash 特有的单个任务执行函数
        const results = await super._executeBatch(
            messages,
            maxConcurrent,
            async (msg) => {
                // 6. 监控指标 - 记录单个任务时间
                const startTime = Date.now();
                try {
                    const result = await this.client.publishJSON({
                        url: msg.topic,
                        body: msg.message
                    });
                    metrics.timing('publish.time', Date.now() - startTime);
                    metrics.increment('messages.processed.total');
                    return result;
                } catch (error) {
                    metrics.increment(`messages.status.${error.code || 500}`);
                    throw error;
                }
            },
            '[QstashQueue]'
        );

        // 6. 监控指标 - 记录批次时间
        metrics.timing('batch.processing.time', Date.now() - batchStartTime);
        
        return results;
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
