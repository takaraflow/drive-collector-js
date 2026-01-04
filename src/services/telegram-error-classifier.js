/**
 * Telegram 错误分类器
 * 精确识别错误类型，制定针对性处理策略
 */

export class TelegramErrorClassifier {
    static ERROR_TYPES = {
        TIMEOUT: 'TIMEOUT',                    // 超时类错误
        NOT_CONNECTED: 'NOT_CONNECTED',        // 未连接错误
        CONNECTION_LOST: 'CONNECTION_LOST',    // 连接丢失
        AUTH_KEY_DUPLICATED: 'AUTH_KEY_DUPLICATED', // 会话冲突
        BINARY_READER: 'BINARY_READER',        // 二进制解析错误
        NETWORK: 'NETWORK',                    // 网络层错误
        RPC_ERROR: 'RPC_ERROR',                // Telegram RPC 错误
        FLOOD: 'FLOOD',                        // Flood 限制错误
        UNKNOWN: 'UNKNOWN'                     // 未知错误
    };

    static classify(error) {
        if (!error) return this.ERROR_TYPES.UNKNOWN;

        const msg = error.message || '';
        const msgLower = msg.toLowerCase();
        const code = error.code;
        const seconds = error.seconds;

        // 0. Flood 限制 (最高优先级)
        if (code === 420 || msg.includes('FLOOD') || seconds > 0) {
            return this.ERROR_TYPES.FLOOD;
        }

        // 1. 认证和会话冲突 (高优先级)
        if (code === 406 || msg.includes('AUTH_KEY_DUPLICATED')) {
            return this.ERROR_TYPES.AUTH_KEY_DUPLICATED;
        }

        // 2. 超时类错误
        if (
            msgLower.includes('timeout') ||
            msg.includes('ETIMEDOUT') ||
            msg.includes('ECONNRESET') ||
            msg.includes('timed out') ||
            code === 'ETIMEDOUT' ||
            code === 'ECONNRESET'
        ) {
            return this.ERROR_TYPES.TIMEOUT;
        }

        // 3. 未连接错误
        if (
            msg.includes('Not connected') ||
            msg.includes('Connection closed') ||
            msg.includes('Client not initialized')
        ) {
            return this.ERROR_TYPES.NOT_CONNECTED;
        }

        // 4. 二进制解析错误
        if (
            msg.includes('readUInt32LE') ||
            msg.includes('readInt32LE') ||
            (error instanceof TypeError && msg.includes('undefined'))
        ) {
            return this.ERROR_TYPES.BINARY_READER;
        }

        // 5. RPC 错误
        if (msg.includes('RPCError') || msg.includes('rpc_error')) {
            return this.ERROR_TYPES.RPC_ERROR;
        }

        // 6. 网络层错误
        if (
            msg.includes('ECONNREFUSED') ||
            msg.includes('ENOTFOUND') ||
            msg.includes('EAI_AGAIN') ||
            msg.includes('network') ||
            msg.includes('socket')
        ) {
            return this.ERROR_TYPES.NETWORK;
        }

        // 7. 连接丢失 (需要与 NOT_CONNECTED 区分)
        if (msg.includes('Connection lost') || msg.includes('Peer closed')) {
            return this.ERROR_TYPES.CONNECTION_LOST;
        }

        return this.ERROR_TYPES.UNKNOWN;
    }

    /**
     * 判断错误是否可恢复
     */
    static isRecoverable(errorType) {
        const unrecoverable = [
            this.ERROR_TYPES.AUTH_KEY_DUPLICATED
        ];
        return !unrecoverable.includes(errorType);
    }

