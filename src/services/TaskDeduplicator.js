/**
 * TaskDeduplicator - 任务去重服务
 * 解决任务重复处理问题
 * 
 * 功能特性：
 * 1. 任务唯一性标识
 * 2. 分布式去重
 * 3. 任务状态追踪
 * 4. 重复检测与跳过
 * 5. 任务去重窗口管理
 */

class TaskDeduplicator {
    /**
     * @param {Object} cache - 缓存服务实例
     * @param {Object} options - 配置选项
     */
    constructor(cache, options = {}) {
        this.cache = cache;
        this.logger = options.logger || console;
        
        // 去重窗口配置
        this.dedupWindow = options.dedupWindow || 3600; // 1小时（秒）
        this.maxTaskAge = options.maxTaskAge || 86400; // 24小时
        
        // 任务状态存储前缀
        this.taskPrefix = options.taskPrefix || 'task:';
        this.processingPrefix = options.processingPrefix || 'processing:';
        this.resultPrefix = options.resultPrefix || 'result:';
        
        // 并发控制
        this.maxConcurrent = options.maxConcurrent || 10;
        this.activeTasks = new Map();
        
        // 任务去重键生成器
        this.taskKeyGenerator = options.taskKeyGenerator || this._defaultTaskKeyGenerator;
    }

    /**
     * 注册任务并检查是否已存在
     */
    async registerTask(taskData, options = {}) {
        const {
            dedupKey = null,
            ttl = this.dedupWindow,
            allowDuplicate = false
        } = options;

        // 生成任务唯一标识
        const taskKey = dedupKey || this.taskKeyGenerator(taskData);
        const fullKey = this.taskPrefix + taskKey;

        // 检查任务是否已存在
        const existingTask = await this.cache.get(fullKey);

        if (existingTask) {
            // 检查任务状态
            const isProcessing = await this._isProcessing(taskKey);
            const isCompleted = existingTask.status === 'completed';
            const isFailed = existingTask.status === 'failed';
            const isExpired = (Date.now() - existingTask.createdAt) > (this.maxTaskAge * 1000);

            // 如果允许重复且任务已完成或失败，可以重新执行
            if (allowDuplicate && (isCompleted || isFailed || isExpired)) {
                // 删除旧记录
                await this.cache.delete(fullKey);
                await this.cache.delete(this.processingPrefix + taskKey);
                await this.cache.delete(this.resultPrefix + taskKey);
            } else {
                // 返回去重结果
                return {
                    registered: false,
                    reason: 'duplicate',
                    taskKey: taskKey,
                    status: existingTask.status,
                    createdAt: existingTask.createdAt,
                    isProcessing: isProcessing,
                    message: `Task ${taskKey} already exists with status: ${existingTask.status}`
                };
            }
        }

        // 注册新任务
        const taskInfo = {
            taskKey: taskKey,
            data: taskData,
            status: 'pending',
            createdAt: Date.now(),
            attempts: 0,
            ttl: ttl
        };

        const success = await this.cache.set(fullKey, taskInfo, ttl);

        if (success) {
            this.logger.info(`Task registered: ${taskKey}`, { taskData });
            return {
                registered: true,
                taskKey: taskKey,
                status: 'pending'
            };
        } else {
            return {
                registered: false,
                reason: 'storage_error',
                message: 'Failed to register task'
            };
        }
    }

