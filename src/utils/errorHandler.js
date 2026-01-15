import { logger } from "../services/logger/index.js";

const log = logger.withModule('ErrorHandler');

/**
 * 安全记录错误，即使日志服务失败也不会崩溃
 * @param {string} context - 错误上下文
 * @param {Error} error - 错误对象
 * @param {Object} metadata - 额外元数据
 */
export function safeLogError(context, error, metadata = {}) {
    try {
        log.error(context, {
            error: error?.message || error?.toString() || 'Unknown error',
            stack: error?.stack,
            ...metadata
        });
    } catch (logError) {
        // 如果连日志都失败了，输出到stderr
        console.error(`[${context}]`, {
            error: error?.message || error,
            logError: logError?.message,
            ...metadata
        });
    }
}

/**
 * 包装异步函数，提供默认错误处理
 * @param {Function} fn - 异步函数
 * @param {Object} options - 选项
 * @returns {Function} 包装后的函数
 */
export function withErrorHandling(fn, options = {}) {
    const {
        context = 'Operation',
        defaultValue = null,
        rethrow = false
    } = options;

    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            safeLogError(`${context} failed`, error, { args });
            if (rethrow) {
                throw error;
            }
            return defaultValue;
        }
    };
}