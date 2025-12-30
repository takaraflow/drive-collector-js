/**
 * 通用缓存服务
 * 支持 TTL 和基础并发控制
 */
class LocalCache {
    constructor() {
        this.cache = new Map();
        this.ttls = new Map();
    }

    /**
     * 设置缓存
     * @param {string} key 
     * @param {any} value 
     * @param {number} ttlMs - 过期时间（毫秒），默认 10 分钟
     */
    set(key, value, ttlMs = 10 * 60 * 1000) {
        this.cache.set(key, value);
        this.ttls.set(key, Date.now() + ttlMs);
    }

    /**
     * 检查值是否未变且未过期
     * @param {string} key 
     * @param {any} newValue 
     * @returns {boolean}
     */
    isUnchanged(key, newValue) {
        const cached = this.get(key);
        if (cached === null) return false;
        
        try {
            return JSON.stringify(cached) === JSON.stringify(newValue);
        } catch (e) {
            return cached === newValue;
        }
    }

    /**
     * 获取缓存
     * @param {string} key 
     * @returns {any|null}
     */
    get(key) {
        if (!this.cache.has(key)) return null;

        const expiry = this.ttls.get(key);
        if (Date.now() > expiry) {
            this.del(key);
            return null;
        }

        return this.cache.get(key);
    }

    /**
     * 删除缓存
     * @param {string} key 
     */
    del(key) {
        this.cache.delete(key);
        this.ttls.delete(key);
    }

    /**
     * 清除所有缓存
     */
    clear() {
        this.cache.clear();
        this.ttls.clear();
    }

    /**
     * 获取或设置（自动加载模式）
     * @param {string} key 
     * @param {Function} loader - 返回 Promise 的异步函数
     * @param {number} ttlMs 
     */
    async getOrSet(key, loader, ttlMs) {
        const cached = this.get(key);
        if (cached !== null) return cached;

        const data = await loader();
        if (data !== null && data !== undefined) {
            this.set(key, data, ttlMs);
        }
        return data;
    }
}

export const localCache = new LocalCache();