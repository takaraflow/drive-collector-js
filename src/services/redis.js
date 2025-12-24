import { config } from "../config/index.js";

/**
 * --- Redis 服务层 ---
 * 用于分布式限流和其他跨节点共享状态
 */
class RedisService {
    constructor() {
        this.enabled = !!process.env.REDIS_URL;
        this.url = process.env.REDIS_URL;
        this.client = null;
    }

    async connect() {
        if (!this.enabled || this.client) return;
        
        try {
            // 动态导入 ioredis 以避免在不需要时引入依赖
            const { default: Redis } = await import("ioredis");
            this.client = new Redis(this.url, {
                maxRetriesPerRequest: 3,
                retryStrategy(times) {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            });

            this.client.on("error", (err) => {
                console.error("Redis Error:", err);
            });
        } catch (e) {
            console.error("Failed to connect to Redis:", e.message);
            this.enabled = false;
        }
    }

    /**
     * 执行 Lua 脚本实现滑动窗口限流
     * @param {string} key 
     * @param {number} limit 
     * @param {number} windowMs 
     * @returns {Promise<{allowed: boolean, remaining: number}>}
     */
    async slidingWindowLimit(key, limit, windowMs) {
        if (!this.enabled || !this.client) {
            return { allowed: true, remaining: limit };
        }

        const now = Date.now();
        const windowStart = now - windowMs;

        const script = `
            local key = KEYS[1]
            local now = tonumber(ARGV[1])
            local window_start = tonumber(ARGV[2])
            local limit = tonumber(ARGV[3])

            -- 移除窗口外的旧记录
            redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
            
            -- 获取当前窗口内的请求数
            local current_count = redis.call('ZCARD', key)
            
            if current_count < limit then
                -- 允许请求，添加当前时间戳
                redis.call('ZADD', key, now, now)
                -- 设置过期时间以自动清理
                redis.call('PEXPIRE', key, ARGV[4])
                return {1, limit - current_count - 1}
            else
                -- 拒绝请求
                return {0, 0}
            end
        `;

        try {
            const result = await this.client.eval(script, 1, key, now, windowStart, limit, windowMs);
            return {
                allowed: result[0] === 1,
                remaining: result[1]
            };
        } catch (e) {
            console.error("Redis Limit Error:", e);
            return { allowed: true, remaining: limit }; // 出错时放行
        }
    }
}

export const redis = new RedisService();