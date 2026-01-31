/**
 * GracefulShutdown.js
 * 
 * 负责管理应用的优雅关闭流程
 * 1. 注册清理函数
 * 2. 捕获退出信号
 * 3. 按顺序清理资源
 * 4. 等待任务排空
 * 5. 在清理完成后退出进程
 */

import { logger } from "./logger/index.js";

const log = logger.withModule ? logger.withModule('GracefulShutdown') : logger;

export class GracefulShutdown {
    constructor() {
        this.shutdownHooks = [];
        this.isShuttingDown = false;
        this.shutdownTimeout = 30000; // 30秒超时
        this.taskDrainTimeout = 60000; // 60秒任务排空超时
        this.exitCode = 0;
        this.setupSignalHandlers();
        this.setupErrorHandlers();
        
        // 任务排空相关
        this.taskCheckInterval = null;
        this.activeTaskCount = 0;
        this.recoveryCheckInterval = null;
    }

    /**
     * 注册清理钩子
     * @param {Function} cleanupFn - 清理函数，应返回 Promise
     * @param {number} priority - 优先级，数字越小越先执行
     * @param {string} name - 钩子名称（用于日志）
     */
    register(cleanupFn, priority = 50, name = 'unknown') {
        this.shutdownHooks.push({ cleanupFn, priority, name });
        this.shutdownHooks.sort((a, b) => a.priority - b.priority);
        log.debug(`Registered shutdown hook: ${name} (priority: ${priority})`);
    }

    /**
     * 注册任务计数器函数
     * @param {Function} getTaskCountFn - 返回当前活跃任务数量的函数
     */
    registerTaskCounter(getTaskCountFn) {
        this.getTaskCountFn = getTaskCountFn;
        log.debug('Registered task counter function');
    }

    /**
     * 设置信号处理器
     */
    setupSignalHandlers() {
        const handleSignal = async (signal) => {
            // 诊断信息：记录信号来源
            const stack = new Error().stack;
            log.warn(`[SIGNAL-DIAGNOSTIC] Received ${signal} signal`);
            log.warn(`[SIGNAL-DIAGNOSTIC] Uptime: ${Math.floor(process.uptime())}s`);
            log.warn(`[SIGNAL-DIAGNOSTIC] Memory: ${JSON.stringify(process.memoryUsage())}`);
            log.warn(`[SIGNAL-DIAGNOSTIC] Active handles: ${process._getActiveHandles?.().length || 'N/A'}`);
            log.warn(`[SIGNAL-DIAGNOSTIC] Active requests: ${process._getActiveRequests?.().length || 'N/A'}`);

            // 检查是否在启动后很快就收到信号（可能是配置问题）
            if (process.uptime() < 300) { // 5分钟内
                log.error(`[SIGNAL-DIAGNOSTIC] ⚠️  Premature shutdown detected! Uptime only ${Math.floor(process.uptime())}s`);
                log.error(`[SIGNAL-DIAGNOSTIC] This suggests a configuration or health check issue`);
                // 设置退出码为125，让s6延迟重启
                this.exitCode = 125;
            }

            log.info(`Received ${signal} signal, initiating graceful shutdown...`);
            await this.shutdown(signal);
        };

        process.on('SIGTERM', () => handleSignal('SIGTERM'));
        process.on('SIGINT', () => handleSignal('SIGINT'));

        // 处理 SIGUSR2（用于热重载）
        process.on('SIGUSR2', async () => {
            log.info('Received SIGUSR2, performing graceful reload...');
            await this.shutdown('SIGUSR2', null, true); // reload mode
        });
    }

    /**
     * 设置错误处理器
     */
    setupErrorHandlers() {
        process.on('uncaughtException', async (err) => {
            log.error('FATAL: Uncaught Exception:', err);
            
            // 检查是否为可恢复的错误
            const isRecoverable = this.isRecoverableError(err);
            
            if (isRecoverable) {
                log.warn('Error is recoverable, attempting to continue...');
                return;
            }
            
            // 不可恢复错误，执行优雅关闭
            log.error('Unrecoverable error detected, initiating graceful shutdown...');
            this.exitCode = 1;
            await this.shutdown('uncaughtException', err);
        });

        process.on('unhandledRejection', async (reason, promise) => {
            log.error('FATAL: Unhandled Rejection:', reason);
            
            // 检查是否为可恢复的错误
            const isRecoverable = this.isRecoverableError(reason);
            
            if (isRecoverable) {
                log.warn('Rejection is recoverable, attempting to continue...');
                return;
            }
            
            // 不可恢复错误，执行优雅关闭
            log.error('Unrecoverable rejection detected, initiating graceful shutdown...');
            this.exitCode = 1;
            await this.shutdown('unhandledRejection', reason);
        });
    }

