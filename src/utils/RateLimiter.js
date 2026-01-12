/**
 * 高级令牌桶速率限制器，支持动态配置和自适应调整
 */
class RateLimiter {
    constructor(maxRequests, windowMs, options = {}) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.tokens = maxRequests;
        this.lastRefill = Date.now();
        this.queue = [];
        
        // 动态配置
        this.minRequests = options.minRequests || Math.floor(maxRequests * 0.5);
        this.maxRequestsLimit = options.maxRequests || maxRequests * 2;
        this.adaptive = options.adaptive || false;
        
        // 统计
        this.stats = {
            totalRequests: 0,
            throttledRequests: 0,
            averageLatency: 0,
            lastAdjustment: Date.now()
        };
        
        // 自适应调整参数
        this.successCount = 0;
        this.failureCount = 0;
        this.adjustmentInterval = options.adjustmentInterval || 60000; // 1分钟
    }

    async acquire() {
        const now = Date.now();
        const timePassed = now - this.lastRefill;
        
        // 补充令牌
        if (timePassed >= this.windowMs) {
            this.tokens = this.maxRequests;
            this.lastRefill = now;
        }

        if (this.tokens > 0) {
            this.tokens--;
            this.stats.totalRequests++;
            this.successCount++;
            return true;
        }

        // 记录节流
        this.stats.throttledRequests++;
        this.failureCount++;

        // 等待直到有令牌可用
        const waitTime = this.windowMs - timePassed;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        this.tokens = this.maxRequests - 1;
        this.lastRefill = Date.now();
        
        this.stats.totalRequests++;
        return true;
    }

    async execute(fn) {
        const start = Date.now();
        await this.acquire();
        
        try {
            const result = await fn();
            const latency = Date.now() - start;
            
            // 更新平均延迟
            this.stats.averageLatency =
                (this.stats.averageLatency * 0.9) + (latency * 0.1);
            
            // 自适应调整
            if (this.adaptive) {
                this._adjustIfNeeded();
            }
            
            return result;
        } catch (error) {
            this.failureCount++;
            throw error;
        }
    }

    /**
     * 自适应调整速率限制
     */
    _adjustIfNeeded() {
        const now = Date.now();
        if (now - this.stats.lastAdjustment < this.adjustmentInterval) {
            return;
        }

        // 基于成功率调整
        const total = this.successCount + this.failureCount;
        if (total === 0) return;

        const successRate = this.successCount / total;
        
        if (successRate > 0.9 && this.stats.averageLatency < 100) {
            // 高成功率且低延迟，增加限制
            this.maxRequests = Math.min(
                this.maxRequests + 1,
                this.maxRequestsLimit
            );
            log.info(`Rate limit increased to ${this.maxRequests}`);
        } else if (successRate < 0.7 || this.stats.averageLatency > 500) {
            // 低成功率或高延迟，减少限制
            this.maxRequests = Math.max(
                this.maxRequests - 1,
                this.minRequests
            );
            log.info(`Rate limit decreased to ${this.maxRequests}`);
        }

        // 重置计数器
        this.successCount = 0;
        this.failureCount = 0;
        this.stats.lastAdjustment = now;
    }

    /**
     * 动态更新配置
     */
    updateConfig(maxRequests, windowMs) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.tokens = maxRequests;
        this.lastRefill = Date.now();
    }

    /**
     * 获取当前状态
     */
    getStatus() {
        return {
            maxRequests: this.maxRequests,
            currentTokens: this.tokens,
            windowMs: this.windowMs,
            stats: this.stats,
            isAdaptive: this.adaptive
        };
    }

    /**
     * 重置统计
     */
    resetStats() {
        this.stats = {
            totalRequests: 0,
            throttledRequests: 0,
            averageLatency: 0,
            lastAdjustment: Date.now()
        };
        this.successCount = 0;
        this.failureCount = 0;
    }
}

// Upstash 专用限制器 (Free Tier: 10,000 请求/天 ≈ 7 请求/分钟)
// 支持动态配置
export const upstashRateLimiter = new RateLimiter(
    parseInt(process.env.QSTASH_RATE_LIMIT) || 5,
    parseInt(process.env.QSTASH_RATE_WINDOW) || 60 * 1000,
    {
        adaptive: process.env.QSTASH_ADAPTIVE_RATE === 'true',
        minRequests: parseInt(process.env.QSTASH_MIN_RATE) || 3,
        maxRequests: parseInt(process.env.QSTASH_MAX_RATE) || 10
    }
);

// 通用速率限制器工厂
export function createRateLimiter(config) {
    const maxRequests = config.maxRequests || 10;
    const windowMs = config.windowMs || 60000;
    const options = {
        adaptive: config.adaptive || false,
        minRequests: config.minRequests,
        maxRequests: config.maxRequests,
        adjustmentInterval: config.adjustmentInterval
    };
    
    return new RateLimiter(maxRequests, windowMs, options);
}

export default RateLimiter;