    /**
     * 获取推荐的重连策略
     */
    static getReconnectStrategy(errorType, failureCount, error = null) {
        // 特殊处理 Flood Wait
        if (errorType === this.ERROR_TYPES.FLOOD && error?.seconds) {
            return {
                type: 'wait',
                delay: (error.seconds + 5) * 1000, // 多等5秒缓冲
                shouldRetry: true
            };
        }

        const strategies = {
            [this.ERROR_TYPES.TIMEOUT]: {
                type: 'lightweight',
                baseDelay: 10000,      // 10秒基础延迟
                maxDelay: 120000,      // 2分钟最大延迟
                maxRetries: 5,
                backoffMultiplier: 2.5  // 更激进的退避
            },
            [this.ERROR_TYPES.NOT_CONNECTED]: {
                type: 'lightweight',
                baseDelay: 5000,       // 5秒基础延迟
                maxDelay: 60000,       // 1分钟最大延迟
                maxRetries: 8,
                backoffMultiplier: 1.8
            },
            [this.ERROR_TYPES.CONNECTION_LOST]: {
                type: 'full',
                baseDelay: 8000,
                maxDelay: 90000,
                maxRetries: 6,
                backoffMultiplier: 2.0
            },
            [this.ERROR_TYPES.BINARY_READER]: {
                type: 'full',
                baseDelay: 3000,
                maxDelay: 30000,
                maxRetries: 3,
                backoffMultiplier: 1.5
            },
            [this.ERROR_TYPES.NETWORK]: {
                type: 'lightweight',
                baseDelay: 15000,
                maxDelay: 180000,      // 3分钟最大延迟
                maxRetries: 10,
                backoffMultiplier: 2.2
            },
            [this.ERROR_TYPES.RPC_ERROR]: {
                type: 'lightweight',
                baseDelay: 5000,
                maxDelay: 45000,
                maxRetries: 4,
                backoffMultiplier: 1.5
            },
            [this.ERROR_TYPES.FLOOD]: {
                type: 'wait',
                baseDelay: 60000,
                maxDelay: 86400000, // 1天
                maxRetries: 3,
                backoffMultiplier: 1.0 // 由 error.seconds 决定，这里仅作默认值
            },
            [this.ERROR_TYPES.UNKNOWN]: {
                type: 'full',
                baseDelay: 10000,
                maxDelay: 60000,
                maxRetries: 5,
                backoffMultiplier: 2.0
            }
        };

        const strategy = strategies[errorType] || strategies[this.ERROR_TYPES.UNKNOWN];
        
        // 根据失败次数调整延迟
        const calculatedDelay = Math.min(
            strategy.baseDelay * Math.pow(strategy.backoffMultiplier, failureCount),
            strategy.maxDelay
        );

        return {
            ...strategy,
            delay: calculatedDelay,
            shouldRetry: failureCount < strategy.maxRetries
        };
    }

    /**
     * 判断是否需要触发电路断路器
     */
    static shouldTripCircuitBreaker(errorType, failureCount) {
        // 认证错误立即触发
        if (errorType === this.ERROR_TYPES.AUTH_KEY_DUPLICATED) {
            return true;
        }

        // Flood 错误：1次即触发，避免继续请求
        if (errorType === this.ERROR_TYPES.FLOOD) {
            return true;
        }

        // 超时错误：5次失败触发
        if (errorType === this.ERROR_TYPES.TIMEOUT) {
            return failureCount >= 5;
        }

        // 网络错误：8次失败触发
        if (errorType === this.ERROR_TYPES.NETWORK) {
            return failureCount >= 8;
        }

        // 其他错误：6次失败触发
        return failureCount >= 6;
    }

    /**
     * 判断是否需要完全重置 Session
     */
    static shouldResetSession(errorType, failureCount) {
        return (
            errorType === this.ERROR_TYPES.BINARY_READER ||
            errorType === this.ERROR_TYPES.AUTH_KEY_DUPLICATED ||
            (errorType === this.ERROR_TYPES.TIMEOUT && failureCount >= 3)
        );
    }

    /**
     * 判断是否应该跳过重连（某些错误需要特殊处理）
     */
    static shouldSkipReconnect(errorType) {
        return errorType === this.ERROR_TYPES.AUTH_KEY_DUPLICATED;
    }
}