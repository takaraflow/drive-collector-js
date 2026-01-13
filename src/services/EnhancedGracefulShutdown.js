/**
 * EnhancedGracefulShutdown - 增强的优雅关闭服务
 * 解决优雅关闭不完整问题
 * 
 * 功能特性：
 * 1. 资源清理状态追踪
 * 2. 清理超时处理
 * 3. 依赖关系管理
 * 4. 清理结果验证
 * 5. 异常恢复机制
 */

import { logger } from "./logger/index.js";

const log = logger.withModule ? logger.withModule('EnhancedGracefulShutdown') : logger;

class EnhancedGracefulShutdown {
    constructor() {
        this.shutdownHooks = [];
        this.isShuttingDown = false;
        this.shutdownTimeout = 30000; // 30秒超时
        this.hookTimeout = 5000; // 单个钩子5秒超时
        this.exitCode = 0;
        
        // 状态追踪
        this.cleanupState = {
            started: false,
            completed: false,
            failed: false,
            startTime: null,
            endTime: null,
            hookResults: [],
            resourceStates: new Map()
        };
        
        // 依赖关系图
        this.dependencyGraph = new Map();
        
        // 信号处理
        this.setupSignalHandlers();
        this.setupErrorHandlers();
        
        // 心跳检查
        this.heartbeatInterval = null;
    }

