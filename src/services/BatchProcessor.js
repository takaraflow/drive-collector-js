import { logger } from "./logger/index.js";
import { queueService } from "./QueueService.js";
import { instanceCoordinator } from "./InstanceCoordinator.js";
import { cache } from "./CacheService.js";
import { localCache } from "../utils/LocalCache.js";

const log = logger.withModule('BatchProcessor');

/**
 * 批量处理器服务
 * 职责：
 * 1. 批量任务处理
 * 2. 任务分片和并行执行
 * 3. 批量状态跟踪
 */
export class BatchProcessor {
    constructor() {
        this.batchPrefix = 'batch:';
        this.processingPrefix = 'processing:';
        this.maxBatchSize = 100;
        this.maxConcurrentBatches = 5;
        this.activeBatches = new Map();
        this.batchQueue = [];
    }

    /**
     * 创建批量任务
     * @param {string} batchType - 批量类型
     * @param {Array} items - 任务项
     * @param {Object} options - 选项
     * @returns {Promise<string>} 批量ID
     */
    async createBatch(batchType, items, options = {}) {
        const batchId = `${batchType}:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
        const { userId, priority = 'normal', metadata = {} } = options;

        // 验证批量大小
        if (items.length > this.maxBatchSize) {
            log.warn(`Batch size ${items.length} exceeds maximum ${this.maxBatchSize}`);
            items = items.slice(0, this.maxBatchSize);
        }

        const batch = {
            id: batchId,
            type: batchType,
            items,
            userId,
            priority,
            metadata,
            status: 'pending',
            createdAt: Date.now(),
            processedCount: 0,
            failedCount: 0,
            results: []
        };

        // 存储批量任务
        const cacheKey = `${this.batchPrefix}${batchId}`;
        await cache.set(cacheKey, batch, 3600);

        // 加入处理队列
        this.batchQueue.push({ batchId, priority, timestamp: Date.now() });
        this.batchQueue.sort((a, b) => this._getPriorityValue(b.priority) - this._getPriorityValue(a.priority));

        log.info(`Batch created: ${batchId}, items: ${items.length}, priority: ${priority}`);
        
        // 触发处理
        this._processQueue();

        return batchId;
    }

    /**
     * 获取批量任务状态
     * @param {string} batchId - 批量ID
     * @returns {Promise<Object>} 批量状态
     */
    async getBatchStatus(batchId) {
        const cacheKey = `${this.batchPrefix}${batchId}`;
        const batch = await cache.get(cacheKey);
        
        if (!batch) {
            return null;
        }

        // 计算进度
        const total = batch.items.length;
        const processed = batch.processedCount;
        const failed = batch.failedCount;
        const progress = total > 0 ? (processed + failed) / total : 0;

        return {
            ...batch,
            progress,
            remaining: total - processed - failed,
            isComplete: progress >= 1
        };
    }

    /**
     * 处理单个批量任务
     * @param {string} batchId - 批量ID
     * @param {Function} processor - 处理函数
     * @returns {Promise<Object>} 处理结果
     */
    async processBatch(batchId, processor) {
        const lockName = `batch_process:${batchId}`;
        const acquired = await instanceCoordinator.acquireLock(lockName, 120);
        
        if (!acquired) {
            log.warn(`Failed to acquire lock for batch: ${batchId}`);
            return { success: false, reason: 'lock_failed' };
        }

        try {
            // 获取批量任务
            const batch = await this._getBatch(batchId);
            if (!batch || batch.status === 'completed') {
                return { success: false, reason: 'batch_not_found_or_completed' };
            }

            // 标记为处理中
            batch.status = 'processing';
            await this._updateBatch(batch);

            // 分片处理
            const results = await this._processItemsInChunks(batch, processor);

            // 更新批量状态
            batch.processedCount = results.filter(r => r.success).length;
            batch.failedCount = results.filter(r => !r.success).length;
            batch.results = results;
            batch.status = 'completed';
            batch.completedAt = Date.now();

            await this._updateBatch(batch);

            log.info(`Batch processed: ${batchId}, success: ${batch.processedCount}, failed: ${batch.failedCount}`);

            return {
                success: true,
                batchId,
                processed: batch.processedCount,
                failed: batch.failedCount,
                results
            };
        } catch (error) {
            log.error(`Batch processing failed for ${batchId}:`, error);
            
            // 标记为失败
            const batch = await this._getBatch(batchId);
            if (batch) {
                batch.status = 'failed';
                batch.error = error.message;
                await this._updateBatch(batch);
            }

            return { success: false, error: error.message };
        } finally {
            await instanceCoordinator.releaseLock(lockName);
            this.activeBatches.delete(batchId);
        }
    }

    /**
     * 批量处理多个任务项
     * @param {Array} items - 任务项
     * @param {Function} processor - 处理函数
     * @param {Object} options - 选项
     * @returns {Promise<Array>} 处理结果
     */
    async processItems(items, processor, options = {}) {
        const { concurrency = 5, batchSize = 20 } = options;

        const results = [];
        const batches = this._chunkArray(items, batchSize);

        for (const batch of batches) {
            // 并行处理批次内的项
            const batchResults = await Promise.all(
                batch.map(async (item, index) => {
                    try {
                        const result = await processor(item, index);
                        return { success: true, item, result };
                    } catch (error) {
                        return { success: false, item, error: error.message };
                    }
                })
            );

            results.push(...batchResults);

            // 控制整体并发
            if (batches.length > 1) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }

        return results;
    }

    /**
     * 监听批量任务完成
     * @param {string} batchId - 批量ID
     * @param {Function} callback - 回调函数
     */
    async onBatchComplete(batchId, callback) {
        const checkInterval = 1000;
        const maxWaitTime = 300000; // 5分钟
        const startTime = Date.now();

        const check = async () => {
            if (Date.now() - startTime > maxWaitTime) {
                callback(new Error('Batch timeout'));
                return;
            }

            const status = await this.getBatchStatus(batchId);
            
            if (!status) {
                callback(new Error('Batch not found'));
                return;
            }

            if (status.isComplete || status.status === 'failed') {
                callback(null, status);
                return;
            }

            setTimeout(check, checkInterval);
        };

        setTimeout(check, checkInterval);
    }

    /**
     * 获取队列长度
     */
    getQueueLength() {
        return this.batchQueue.length;
    }

    /**
     * 获取活跃批量数量
     */
    getActiveBatchCount() {
        return this.activeBatches.size;
    }

    /**
     * 处理队列
     * @private
     */
    async _processQueue() {
        // 检查并发限制
        if (this.activeBatches.size >= this.maxConcurrentBatches) {
            return;
        }

        // 检查队列
        if (this.batchQueue.length === 0) {
            return;
        }

        // 获取下一个批量
        const next = this.batchQueue.shift();
        if (!next) return;

        const { batchId } = next;

        // 检查是否已在处理
        if (this.activeBatches.has(batchId)) {
            return;
        }

        // 标记为活跃
        this.activeBatches.set(batchId, Date.now());

        // 异步处理
        this._processBatchAsync(batchId).catch(error => {
            log.error(`Async batch processing failed for ${batchId}:`, error);
            this.activeBatches.delete(batchId);
        });
    }

    /**
     * 异步处理批量任务
     * @private
     */
    async _processBatchAsync(batchId) {
        // 获取批量任务
        const batch = await this._getBatch(batchId);
        if (!batch) {
            this.activeBatches.delete(batchId);
            return;
        }

        // 根据类型选择处理器
        const processor = this._getProcessor(batch.type);
        if (!processor) {
            log.error(`No processor found for batch type: ${batch.type}`);
            this.activeBatches.delete(batchId);
            return;
        }

        // 处理
        const result = await this.processBatch(batchId, processor);
        
        // 清理活跃标记
        this.activeBatches.delete(batchId);

        // 继续处理队列
        setTimeout(() => this._processQueue(), 100);

        return result;
    }

    /**
     * 分片处理任务项
     * @private
     */
    async _processItemsInChunks(batch, processor) {
        const chunkSize = 10;
        const chunks = this._chunkArray(batch.items, chunkSize);
        const allResults = [];

        for (const chunk of chunks) {
            const chunkResults = await Promise.all(
                chunk.map(async (item, index) => {
                    try {
                        const result = await processor(item, batch);
                        return { success: true, item, result, index };
                    } catch (error) {
                        return { success: false, item, error: error.message, index };
                    }
                })
            );

            allResults.push(...chunkResults);

            // 小延迟避免过载
            if (chunks.length > 1) {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }

        return allResults;
    }

    /**
     * 获取批量任务
     * @private
     */
    async _getBatch(batchId) {
        const cacheKey = `${this.batchPrefix}${batchId}`;
        return await cache.get(cacheKey);
    }

    /**
     * 更新批量任务
     * @private
     */
    async _updateBatch(batch) {
        const cacheKey = `${this.batchPrefix}${batch.id}`;
        await cache.set(cacheKey, batch, 3600);
        
        // 发布更新事件
        await this._publishBatchUpdate(batch);
    }

    /**
     * 发布批量更新
     * @private
     */
    async _publishBatchUpdate(batch) {
        const event = {
            type: 'batch_update',
            batchId: batch.id,
            status: batch.status,
            progress: batch.processedCount / batch.items.length,
            timestamp: Date.now(),
            source: instanceCoordinator.getInstanceId()
        };

        try {
            await queueService.publish('batch_events', event);
        } catch (error) {
            log.warn('Failed to publish batch update:', error);
        }
    }

    /**
     * 获取处理器
     * @private
     */
    _getProcessor(type) {
        // 这里可以注册不同的处理器
        const processors = {
            'task_create': this._processTaskCreate.bind(this),
            'task_update': this._processTaskUpdate.bind(this),
            'file_upload': this._processFileUpload.bind(this)
        };

        return processors[type] || null;
    }

    /**
     * 默认处理器示例
     * @private
     */
    async _processTaskCreate(item, batch) {
        // 实际实现需要调用 TaskManager
        return { taskId: `task_${item.id}`, status: 'created' };
    }

    async _processTaskUpdate(item, batch) {
        return { taskId: item.id, status: 'updated' };
    }

    async _processFileUpload(item, batch) {
        return { fileId: item.id, status: 'uploaded' };
    }

    /**
     * 数组分片
     * @private
     */
    _chunkArray(array, size) {
        const chunks = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }

    /**
     * 获取优先级值
     * @private
     */
    _getPriorityValue(priority) {
        const priorityMap = {
            'critical': 100,
            'high': 75,
            'normal': 50,
            'low': 25
        };
        return priorityMap[priority] || 50;
    }

    /**
     * 清理已完成的批量任务
     */
    async cleanupCompletedBatches() {
        const cutoffTime = Date.now() - 3600000; // 1小时前

        try {
            // 这里需要遍历所有批量任务并清理
            // 实际实现需要批量扫描缓存
            log.info('Cleanup completed batches');
        } catch (error) {
            log.error('Cleanup failed:', error);
        }
    }

    /**
     * 获取统计信息
     */
    async getStats() {
        return {
            queueLength: this.batchQueue.length,
            activeBatches: this.activeBatches.size,
            maxBatchSize: this.maxBatchSize,
            maxConcurrentBatches: this.maxConcurrentBatches,
            instanceId: instanceCoordinator.getInstanceId()
        };
    }
}

// 单例导出
export const batchProcessor = new BatchProcessor();