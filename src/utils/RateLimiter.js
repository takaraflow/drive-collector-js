/**
 * 简单的令牌桶速率限制器
 */
class RateLimiter {
    constructor(maxRequests, windowMs) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.tokens = maxRequests;
        this.lastRefill = Date.now();
        this.queue = [];
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
            return true;
        }

        // 等待直到有令牌可用
        const waitTime = this.windowMs - timePassed;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        this.tokens = this.maxRequests - 1;
        this.lastRefill = Date.now();
        return true;
    }

    async execute(fn) {
        await this.acquire();
        return fn();
    }
}

// Upstash 专用限制器 (Free Tier: 10,000 请求/天 ≈ 7 请求/分钟)
// 设置为 5 请求/分钟以提供安全缓冲
export const upstashRateLimiter = new RateLimiter(5, 60 * 1000);

export default RateLimiter;