    /**
     * 开始处理任务（获取处理锁）
     */
    async beginProcessing(taskKey, workerId, options = {}) {
        const {
            lockTTL = 300, // 5分钟
            maxProcessingTime = 600 // 10分钟
        } = options;

        const fullKey = this.taskPrefix + taskKey;
        const processingKey = this.processingPrefix + taskKey;

        // 检查任务是否存在
        const taskInfo = await this.cache.get(fullKey);
        if (!taskInfo) {
            return {
                canProcess: false,
                reason: 'not_found',
                message: `Task ${taskKey} not found`
            };
        }

        // 检查任务状态
        if (taskInfo.status === 'completed') {
            return {
                canProcess: false,
                reason: 'already_completed',
                message: `Task ${taskKey} already completed`
            };
        }

        if (taskInfo.status === 'processing') {
            // 检查是否超时
            const processingInfo = await this.cache.get(processingKey);
            if (processingInfo) {
                const elapsed = Date.now() - processingInfo.startedAt;
                if (elapsed < maxProcessingTime * 1000) {
                    return {
                        canProcess: false,
                        reason: 'already_processing',
                        message: `Task ${taskKey} is being processed by ${processingInfo.workerId}`,
                        workerId: processingInfo.workerId,
                        elapsed: elapsed
                    };
                } else {
                    // 处理超时，允许抢占
                    this.logger.warn(`Task ${taskKey} processing timeout, allowing抢占`);
                }
            }
        }

        // 尝试获取处理锁
        const processingInfo = {
            taskKey: taskKey,
            workerId: workerId,
            startedAt: Date.now(),
            lockTTL: lockTTL
        };

        const acquired = await this.cache.set(processingKey, processingInfo, lockTTL);

        if (acquired) {
            // 更新任务状态
            taskInfo.status = 'processing';
            taskInfo.processingWorker = workerId;
            taskInfo.processingStartedAt = Date.now();
            taskInfo.attempts = (taskInfo.attempts || 0) + 1;
            
            await this.cache.set(fullKey, taskInfo, taskInfo.ttl);

            // 记录活跃任务
            this.activeTasks.set(taskKey, {
                workerId: workerId,
                startedAt: Date.now()
            });

            return {
                canProcess: true,
                taskKey: taskKey,
                workerId: workerId,
                taskData: taskInfo.data,
                attempt: taskInfo.attempts
            };
        } else {
            return {
                canProcess: false,
                reason: 'lock_failed',
                message: `Failed to acquire processing lock for ${taskKey}`
            };
        }
    }

    /**
     * 完成任务处理
     */
    async completeProcessing(taskKey, workerId, result, options = {}) {
        const { ttl = this.dedupWindow } = options;

        const fullKey = this.taskPrefix + taskKey;
        const processingKey = this.processingPrefix + taskKey;
        const resultKey = this.resultPrefix + taskKey;

        // 验证处理者身份
        const processingInfo = await this.cache.get(processingKey);
        if (!processingInfo || processingInfo.workerId !== workerId) {
            return {
                success: false,
                reason: 'not_owner',
                message: `Worker ${workerId} does not own task ${taskKey}`
            };
        }

        // 保存结果
        const resultData = {
            taskKey: taskKey,
            result: result,
            completedAt: Date.now(),
            workerId: workerId,
            processingTime: Date.now() - processingInfo.startedAt
        };

        await this.cache.set(resultKey, resultData, ttl);

        // 更新任务状态
        const taskInfo = await this.cache.get(fullKey);
        if (taskInfo) {
            taskInfo.status = 'completed';
            taskInfo.completedAt = Date.now();
            taskInfo.resultKey = resultKey;
            taskInfo.processingTime = resultData.processingTime;
            
            await this.cache.set(fullKey, taskInfo, ttl);
        }

        // 释放处理锁
        await this.cache.delete(processingKey);

        // 清理活跃任务记录
        this.activeTasks.delete(taskKey);

        this.logger.info(`Task completed: ${taskKey}`, { processingTime: resultData.processingTime });

        return {
            success: true,
            taskKey: taskKey,
            result: result,
            processingTime: resultData.processingTime
        };
    }

    /**
     * 标记任务失败
     */
    async failProcessing(taskKey, workerId, error, options = {}) {
        const { ttl = this.dedupWindow, retryable = true } = options;

        const fullKey = this.taskPrefix + taskKey;
        const processingKey = this.processingPrefix + taskKey;

        // 验证处理者身份
        const processingInfo = await this.cache.get(processingKey);
        if (!processingInfo || processingInfo.workerId !== workerId) {
            return {
                success: false,
                reason: 'not_owner'
            };
        }

        // 更新任务状态
        const taskInfo = await this.cache.get(fullKey);
        if (taskInfo) {
            taskInfo.status = retryable ? 'failed_retryable' : 'failed';
            taskInfo.failedAt = Date.now();
            taskInfo.error = error.message || String(error);
            taskInfo.processingTime = Date.now() - processingInfo.startedAt;
            
            await this.cache.set(fullKey, taskInfo, ttl);
        }

        // 释放处理锁
        await this.cache.delete(processingKey);

        // 清理活跃任务记录
        this.activeTasks.delete(taskKey);

        this.logger.error(`Task failed: ${taskKey}`, { error: error.message });

        return {
            success: true,
            taskKey: taskKey,
            error: error.message
        };
    }

