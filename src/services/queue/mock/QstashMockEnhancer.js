/**
 * QStash Queue Mock Enhancer
 * Provides enhanced mock capabilities for QstashQueue in testing environments
 */

export function createEnhancedMock(queue) {
    return {
        simulateDelay: (duration) => queue.simulateDelay(duration),
        injectError: (errorType) => queue.injectError(errorType),
        getMetrics: () => queue.getMetrics(),
        getDeadLetterQueue: () => queue.getDeadLetterQueue(),
        getProcessedMessages: () => queue.getProcessedMessages(),
        clearProcessedMessages: () => queue.clearProcessedMessages(),
        clearDeadLetterQueue: () => queue.clearDeadLetterQueue(),
        getQueueStatus: () => queue.getQueueStatus(),
        // 模拟缓冲区溢出
        simulateBufferOverflow: async (messageCount) => {
            if (!queue.isMockMode) return;
            const originalMax = queue.maxBufferSize;
            queue.maxBufferSize = Math.min(messageCount - 1, 10); // 强制溢出
            for (let i = 0; i < messageCount; i++) {
                await queue._addToBuffer({
                    topic: 'test',
                    message: { id: i },
                    options: {},
                    resolve: () => {}
                });
            }
            queue.maxBufferSize = originalMax;
        },
        // 模拟熔断器触发
        simulateCircuitBreaker: async () => {
            if (!queue.isMockMode) return;
            // 强制打开熔断器
            queue.publishBreaker.forceOpen();
        },
        // 模拟重复消息
        simulateDuplicateMessage: async (topic, message) => {
            if (!queue.isMockMode) return;
            // 发送两次相同的消息
            const result1 = await queue._publishWithIdempotency(topic, message);
            const result2 = await queue._publishWithIdempotency(topic, message);
            return { first: result1, second: result2 };
        },
        // 模拟死信队列重试
        simulateDLQRetry: async (dlqId) => {
            if (!queue.isMockMode) return;
            return await queue.retryDeadLetterMessage(dlqId);
        },
        // 获取缓冲区内容（用于测试验证）
        getBufferContent: () => {
            return queue.buffer;
        },
        // 清空所有状态
        clearAllState: () => {
            queue.buffer = [];
            queue.processedMessages.clear();
            queue.deadLetterQueue = [];
            queue.resetMetrics();
        },
        // 设置配置（用于测试）
        setConfig: (config) => {
            if (config.maxBufferSize !== undefined) queue.maxBufferSize = config.maxBufferSize;
            if (config.batchSize !== undefined) queue.batchSize = config.batchSize;
            if (config.batchTimeout !== undefined) queue.batchTimeout = config.batchTimeout;
            if (config.maxDeadLetterQueueSize !== undefined) queue.maxDeadLetterQueueSize = config.maxDeadLetterQueueSize;
            if (config.processedMessagesLimit !== undefined) queue.processedMessagesLimit = config.processedMessagesLimit;
        },
        // 获取内部状态（用于测试验证）
        getInternalState: () => {
            return {
                buffer: queue.buffer,
                processedMessages: Array.from(queue.processedMessages),
                deadLetterQueue: queue.deadLetterQueue,
                metrics: queue.metrics,
                maxBufferSize: queue.maxBufferSize,
                processedMessagesLimit: queue.processedMessagesLimit,
                maxDeadLetterQueueSize: queue.maxDeadLetterQueueSize
            };
        },
        // 模拟分布式熔断器状态同步
        simulateDistributedCircuitSync: async (globalState) => {
            if (!queue.isMockMode) return;
            if (queue.redisClient) {
                await queue.redisClient.setex(
                    'qstash:circuit:state',
                    60,
                    JSON.stringify(globalState)
                );
            }
        },
        // 模拟处理消息（用于测试幂等性）
        simulateProcessMessage: async (topic, message) => {
            if (!queue.isMockMode) return;
            const messageId = queue._generateMessageId(topic, message);
            const isDuplicate = queue.processedMessages.has(messageId);
            if (!isDuplicate) {
                queue._addProcessedMessage(messageId);
            }
            return { messageId, isDuplicate };
        },
        // 模拟批量处理
        simulateBatchProcessing: async (batchSize) => {
            if (!queue.isMockMode) return;
            const results = [];
            for (let i = 0; i < batchSize; i++) {
                const result = await queue._publishWithIdempotency('test', { id: i });
                results.push(result);
            }
            return results;
        },
        // 模拟顺序处理验证
        simulateSequentialProcessing: async (messageCount) => {
            if (!queue.isMockMode) return;
            const processingOrder = [];
            for (let i = 0; i < messageCount; i++) {
                processingOrder.push(i);
                await queue._publishWithIdempotency('test', { order: i });
            }
            return processingOrder;
        },
        // 模拟缓冲区刷新
        simulateBufferFlush: async () => {
            if (!queue.isMockMode) return;
            if (queue.buffer.length > 0) {
                return await queue._flushBuffer();
            }
        }
    };
}
