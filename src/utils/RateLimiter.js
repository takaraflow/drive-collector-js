import { logger } from '../services/logger/index.js';

const log = logger.withModule ? logger.withModule('RateLimiter') : logger;

/**
 * Advanced token bucket rate limiter with dynamic configuration and adaptive adjustment support.
 */
class RateLimiter {
    constructor(maxRequests, windowMs, options = {}) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.tokens = maxRequests;
        this.lastRefill = Date.now();
        this.queue = [];
        this._drainTimer = null;
        
        // Dynamic configuration
        this.minRequests = options.minRequests || Math.floor(maxRequests * 0.5);
        this.maxRequestsLimit = options.maxRequests || maxRequests * 2;
        this.adaptive = options.adaptive || false;
        
        // Statistics
        this.stats = {
            totalRequests: 0,
            throttledRequests: 0,
            averageLatency: 0,
            lastAdjustment: Date.now()
        };
        
        // Adaptive adjustment parameters
        this.successCount = 0;
        this.failureCount = 0;
        this.adjustmentInterval = options.adjustmentInterval || 60000; // 1 minute
    }

    async acquire() {
        this._refillTokens();

        if (this.tokens > 0 && this.queue.length === 0) {
            this.tokens--;
            this.stats.totalRequests++;
            this.successCount++;
            return true;
        }

        this.stats.throttledRequests++;

        return await new Promise((resolve) => {
            this.queue.push(resolve);
            this._scheduleDrain();
        });
    }

    async execute(fn) {
        const start = Date.now();
        await this.acquire();
        
        try {
            const result = await fn();
            const latency = Date.now() - start;
            
            // Update average latency
            this.stats.averageLatency =
                (this.stats.averageLatency * 0.9) + (latency * 0.1);
            
            // Adaptive adjustment
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
     * Adaptive rate limit adjustment
     */
    _adjustIfNeeded() {
        const now = Date.now();
        if (now - this.stats.lastAdjustment < this.adjustmentInterval) {
            return;
        }

        // Adjust based on success rate
        const total = this.successCount + this.failureCount;
        if (total === 0) return;

        const successRate = this.successCount / total;
        
        if (successRate > 0.9 && this.stats.averageLatency < 100) {
            // High success rate and low latency, increase limit
            this.maxRequests = Math.min(
                this.maxRequests + 1,
                this.maxRequestsLimit
            );
            log.info(`Rate limit increased to ${this.maxRequests}`);
        } else if (successRate < 0.7 || this.stats.averageLatency > 500) {
            // Low success rate or high latency, decrease limit
            this.maxRequests = Math.max(
                this.maxRequests - 1,
                this.minRequests
            );
            log.info(`Rate limit decreased to ${this.maxRequests}`);
        }

        // Reset counters
        this.successCount = 0;
        this.failureCount = 0;
        this.stats.lastAdjustment = now;
    }

    /**
     * Dynamically update configuration
     */
    updateConfig(maxRequests, windowMs) {
        this.maxRequests = maxRequests;
        this.windowMs = windowMs;
        this.tokens = maxRequests;
        this.lastRefill = Date.now();
        this._scheduleDrain();
    }

    /**
     * Get current status
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
     * Reset statistics
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

    _refillTokens() {
        const now = Date.now();
        const timePassed = now - this.lastRefill;

        if (timePassed < this.windowMs) {
            return;
        }

        const windowsPassed = Math.max(1, Math.floor(timePassed / this.windowMs));
        this.tokens = this.maxRequests;
        this.lastRefill += windowsPassed * this.windowMs;
    }

    _scheduleDrain() {
        if (this._drainTimer || this.queue.length === 0) {
            return;
        }

        this._refillTokens();
        if (this.tokens > 0) {
            queueMicrotask(() => this._drainQueue());
            return;
        }

        const waitTime = Math.max(0, this.windowMs - (Date.now() - this.lastRefill));
        this._drainTimer = setTimeout(() => {
            this._drainTimer = null;
            this._drainQueue();
        }, waitTime);
    }

    _drainQueue() {
        this._refillTokens();

        while (this.tokens > 0 && this.queue.length > 0) {
            this.tokens--;
            this.stats.totalRequests++;
            this.successCount++;
            const resolve = this.queue.shift();
            resolve(true);
        }

        if (this.queue.length > 0) {
            this._scheduleDrain();
        }
    }
}

// Upstash dedicated limiter (Free Tier: 10,000 requests/day ≈ 7 requests/minute)
// Supports dynamic configuration
export const upstashRateLimiter = new RateLimiter(
    parseInt(process.env.QSTASH_RATE_LIMIT) || 5,
    parseInt(process.env.QSTASH_RATE_WINDOW) || 60 * 1000,
    {
        adaptive: process.env.QSTASH_ADAPTIVE_RATE === 'true',
        minRequests: parseInt(process.env.QSTASH_MIN_RATE) || 3,
        maxRequests: parseInt(process.env.QSTASH_MAX_RATE) || 10
    }
);

// Generic rate limiter factory
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
