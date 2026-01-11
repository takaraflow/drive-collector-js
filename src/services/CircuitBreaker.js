import logger from "./logger.js";

const log = logger.withModule('CircuitBreaker');

// 创建带 name 上下文的 logger 用于动态 name 信息
const logWithName = (name) => log.withContext({ breaker: name });

/**
 * --- 熔断器 ---
 * 保护外部服务调用，防止级联故障
 */
export class CircuitBreaker {
    /**
     * @param {Object} options - 配置选项
     * @param {number} options.failureThreshold - 失败次数阈值（默认5次）
     * @param {number} options.successThreshold - 恢复成功次数（默认2次）
     * @param {number} options.timeout - 半开窗口超时时间（默认30秒）
     * @param {string} options.name - 熔断器名称（用于日志）
     */
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold || 5;
        this.successThreshold = options.successThreshold || 2;
        this.timeout = options.timeout || 30000;
        this.name = options.name || 'default';
        
        this.state = 'CLOSED';  // CLOSED | OPEN | HALF_OPEN
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
    }
    
    /**
     * 执行受保护的函数
     * @param {Function} command - 要执行的函数
     * @param {Function} [fallback=null] - 降级处理函数
     * @returns {Promise<any>} 命令执行结果
     */
    async execute(command, fallback = null) {
        // 检查熔断器状态
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime > this.timeout) {
                logWithName(this.name).info(`Circuit breaker half-open, attempting recovery`);
                this.state = 'HALF_OPEN';
            } else {
                // 熔断中，执行 fallback 或直接失败
                if (fallback) {
                    return fallback();
                }
                throw new Error(`Circuit breaker is OPEN for ${this.name}`);
            }
        }
        
        try {
            const result = await command();
            this._onSuccess();
            return result;
        } catch (error) {
            this._onFailure(error);
            if (fallback) {
                return fallback();
            }
            throw error;
        }
    }
    
    /**
     * 获取熔断器当前状态（用于监控）
     */
    getStatus() {
        return {
            name: this.name,
            state: this.state,
            failureCount: this.failureCount,
            successCount: this.successCount,
            lastFailureTime: this.lastFailureTime,
            threshold: this.failureThreshold
        };
    }
    
    /**
     * 手动重置熔断器
     */
    reset() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
        logWithName(this.name).info(`Circuit breaker manually reset`);
    }
    
    /**
     * 强制打开熔断器（用于紧急情况）
     */
    forceOpen() {
        this.state = 'OPEN';
        this.lastFailureTime = Date.now();
        logWithName(this.name).warn(`Circuit breaker force opened`);
    }
    
    _onSuccess() {
        if (this.state === 'HALF_OPEN') {
            this.successCount++;
            if (this.successCount >= this.successThreshold) {
                logWithName(this.name).info(`Circuit breaker recovered, closing`);
                this._reset();
            }
        } else {
            this.failureCount = 0;
        }
    }
    
    _onFailure(error) {
        this.failureCount++;
        this.lastFailureTime = Date.now();
        
        if (this.state === 'HALF_OPEN') {
            // 半开状态下的失败直接重新打开
            logWithName(this.name).warn(`Circuit breaker half-open failed, reopening`, { error: error.message });
            this.state = 'OPEN';
        } else if (this.failureCount >= this.failureThreshold) {
            // 达到阈值，打开熔断器
            logWithName(this.name).warn(`Circuit breaker opened after ${this.failureCount} failures`, { error: error.message });
            this.state = 'OPEN';
        }
    }
    
    _reset() {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        this.lastFailureTime = null;
    }
}

/**
 * 熔断器管理器 - 管理多个熔断器实例
 */
export class CircuitBreakerManager {
    static breakers = new Map();
    
    /**
     * 获取或创建熔断器
     * @param {string} name - 熔断器名称
     * @param {Object} options - 配置选项
     */
    static get(name, options = {}) {
        if (!this.breakers.has(name)) {
            this.breakers.set(name, new CircuitBreaker({ name, ...options }));
        }
        return this.breakers.get(name);
    }
    
    /**
     * 获取所有熔断器状态
     */
    static getAllStatus() {
        const statuses = [];
        for (const [name, breaker] of this.breakers) {
            statuses.push(breaker.getStatus());
        }
        return statuses;
    }
    
    /**
     * 重置所有熔断器
     */
    static resetAll() {
        for (const breaker of this.breakers.values()) {
            breaker.reset();
        }
        log.info('All circuit breakers reset');
    }
}
