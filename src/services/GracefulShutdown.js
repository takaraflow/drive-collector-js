/**
 * GracefulShutdown.js
 * 
 * 负责管理应用的优雅关闭流程
 * 1. 注册清理函数
 * 2. 捕获退出信号
 * 3. 按顺序清理资源
 * 4. 在清理完成后退出进程
 */

import { logger } from "./logger/index.js";

const log = logger.withModule ? logger.withModule('GracefulShutdown') : logger;

class GracefulShutdown {
    constructor() {
        this.shutdownHooks = [];
        this.isShuttingDown = false;
        this.shutdownTimeout = 30000; // 30秒超时
        this.exitCode = 0;
        this.setupSignalHandlers();
        this.setupErrorHandlers();
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
     * 设置信号处理器
     */
    setupSignalHandlers() {
        const handleSignal = async (signal) => {
            log.info(`Received ${signal} signal, initiating graceful shutdown...`);
            await this.shutdown(signal);
        };

        process.on('SIGTERM', () => handleSignal('SIGTERM'));
        process.on('SIGINT', () => handleSignal('SIGINT'));
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
     * 执行优雅关闭
     */
    async shutdown(source = 'unknown', error = null) {
        if (this.isShuttingDown) {
            log.warn('Shutdown already in progress, ignoring duplicate request');
            return;
        }

        this.isShuttingDown = true;

        try {
            log.info(`Starting graceful shutdown (source: ${source})...`);
            
            if (error) {
                log.error('Shutdown reason:', error.message || error);
            }

            // 创建超时保护
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Graceful shutdown timeout')), this.shutdownTimeout);
            });

            // 执行所有清理钩子
            const cleanupPromise = this.executeCleanupHooks();

            await Promise.race([cleanupPromise, timeoutPromise]);

            log.info('Graceful shutdown completed successfully');
        } catch (err) {
            log.error('Error during graceful shutdown:', err);
            this.exitCode = 1;
        } finally {
            // 确保进程退出
            process.exit(this.exitCode);
        }
    }

    /**
     * 按优先级执行清理钩子
     */
    async executeCleanupHooks() {
        for (const hook of this.shutdownHooks) {
            const startTime = Date.now();
            try {
                log.info(`Executing shutdown hook: ${hook.name}`);
                
                await hook.cleanupFn();
                
                const duration = Date.now() - startTime;
                log.info(`Shutdown hook ${hook.name} completed in ${duration}ms`);
            } catch (err) {
                const duration = Date.now() - startTime;
                log.error(`Shutdown hook ${hook.name} failed after ${duration}ms:`, err);
                // 继续执行其他清理钩子，不要因为一个失败而中断整个流程
            }
        }
    }

    /**
     * 立即关闭（不执行清理钩子）
     * 仅在严重错误时使用
     */
    forceExit(code = 1) {
        log.error('Forcing immediate exit...');
        process.exit(code);
    }
}

// 导出单例
export const gracefulShutdown = new GracefulShutdown();

// 便捷函数
export const registerShutdownHook = (cleanupFn, priority, name) => {
    gracefulShutdown.register(cleanupFn, priority, name);
};

export const triggerShutdown = (source, error) => {
    gracefulShutdown.shutdown(source, error);
};

export default gracefulShutdown;