    /**
     * 注册清理钩子（增强版）
     */
    register(cleanupFn, options = {}) {
        const {
            priority = 50,
            name = 'unknown',
            dependencies = [], // 依赖的其他钩子名称
            requiresCleanup = true, // 是否需要清理
            resourceType = 'unknown' // 资源类型
        } = options;

        const hook = {
            cleanupFn,
            priority,
            name,
            dependencies,
            requiresCleanup,
            resourceType,
            id: `${name}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            state: 'registered', // registered, running, completed, failed, timeout
            startTime: null,
            endTime: null,
            error: null,
            duration: null
        };

        this.shutdownHooks.push(hook);
        this._buildDependencyGraph();
        this._sortHooksByPriorityAndDeps();
        
        log.debug(`Registered enhanced shutdown hook: ${name} (priority: ${priority}, deps: ${dependencies.join(', ')})`);
        return hook.id;
    }

    /**
     * 注册资源状态追踪器
     */
    registerResource(resourceId, resourceType, getStateFn) {
        this.cleanupState.resourceStates.set(resourceId, {
            type: resourceType,
            getStateFn,
            lastState: null,
            cleanupAttempts: 0
        });
        log.debug(`Registered resource tracker: ${resourceId} (${resourceType})`);
    }

    /**
     * 更新资源状态
     */
    async updateResourceState(resourceId) {
        const tracker = this.cleanupState.resourceStates.get(resourceId);
        if (!tracker || !tracker.getStateFn) return;

        try {
            const state = await tracker.getStateFn();
            tracker.lastState = state;
            return state;
        } catch (error) {
            log.warn(`Failed to get state for resource ${resourceId}:`, error.message);
            return null;
        }
    }

    /**
     * 构建依赖关系图
     */
    _buildDependencyGraph() {
        this.dependencyGraph.clear();
        
        // 初始化所有节点
        this.shutdownHooks.forEach(hook => {
            this.dependencyGraph.set(hook.name, new Set());
        });

        // 构建依赖关系
        this.shutdownHooks.forEach(hook => {
            hook.dependencies.forEach(dep => {
                if (this.dependencyGraph.has(dep)) {
                    this.dependencyGraph.get(dep).add(hook.name);
                }
            });
        });
    }

    /**
     * 按优先级和依赖关系排序钩子
     */
    _sortHooksByPriorityAndDeps() {
        // 使用拓扑排序确保依赖顺序
        const sorted = [];
        const visited = new Set();
        const temp = new Set();

        const visit = (hookName) => {
            if (temp.has(hookName)) {
                throw new Error(`Circular dependency detected: ${hookName}`);
            }
            if (visited.has(hookName)) return;

            temp.add(hookName);

            // 先访问依赖项
            const hook = this.shutdownHooks.find(h => h.name === hookName);
            if (hook) {
                hook.dependencies.forEach(dep => {
                    if (this.shutdownHooks.find(h => h.name === dep)) {
                        visit(dep);
                    }
                });
            }

            temp.delete(hookName);
            visited.add(hookName);

            // 添加到排序结果
            const hookObj = this.shutdownHooks.find(h => h.name === hookName);
            if (hookObj && !sorted.includes(hookObj)) {
                sorted.push(hookObj);
            }
        };

        // 按优先级分组处理
        const priorityGroups = {};
        this.shutdownHooks.forEach(hook => {
            if (!priorityGroups[hook.priority]) {
                priorityGroups[hook.priority] = [];
            }
            priorityGroups[hook.priority].push(hook);
        });

        // 按优先级从低到高处理
        Object.keys(priorityGroups).sort((a, b) => a - b).forEach(priority => {
            priorityGroups[priority].forEach(hook => {
                if (!visited.has(hook.name)) {
                    visit(hook.name);
                }
            });
        });

        // 添加未访问的钩子
        this.shutdownHooks.forEach(hook => {
            if (!sorted.includes(hook)) {
                sorted.push(hook);
            }
        });

        this.shutdownHooks = sorted;
    }

    /**
     * 设置信号处理器（增强版）
     */
    setupSignalHandlers() {
        const handleSignal = async (signal) => {
            log.info(`Received ${signal} signal, initiating enhanced graceful shutdown...`);
            
            // 启动心跳检查
            this.startHeartbeat(signal);
            
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
     * 设置错误处理器（增强版）
     */
    setupErrorHandlers() {
        process.on('uncaughtException', async (err) => {
            log.error('FATAL: Uncaught Exception:', err);
            
            const isRecoverable = this.isRecoverableError(err);
            
            if (isRecoverable) {
                log.warn('Error is recoverable, attempting to continue...');
                return;
            }
            
            log.error('Unrecoverable error detected, initiating emergency shutdown...');
            this.exitCode = 1;
            this.startHeartbeat('uncaughtException');
            await this.shutdown('uncaughtException', err);
        });

        process.on('unhandledRejection', async (reason, promise) => {
            log.error('FATAL: Unhandled Rejection:', reason);
            
            const isRecoverable = this.isRecoverableError(reason);
            
            if (isRecoverable) {
                log.warn('Rejection is recoverable, attempting to continue...');
                return;
            }
            
            log.error('Unrecoverable rejection detected, initiating emergency shutdown...');
            this.exitCode = 1;
            this.startHeartbeat('unhandledRejection');
            await this.shutdown('unhandledRejection', reason);
        });
    }

    /**
     * 启动心跳检查
     */
    startHeartbeat(source) {
        if (this.heartbeatInterval) return;

        let lastProgress = 0;
        let noProgressCount = 0;

        this.heartbeatInterval = setInterval(() => {
            const completed = this.cleanupState.hookResults.filter(r => r.state === 'completed').length;
            const total = this.shutdownHooks.length;
            const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

            if (progress !== lastProgress) {
                log.info(`Shutdown progress: ${progress}% (${completed}/${total} hooks completed)`);
                lastProgress = progress;
                noProgressCount = 0;
            } else {
                noProgressCount++;
                if (noProgressCount > 10) { // 10秒无进展
                    log.warn('Shutdown progress stalled for 10 seconds');
                }
            }

            // 检查是否超时
            if (this.cleanupState.startTime) {
                const elapsed = Date.now() - this.cleanupState.startTime;
                if (elapsed > this.shutdownTimeout) {
                    log.error(`Global shutdown timeout exceeded (${this.shutdownTimeout}ms), forcing exit...`);
                    this.forceExit(1);
                }
            }
        }, 1000);
    }

    /**
     * 停止心跳检查
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    /**
     * 判断错误是否可恢复
     */
    isRecoverableError(error) {
        if (!error) return false;
        
        const message = error.message || String(error);
        
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
     * 执行优雅关闭（增强版）
     */
    async shutdown(source = 'unknown', error = null, reloadMode = false) {
        if (this.isShuttingDown) {
            log.warn('Shutdown already in progress, ignoring duplicate request');
            return;
        }

        this.isShuttingDown = true;
        this.cleanupState.started = true;
        this.cleanupState.startTime = Date.now();

        try {
            log.info(`Starting enhanced graceful shutdown (source: ${source}, reload: ${reloadMode})...`);
            
            if (error) {
                log.error('Shutdown reason:', error.message || error);
            }

            // 记录初始资源状态
            await this._recordInitialResourceStates();

            // 执行清理钩子
            const cleanupPromise = this.executeCleanupHooks(reloadMode);

            // 设置全局超时
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Global shutdown timeout')), this.shutdownTimeout);
            });

            await Promise.race([cleanupPromise, timeoutPromise]);

            // 验证清理结果
            await this._validateCleanupResults();

            this.cleanupState.completed = true;
            this.cleanupState.endTime = Date.now();
            
            const duration = this.cleanupState.endTime - this.cleanupState.startTime;
            log.info(`Graceful shutdown completed successfully in ${duration}ms`);

            if (reloadMode) {
                log.info('Reload mode: Process will continue running');
                this.isShuttingDown = false;
                this.cleanupState = {
                    started: false,
                    completed: false,
                    failed: false,
                    startTime: null,
                    endTime: null,
                    hookResults: [],
                    resourceStates: new Map()
                };
                return;
            }

        } catch (err) {
            log.error('Error during graceful shutdown:', err);
            this.cleanupState.failed = true;
            this.cleanupState.endTime = Date.now();
            this.exitCode = 1;
        } finally {
            this.stopHeartbeat();
            
            // 确保进程退出（非重载模式）
            if (!reloadMode) {
                // 延迟退出，确保日志发送完成
                setTimeout(() => {
                    process.exit(this.exitCode);
                }, 1000);
            }
        }
    }

    /**
     * 记录初始资源状态
     */
    async _recordInitialResourceStates() {
        for (const [resourceId, tracker] of this.cleanupState.resourceStates) {
            try {
                const state = await this.updateResourceState(resourceId);
                log.debug(`Initial state for ${resourceId}:`, state);
            } catch (error) {
                log.warn(`Failed to record initial state for ${resourceId}:`, error.message);
            }
        }
    }

    /**
     * 执行清理钩子（增强版）
     */
    async executeCleanupHooks(reloadMode = false) {
        log.info(`Executing ${this.shutdownHooks.length} cleanup hooks...`);

        for (const hook of this.shutdownHooks) {
            if (this.cleanupState.failed) {
                log.warn('Shutdown already failed, skipping remaining hooks');
                break;
            }

            // 跳过重载模式下不需要清理的钩子
            if (reloadMode && !hook.requiresCleanup) {
                log.info(`Skipping hook ${hook.name} (reload mode, not required)`);
                continue;
            }

            const startTime = Date.now();
            hook.startTime = startTime;
            hook.state = 'running';

            try {
                log.info(`Executing shutdown hook: ${hook.name} (${hook.resourceType})`);

                // 执行单个钩子，带超时保护
                const hookPromise = hook.cleanupFn();
                const timeoutPromise = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`Hook timeout after ${this.hookTimeout}ms`)), this.hookTimeout);
                });

                await Promise.race([hookPromise, timeoutPromise]);

                hook.endTime = Date.now();
                hook.duration = hook.endTime - hook.startTime;
                hook.state = 'completed';

                // 更新资源状态
                if (hook.resourceType !== 'unknown') {
                    await this._updateHookResourceState(hook);
                }

                this.cleanupState.hookResults.push({
                    name: hook.name,
                    state: 'completed',
                    duration: hook.duration,
                    resourceType: hook.resourceType
                });

                log.info(`Shutdown hook ${hook.name} completed in ${hook.duration}ms`);

            } catch (err) {
                hook.endTime = Date.now();
                hook.duration = hook.endTime - hook.startTime;
                hook.state = 'failed';
                hook.error = err.message;

                this.cleanupState.hookResults.push({
                    name: hook.name,
                    state: 'failed',
                    duration: hook.duration,
                    error: err.message,
                    resourceType: hook.resourceType
                });

                log.error(`Shutdown hook ${hook.name} failed after ${hook.duration}ms:`, err.message);
                
                // 继续执行其他钩子，但记录失败
                // 可以根据策略决定是否继续
            }
        }
    }

    /**
     * 更新钩子的资源状态
     */
    async _updateHookResourceState(hook) {
        // 查找相关的资源追踪器
        for (const [resourceId, tracker] of this.cleanupState.resourceStates) {
            if (tracker.type === hook.resourceType || hook.name.includes(resourceId)) {
                const newState = await this.updateResourceState(resourceId);
                tracker.cleanupAttempts++;
                
                // 检查资源是否已正确清理
                if (this._isResourceCleaned(newState)) {
                    log.debug(`Resource ${resourceId} successfully cleaned`);
                } else {
                    log.warn(`Resource ${resourceId} may not be fully cleaned. State:`, newState);
                }
            }
        }
    }

    /**
     * 验证清理结果
     */
    async _validateCleanupResults() {
        const failed = this.cleanupState.hookResults.filter(r => r.state === 'failed');
        const completed = this.cleanupState.hookResults.filter(r => r.state === 'completed');
        
        log.info(`Cleanup validation: ${completed.length} completed, ${failed.length} failed`);

        if (failed.length > 0) {
            log.error('Some cleanup hooks failed:');
            failed.forEach(result => {
                log.error(`  - ${result.name}: ${result.error}`);
            });
            
            // 检查是否有关键资源未清理
            const criticalResources = Array.from(this.cleanupState.resourceStates.entries())
                .filter(([_, tracker]) => tracker.type === 'critical');
            
            for (const [resourceId, tracker] of criticalResources) {
                const state = await this.updateResourceState(resourceId);
                if (!this._isResourceCleaned(state)) {
                    log.error(`Critical resource ${resourceId} not properly cleaned!`);
                }
            }
        }

        // 检查是否有钩子未执行
        const unexecuted = this.shutdownHooks.filter(hook => 
            !this.cleanupState.hookResults.some(r => r.name === hook.name)
        );

        if (unexecuted.length > 0) {
            log.warn(`Some hooks were not executed: ${unexecuted.map(h => h.name).join(', ')}`);
        }
    }

    /**
     * 判断资源是否已清理
     */
    _isResourceCleaned(state) {
        if (!state) return false;
        
        // 根据资源类型判断清理状态
        if (state.status === 'closed' || state.status === 'stopped' || state.status === 'idle') {
            return true;
        }
        
        if (state.connections !== undefined && state.connections === 0) {
            return true;
        }
        
        if (state.activeRequests !== undefined && state.activeRequests === 0) {
            return true;
        }

        return false;
    }

    /**
     * 获取清理状态
     */
    getCleanupState() {
        return {
            started: this.cleanupState.started,
            completed: this.cleanupState.completed,
            failed: this.cleanupState.failed,
            startTime: this.cleanupState.startTime,
            endTime: this.cleanupState.endTime,
            duration: this.cleanupState.endTime - this.cleanupState.startTime,
            hookResults: this.cleanupState.hookResults,
            summary: this._getSummary()
        };
    }

    /**
     * 获取清理摘要
     */
    _getSummary() {
        const results = this.cleanupState.hookResults;
        const total = results.length;
        const completed = results.filter(r => r.state === 'completed').length;
        const failed = results.filter(r => r.state === 'failed').length;
        const totalDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0);

        return {
            totalHooks: total,
            completedHooks: completed,
            failedHooks: failed,
            totalDuration: totalDuration,
            averageDuration: total > 0 ? totalDuration / total : 0,
            successRate: total > 0 ? (completed / total) * 100 : 0
        };
    }

    /**
     * 立即关闭（不执行清理钩子）
     */
    forceExit(code = 1) {
        log.error('Forcing immediate exit...');
        this.stopHeartbeat();
        process.exit(code);
    }

    /**
     * 获取资源状态报告
     */
    async getResourceReport() {
        const report = {};
        
        for (const [resourceId, tracker] of this.cleanupState.resourceStates) {
            const state = await this.updateResourceState(resourceId);
            report[resourceId] = {
                type: tracker.type,
                state: state,
                cleanupAttempts: tracker.cleanupAttempts,
                isCleaned: this._isResourceCleaned(state)
            };
        }
        
        return report;
    }
}

// 导出单例
export const enhancedGracefulShutdown = new EnhancedGracefulShutdown();

// 便捷函数
export const registerEnhancedHook = (cleanupFn, options) => {
    return enhancedGracefulShutdown.register(cleanupFn, options);
};

export const registerResource = (resourceId, resourceType, getStateFn) => {
    enhancedGracefulShutdown.registerResource(resourceId, resourceType, getStateFn);
};

export const triggerEnhancedShutdown = (source, error, reloadMode = false) => {
    enhancedGracefulShutdown.shutdown(source, error, reloadMode);
};

export default enhancedGracefulShutdown;