    /**
     * 判断错误是否可恢复
     */
    isRecoverableError(error) {
        if (!error) return false;
        
        const message = error.message || String(error);
        
        // 可恢复的错误列表
        const recoverablePatterns = [
            'TIMEOUT',
            'ETIMEDOUT',
            'ECONNREFUSED',
            'ECONNRESET',
            'EPIPE',
            'AUTH_KEY_DUPLICATED',
            'FLOOD',
            'Network error',
            'Connection lost',
            'Connection timeout',
            'Not connected'
        ];
        
        return recoverablePatterns.some(pattern => message.includes(pattern));
    }

    /**
     * 等待任务排空
     */
    async drainTasks() {
        if (!this.getTaskCountFn) {
            log.info('No task counter registered, skipping task draining');
            return;
        }

        log.info('Starting task draining...');
        
        const startTime = Date.now();
        let lastCount = -1;
        let noProgressCount = 0;

        return new Promise((resolve) => {
            this.taskCheckInterval = setInterval(() => {
                const count = this.getTaskCountFn();
                this.activeTaskCount = count;

                // 检查是否完成
                if (count <= 0) {
                    clearInterval(this.taskCheckInterval);
                    this.taskCheckInterval = null;
                    log.info('✅ All tasks drained');
                    resolve();
                    return;
                }

                // 日志进度
                if (count !== lastCount) {
                    log.info(`Task draining progress: ${count} active tasks remaining`);
                    lastCount = count;
                    noProgressCount = 0;
                } else {
                    noProgressCount++;
                }

                // 检查超时
                const elapsed = Date.now() - startTime;
                if (elapsed > this.taskDrainTimeout) {
                    clearInterval(this.taskCheckInterval);
                    this.taskCheckInterval = null;
                    log.warn(`⚠️ Task draining timeout after ${this.taskDrainTimeout}ms, ${count} tasks remaining`);
                    resolve(); // 继续关闭流程，不阻塞
                }

                // 检查是否长时间无进展
                if (noProgressCount > 20) { // 20秒无进展
                    log.warn('⚠️ Task draining stalled, continuing with shutdown...');
                    clearInterval(this.taskCheckInterval);
                    this.taskCheckInterval = null;
                    resolve();
                }
            }, 1000);
        });
    }

    /**
     * 执行优雅关闭
     */
    async shutdown(source = 'unknown', error = null, reloadMode = false) {
        if (this.isShuttingDown) {
            log.warn('Shutdown already in progress, ignoring duplicate request');
            return;
        }

        this.isShuttingDown = true;

        try {
            log.info(`Starting graceful shutdown (source: ${source}, reload: ${reloadMode})...`);
            
            if (error) {
                log.error('Shutdown reason:', error.message || error);
            }

            // 1. 停止接受新请求（优先级最高）
            const httpServerHook = this.shutdownHooks.find(h => h.name === 'http-server');
            if (httpServerHook) {
                try {
                    await httpServerHook.cleanupFn();
                } catch (e) {
                    log.error('Failed to stop HTTP server:', e);
                }
            }

            // 2. 等待任务排空
            await this.drainTasks();

            // 3. 执行其他清理钩子（按优先级）
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Graceful shutdown timeout')), this.shutdownTimeout);
            });

            const cleanupPromise = this.executeCleanupHooks(reloadMode);

            await Promise.race([cleanupPromise, timeoutPromise]);

            log.info('Graceful shutdown completed successfully');