    /**
     * 获取任务状态
     */
    async getTaskStatus(taskKey) {
        const fullKey = this.taskPrefix + taskKey;
        const processingKey = this.processingPrefix + taskKey;
        const resultKey = this.resultPrefix + taskKey;

        const [taskInfo, processingInfo, resultInfo] = await Promise.all([
            this.cache.get(fullKey),
            this.cache.get(processingKey),
            this.cache.get(resultKey)
        ]);

        if (!taskInfo) {
            return {
                exists: false,
                taskKey: taskKey
            };
        }

        const status = {
            exists: true,
            taskKey: taskKey,
            status: taskInfo.status,
            createdAt: taskInfo.createdAt,
            attempts: taskInfo.attempts || 0,
            data: taskInfo.data
        };

        if (processingInfo) {
            status.processing = {
                workerId: processingInfo.workerId,
                startedAt: processingInfo.startedAt,
                elapsed: Date.now() - processingInfo.startedAt
            };
        }

        if (resultInfo) {
            status.result = resultInfo.result;
            status.completedAt = resultInfo.completedAt;
            status.processingTime = resultInfo.processingTime;
        }

        if (taskInfo.error) {
            status.error = taskInfo.error;
        }

        return status;
    }

    /**
     * 获取任务结果
     */
    async getTaskResult(taskKey, options = {}) {
        const { wait = false, timeout = 30 } = options;

        if (wait) {
            // 等待任务完成
            const startTime = Date.now();
            while ((Date.now() - startTime) < (timeout * 1000)) {
                const status = await this.getTaskStatus(taskKey);
                
                if (status.status === 'completed') {
                    return {
                        completed: true,
                        result: status.result,
                        processingTime: status.processingTime
                    };
                }
                
                if (status.status === 'failed' || status.status === 'failed_retryable') {
                    return {
                        completed: false,
                        error: status.error
                    };
                }

                await new Promise(resolve => setTimeout(resolve, 100));
            }

            return {
                completed: false,
                timeout: true,
                message: `Timeout waiting for task ${taskKey}`
            };
        } else {
            // 不等待，直接返回结果
            const resultKey = this.resultPrefix + taskKey;
            const resultInfo = await this.cache.get(resultKey);

            if (resultInfo) {
                return {
                    completed: true,
                    result: resultInfo.result,
                    processingTime: resultInfo.processingTime
                };
            } else {
                return {
                    completed: false,
                    message: `No result found for task ${taskKey}`
                };
            }
        }
    }

    /**
     * 清理过期任务
     */
    async cleanupExpired() {
        // 这里需要缓存服务支持扫描或列出键的功能
        // 如果不支持，可以维护一个任务索引
        this.logger.info('Cleanup expired tasks - requires cache with listKeys support');
        return { cleaned: 0 };
    }

    /**
     * 获取统计信息
     */
    async getStats() {
        // 这里需要缓存服务支持键扫描
        // 返回统计信息
        return {
            activeTasks: this.activeTasks.size,
            activeTaskList: Array.from(this.activeTasks.entries()).map(([key, info]) => ({
                taskKey: key,
                workerId: info.workerId,
                elapsed: Date.now() - info.startedAt
            }))
        };
    }

    // 私有方法

    async _isProcessing(taskKey) {
        const processingKey = this.processingPrefix + taskKey;
        const processingInfo = await this.cache.get(processingKey);
        return !!processingInfo;
    }

    _defaultTaskKeyGenerator(taskData) {
        // 生成基于任务数据的唯一键
        const dataStr = JSON.stringify(taskData);
        let hash = 0;
        for (let i = 0; i < dataStr.length; i++) {
            const char = dataStr.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // 转换为32位整数
        }
        return `task-${Math.abs(hash).toString(36)}-${Date.now()}`;
    }
}

export { TaskDeduplicator };