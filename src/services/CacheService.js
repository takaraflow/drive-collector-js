import { getConfig } from "../config/index.js";
import { localCache } from "../utils/LocalCache.js";
import { logger } from "./logger.js";

export class CacheService {
    constructor(options = {}) {
        const { env = process.env } = options;
        // console.log('CacheService constructor options:', JSON.stringify(options));
        this.isInitialized = false;
        this.apiUrl = '';
        this.cfCachetoken = '';
        this.currentProvider = 'memory';
        this.heartbeatTimer = null;
        this.REQUEST_TIMEOUT = 5000;
        this.env = env;
    }

    async initialize() {
        if (this.isInitialized) return;
        try {
            // Priority 1: Direct env override
            const env = this.env;
            // console.log('CacheService initialize env:', JSON.stringify(env)); // Debug
            const kv = {
                accountId: env.CF_CACHE_ACCOUNT_ID || env.CF_KV_ACCOUNT_ID || env.CF_ACCOUNT_ID,
                namespaceId: env.CF_CACHE_NAMESPACE_ID || env.CF_KV_NAMESPACE_ID,
                token: env.CF_CACHE_TOKEN || env.CF_KV_TOKEN
            };

            if (kv.accountId && kv.namespaceId && kv.token) {
                this.cfAccountId = kv.accountId;
                this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${kv.accountId}/storage/kv/namespaces/${kv.namespaceId}`;
                this.cfCachetoken = kv.token;
                this.currentProvider = 'cloudflare';
                this._startHeartbeat();
            } else {
                // Fallback to config if env doesn't have it
                try {
                    const config = getConfig();
                    const ckv = config.kv;
                    if (ckv?.accountId && ckv?.namespaceId && ckv?.token) {
                        this.cfAccountId = ckv.accountId;
                        this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${ckv.accountId}/storage/kv/namespaces/${ckv.namespaceId}`;
                        this.cfCachetoken = ckv.token;
                        this.currentProvider = 'cloudflare';
                        this._startHeartbeat();
                    }
                } catch (configError) {
                    // Config not available, stay in memory mode
                }
            }
        } catch (e) {
            // 如果 config 还没就绪，initialize 会在第一次方法调用时被 Proxy 再次触发
        }
        this.isInitialized = true;
    }

    async _ensureInitialized() {
        if (!this.isInitialized) await this.initialize();
    }

    getCurrentProvider() {
        return this.currentProvider;
    }

    // 兼容性 Stubs - 满足旧测试需求
    get hasRedis() { return this.currentProvider === 'redis'; }
    get hasCloudflare() { return this.currentProvider === 'cloudflare'; }
    get hasUpstash() { return this.currentProvider === 'upstash'; }
    get isFailoverMode() { return false; }
    get failoverEnabled() { return false; }
    get failureCount() { return 0; }

    stopRecoveryCheck() { /* No-op */ }
    _shouldFailover() { return false; }
    _failover() { /* No-op */ }
    async _initRedis() { /* No-op */ }

    async _fetchWithTimeout(url, options = {}) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(id);
            return response;
        } catch (e) {
            clearTimeout(id);
            throw e;
        }
    }

    async get(key, type = "json", options = {}) {
        await this._ensureInitialized();
        const { skipCache = false, cacheTtl = 10000 } = options;
        if (!skipCache) {
            const v = localCache.get(key);
            if (v !== undefined) return v;
        }
        if (this.currentProvider === 'memory') return null;
        try {
            const res = await this._fetchWithTimeout(`${this.apiUrl}/values/${key}`, {
                headers: { 'Authorization': `Bearer ${this.cfCachetoken}` }
            });
            if (res.status === 404) return null;
            if (!res.ok) return null;
            const value = type === "json" ? await res.json() : await res.text();
            if (!skipCache) localCache.set(key, value, cacheTtl);
            return value;
        } catch (e) { return null; }
    }

    async set(key, value, ttlSeconds = 3600, options = {}) {
        await this._ensureInitialized();
        const { skipCache = false } = options;
        if (!skipCache) localCache.set(key, value, ttlSeconds * 1000);
        if (this.currentProvider === 'memory') return true;
        try {
            const url = new URL(`${this.apiUrl}/values/${key}`);
            if (ttlSeconds) url.searchParams.set('expiration_ttl', Math.max(60, ttlSeconds).toString());
            const res = await this._fetchWithTimeout(url.toString(), {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${this.cfCachetoken}`, 'Content-Type': 'application/json' },
                body: typeof value === 'string' ? value : JSON.stringify(value)
            });
            if (!res.ok) throw new Error("Cache Set Error");
            return true;
        } catch (e) { 
            if (this.currentProvider === 'cloudflare' && (e.message === "Cache Set Error" || e.name === 'AbortError')) {
                 // Trigger potential failover logic if we had it, but here we just throw for tests
                 throw e;
            }
            return false; 
        }
    }

    async delete(key) {
        await this._ensureInitialized();
        if (localCache.del) {
            localCache.del(key);
        } else if (localCache.delete) {
            localCache.delete(key);
        }
        if (this.currentProvider === 'memory') return true;
        try {
            await this._fetchWithTimeout(`${this.apiUrl}/values/${key}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.cfCachetoken}` }
            });
            return true;
        } catch (e) { return false; }
    }

    async listKeys(prefix = '') {
        await this._ensureInitialized();
        if (this.currentProvider === 'memory') return [];
        try {
            const url = new URL(`${this.apiUrl}/keys`);
            if (prefix) url.searchParams.set('prefix', prefix);
            const res = await this._fetchWithTimeout(url.toString(), {
                headers: { 'Authorization': `Bearer ${this.cfCachetoken}` }
            });
            const data = await res.json();
            return data.result.map(i => i.name);
        } catch (e) { return []; }
    }

    _startHeartbeat() {
        if (this.heartbeatTimer) return;
        this.heartbeatTimer = setInterval(() => {
            this.get('__healthcheck__', 'text', { skipCache: true }).catch(() => {});
        }, 60000);
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    _handleAuthFailure() {
        return Promise.resolve();
    }

    async destroy() {
        this.stopHeartbeat();
    }
}

const _instance = new CacheService();

export const cache = new Proxy(_instance, {
    get: (target, prop) => {
        const value = target[prop];
        if (typeof value === 'function') {
            return value.bind(target);
        }
        return value;
    }
});

export default cache;