            if (reloadMode) {
                log.info('Reload mode: Process will continue running');
                this.isShuttingDown = false;
                
                // 触发业务模块重启
                setTimeout(async () => {
                    try {
                        const { AppInitializer } = await import("../bootstrap/AppInitializer.js");
                        const appInitializer = new AppInitializer();
                        await appInitializer.startBusinessModules();
                    } catch (e) {
                        log.error('Failed to restart business modules after reload:', e);
                    }
                }, 1000);
                
                return;
            }

        } catch (err) {
            log.error('Error during graceful shutdown:', err);
            this.exitCode = 1;
        } finally {
            // 清理任务检查间隔
            if (this.taskCheckInterval) {
                clearInterval(this.taskCheckInterval);
                this.taskCheckInterval = null;
            }

            // 确保进程退出（非重载模式）
            if (!reloadMode) {
                log.info(`[SHUTDOWN] About to exit process`);
                log.info(`[SHUTDOWN] Exit code: ${this.exitCode}`);
                log.info(`[SHUTDOWN] Source: ${source}`);
                log.info(`[SHUTDOWN] Uptime: ${Math.floor(process.uptime())}s`);

                // 诊断信息
                if (this.exitCode === 125) {
                    log.warn(`[SHUTDOWN] Exit code 125 = s6-overlay will restart after delay`);
                } else if (this.exitCode === 0) {
                    log.info(`[SHUTDOWN] Exit code 0 = normal exit, s6-overlay will NOT restart`);
                } else {
                    log.error(`[SHUTDOWN] Exit code ${this.exitCode} = error exit, s6-overlay will restart`);
                }

                // 延迟退出，确保日志发送完成
                setTimeout(() => {
                    log.info(`[SHUTDOWN] Calling process.exit(${this.exitCode}) now`);
                    process.exit(this.exitCode);
                }, 1000);
            }
        }
    }

    stopRecoveryCheck() {
        if (this.recoveryCheckInterval) {
            clearInterval(this.recoveryCheckInterval);
            this.recoveryCheckInterval = null;
        }
    }

    /**
     * 按优先级执行清理钩子
     */
    async executeCleanupHooks(reloadMode = false) {
        // 跳过 http-server 钩子（已在 shutdown 开始时执行）
        const hooksToExecute = this.shutdownHooks.filter(h => h.name !== 'http-server');

        log.info(`Executing ${hooksToExecute.length} cleanup hooks...`);

        for (const hook of hooksToExecute) {
            // 跳过重载模式下不需要清理的钩子
            if (reloadMode && !hook.requiresCleanup) {
                log.info(`Skipping hook ${hook.name} (reload mode, not required)`);
                continue;
            }

            const startTime = Date.now();
            try {
                log.info(`Executing shutdown hook: ${hook.name}`);
                await hook.cleanupFn();
                const duration = Date.now() - startTime;
                log.info(`Shutdown hook ${hook.name} completed in ${duration}ms`);
            } catch (err) {
                const duration = Date.now() - startTime;
                log.error(`Shutdown hook ${hook.name} failed after ${duration}ms:`, err);
                // 继续执行其他清理钩子
            }
        }
    }

    /**
     * 立即关闭（不执行清理钩子）
     * 仅在严重错误时使用
     */
    forceExit(code = 1) {
        log.error('Forcing immediate exit...');
        if (this.taskCheckInterval) {
            clearInterval(this.taskCheckInterval);
        }
        process.exit(code);
    }

    /**
     * 获取当前状态
     */
    getStatus() {
        return {
            isShuttingDown: this.isShuttingDown,
            activeTaskCount: this.activeTaskCount,
            shutdownHooksCount: this.shutdownHooks.length
        };
    }

    /**
     * 增强的任务排空 - 支持多层状态检查
     * 检查 D1、Redis、内存缓冲和 ConsistentCache 中的任务状态
     */
    async enhancedDrainTasks() {
        if (!this.getTaskCountFn) {
            log.info('No task counter registered, skipping enhanced task draining');
            return;
        }

        log.info('Starting enhanced task draining (multi-layer check)...');
        
        const startTime = Date.now();
        let lastCount = -1;
        let noProgressCount = 0;
        let layerChecks = 0;

        return new Promise((resolve) => {
            this.taskCheckInterval = setInterval(async () => {
                layerChecks++;
                
                // 1. 获取基础任务计数
                const count = this.getTaskCountFn();
                this.activeTaskCount = count;

                // 2. 每5次检查，进行多层状态验证
                if (layerChecks % 5 === 0) {
                    await this.verifyTaskConsistency();
                }

                // 检查是否完成
                if (count === 0) {
                    // 额外检查缓存层是否也已清空
                    const cacheEmpty = await this.checkCacheLayersEmpty();
                    
                    if (cacheEmpty) {
                        clearInterval(this.taskCheckInterval);
                        this.taskCheckInterval = null;
                        log.info('✅ All tasks drained (D1 + Cache layers)');
                        resolve();
                        return;
                    } else {
                        log.warn('⚠️ D1 empty but cache layers still have data, continuing drain...');
                    }
                }

                // 日志进度
                if (count !== lastCount) {
                    log.info(`Enhanced draining: ${count} active tasks, cache checks: ${layerChecks}`);
                    lastCount = count;
                    noProgressCount = 0;
                } else {
                    noProgressCount++;
                }

                // 检查超时
                const elapsed = Date.now() - startTime;
                if (elapsed > this.taskDrainTimeout) {
                    clearInterval(this.taskCheckInterval);
                    this.taskCheckInterval = null;
                    log.warn(`⚠️ Enhanced draining timeout after ${this.taskDrainTimeout}ms, ${count} tasks remaining`);
                    await this.forceDrainCleanup();
                    resolve();
                }

                // 检查是否长时间无进展
                if (noProgressCount > 20) {
                    log.warn('⚠️ Enhanced draining stalled, attempting force cleanup...');
                    clearInterval(this.taskCheckInterval);
                    this.taskCheckInterval = null;
                    await this.forceDrainCleanup();
                    resolve();
                }
            }, 1000);
        });
    }

    /**
     * 验证任务状态一致性
     * 检查各层缓存中的任务状态是否一致
     */
    async verifyTaskConsistency() {
        try {
            // 检查 ConsistentCache
            if (global.ConsistentCache) {
                const cacheKeys = await global.ConsistentCache.listKeys('task:*');
                if (cacheKeys.length > 0) {
                    log.info(`ConsistentCache layer: ${cacheKeys.length} task entries found`);
                }
            }

            // 检查 StateSynchronizer
            if (global.StateSynchronizer) {
                const syncTasks = await global.StateSynchronizer.getAllTaskStates();
                if (syncTasks.length > 0) {
                    log.info(`StateSynchronizer layer: ${syncTasks.length} task states found`);
                }
            }

            // 检查 Redis (通过 CacheService)
            if (global.cache) {
                const redisKeys = await global.cache.listKeys('task_status:*');
                if (redisKeys.length > 0) {
                    log.info(`Redis layer: ${redisKeys.length} task entries found`);
                }
            }
        } catch (e) {
            log.warn('Task consistency verification failed:', e.message);
        }
    }

    /**
     * 检查所有缓存层是否为空
     */
    async checkCacheLayersEmpty() {
        try {
            const checks = [];

            // Check ConsistentCache
            if (global.ConsistentCache) {
                checks.push(global.ConsistentCache.listKeys('task:*').then(keys => keys.length === 0));
            }

            // Check StateSynchronizer
            if (global.StateSynchronizer) {
                checks.push(global.StateSynchronizer.getAllTaskStates().then(states => states.length === 0));
            }

            // Check Redis
            if (global.cache) {
                checks.push(global.cache.listKeys('task_status:*').then(keys => keys.length === 0));
            }

            const results = await Promise.all(checks);
            return results.every(r => r === true);
        } catch (e) {
            log.warn('Cache layer empty check failed:', e.message);
            return false;
        }
    }

    /**
     * 强制清理缓存层
     * 在任务排空超时时，强制清理残留的缓存数据
     */
    async forceDrainCleanup() {
        log.info('Starting force drain cleanup...');

        try {
            // 1. 清理 ConsistentCache
            if (global.ConsistentCache) {
                const cacheKeys = await global.ConsistentCache.listKeys('task:*');
                if (cacheKeys.length > 0) {
                    log.info(`Force cleaning ${cacheKeys.length} ConsistentCache entries...`);
                    await Promise.allSettled(
                        cacheKeys.map(key => global.ConsistentCache.delete(key))
                    );
                }
            }

            // 2. 清理 StateSynchronizer
            if (global.StateSynchronizer) {
                const syncTasks = await global.StateSynchronizer.getAllTaskStates();
                if (syncTasks.length > 0) {
                    log.info(`Force cleaning ${syncTasks.length} StateSynchronizer entries...`);
                    await Promise.allSettled(
                        syncTasks.map(task => global.StateSynchronizer.clearTaskState(task.id))
                    );
                }
            }

            // 3. 清理 Redis
            if (global.cache) {
                const redisKeys = await global.cache.listKeys('task_status:*');
                if (redisKeys.length > 0) {
                    log.info(`Force cleaning ${redisKeys.length} Redis entries...`);
                    await Promise.allSettled(
                        redisKeys.map(key => global.cache.delete(key))
                    );
                }
            }

            log.info('✅ Force drain cleanup completed');
        } catch (e) {
            log.error('Force drain cleanup failed:', e);
        }
    }

    /**
     * 注册增强的任务计数器
     * 支持多层状态查询
     */
    registerEnhancedTaskCounter(enhancedCounterFn) {
        this.enhancedCounterFn = enhancedCounterFn;
        log.debug('Registered enhanced task counter function');
    }

    /**
     * 获取详细的任务状态报告
     */
    async getTaskStatusReport() {
        const report = {
            timestamp: new Date().toISOString(),
            d1Tasks: 0,
            cacheTasks: 0,
            syncTasks: 0,
            memoryTasks: this.pendingUpdates ? this.pendingUpdates.size : 0,
            totalEstimated: 0
        };

        try {
            // D1 tasks
            if (global.TaskRepository) {
                // 这里需要查询实际的 D1 任务，但为了性能，我们可能需要一个快速估算方法
                report.d1Tasks = 'unknown'; // 实际使用时可以添加快速查询方法
            }

            // Cache tasks
            if (global.ConsistentCache) {
                const cacheKeys = await global.ConsistentCache.listKeys('task:*');
                report.cacheTasks = cacheKeys.length;
            }

            // Sync tasks
            if (global.StateSynchronizer) {
                const syncTasks = await global.StateSynchronizer.getAllTaskStates();
                report.syncTasks = syncTasks.length;
            }

            // Memory tasks
            if (global.TaskRepository && global.TaskRepository.pendingUpdates) {
                report.memoryTasks = global.TaskRepository.pendingUpdates.size;
            }

            report.totalEstimated = report.cacheTasks + report.syncTasks + report.memoryTasks;

            return report;
        } catch (e) {
            log.error('Failed to generate task status report:', e);
            return report;
        }
    }

    /**
     * 等待任务排空（增强版）
     * 支持超时、进度报告和强制清理
     */
    async waitForTaskDrain(options = {}) {
        const {
            timeout = this.taskDrainTimeout,
            checkInterval = 1000,
            enableForceCleanup = true,
            enableProgressLog = true
        } = options;

        log.info(`Waiting for task drain (timeout: ${timeout}ms, forceCleanup: ${enableForceCleanup})`);

        const startTime = Date.now();
        let lastReport = null;

        while (Date.now() - startTime < timeout) {
            // 获取状态报告
            const report = await this.getTaskStatusReport();
            
            // 进度日志
            if (enableProgressLog && (!lastReport || JSON.stringify(report) !== JSON.stringify(lastReport))) {
                log.info(`Drain progress: ${report.totalEstimated} tasks remaining (D1:${report.d1Tasks}, Cache:${report.cacheTasks}, Sync:${report.syncTasks}, Memory:${report.memoryTasks})`);
                lastReport = report;
            }

            // 检查是否完成
            if (report.totalEstimated === 0) {
                log.info('✅ Task drain completed successfully');
                return true;
            }

            // 等待下一个检查周期
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }

        // 超时处理
        log.warn(`⚠️ Task drain timeout after ${timeout}ms`);

        if (enableForceCleanup) {
            log.info('Attempting force cleanup...');
            await this.forceDrainCleanup();
            
            // 再次检查
            const finalReport = await this.getTaskStatusReport();
            if (finalReport.totalEstimated === 0) {
                log.info('✅ Force cleanup successful');
                return true;
            } else {
                log.warn(`⚠️ Force cleanup incomplete, ${finalReport.totalEstimated} tasks remain`);
                return false;
            }
        }

        return false;
    }
}

// 导出单例
export const gracefulShutdown = new GracefulShutdown();

// 便捷函数
export const registerShutdownHook = (cleanupFn, priority, name) => {
    gracefulShutdown.register(cleanupFn, priority, name);
};

export const registerTaskCounter = (getTaskCountFn) => {
    gracefulShutdown.registerTaskCounter(getTaskCountFn);
};

export const registerEnhancedTaskCounter = (enhancedCounterFn) => {
    gracefulShutdown.registerEnhancedTaskCounter(enhancedCounterFn);
};

export const triggerShutdown = (source, error) => {
    gracefulShutdown.shutdown(source, error);
};

export const enhancedDrainTasks = () => {
    return gracefulShutdown.enhancedDrainTasks();
};

export const waitForTaskDrain = (options = {}) => {
    return gracefulShutdown.waitForTaskDrain(options);
};

export const getTaskStatusReport = () => {
    return gracefulShutdown.getTaskStatusReport();
};

export const forceDrainCleanup = () => {
    return gracefulShutdown.forceDrainCleanup();
};

export default gracefulShutdown;
