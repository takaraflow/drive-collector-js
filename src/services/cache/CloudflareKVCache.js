import { BaseCache } from './BaseCache.js';

/**
 * CloudflareKVCache - Cloudflare KV storage provider
 * Implements cache operations using Cloudflare Workers KV API
 */
class CloudflareKVCache extends BaseCache {
    constructor(config = {}) {
        super();
        
        this.accountId = config.accountId;
        this.namespaceId = config.namespaceId;
        this.token = config.token;
        this.apiUrl = '';
        this.REQUEST_TIMEOUT = 5000;
        
        if (!this.accountId || !this.namespaceId || !this.token) {
            throw new Error('CloudflareKVCache requires accountId, namespaceId, and token');
        }
        
        this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`;
    }

    /**
     * Fetch with timeout and error handling
     * @private
     */
    async _fetchWithTimeout(url, options = {}) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);
        
        try {
            const response = await fetch(url, { 
                ...options, 
                signal: controller.signal 
            });
            clearTimeout(id);
            return response;
        } catch (e) {
            clearTimeout(id);
            throw e;
        }
    }

    /**
     * Get a value from Cloudflare KV
     * @param {string} key - The cache key
     * @param {CacheValueType} type - The type of value to retrieve
     * @returns {Promise<any>} - The cached value or null if not found
     */
    async get(key, type = "json") {
        try {
            const res = await this._fetchWithTimeout(
                `${this.apiUrl}/values/${key}`,
                {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                }
            );
            
            if (res.status === 404) return null;
            if (!res.ok) return null;
            
            const value = type === "json" ? await res.json() : 
                         type === "text" ? await res.text() : 
                         await res.arrayBuffer();
            
            return value;
        } catch (e) {
            return null;
        }
    }

    /**
     * Set a value in Cloudflare KV
     * @param {string} key - The cache key
     * @param {any} value - The value to cache
     * @param {number} ttl - Time to live in seconds
     * @returns {Promise<boolean>} - Success status
     */
    async set(key, value, ttl = 3600) {
        try {
            // Force TTL >= 60 seconds for Cloudflare KV compliance
            // Cloudflare KV requires expirationTtl to be at least 60 seconds
            if (!ttl || ttl < 60) {
                console.warn(`[CloudflareKVCache] TTL ${ttl}s is below minimum (60s). Forcing to 60s.`);
                ttl = 60;
            }
            
            const url = new URL(`${this.apiUrl}/values/${key}`);
            
            // Use expirationTtl parameter for KV
            url.searchParams.set('expiration_ttl', ttl.toString());
            
            // Serialize non-string values
            const body = typeof value === 'string' ? value : JSON.stringify(value);
            
            const res = await this._fetchWithTimeout(url.toString(), {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: body
            });
            
            if (!res.ok) throw new Error("Cache Set Error");
            return true;
        } catch (e) {
            console.error('[CloudflareKVCache] Set error:', e.message);
            return false;
        }
    }

    /**
     * Delete a value from Cloudflare KV
     * @param {string} key - The cache key
     * @returns {Promise<boolean>} - Success status
     */
    async delete(key) {
        try {
            await this._fetchWithTimeout(
                `${this.apiUrl}/values/${key}`,
                {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${this.token}` }
                }
            );
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if a key exists in Cloudflare KV
     * @param {string} key - The cache key
     * @returns {Promise<boolean>} - True if exists
     */
    async exists(key) {
        try {
            const res = await this._fetchWithTimeout(
                `${this.apiUrl}/values/${key}`,
                {
                    method: 'HEAD',
                    headers: { 'Authorization': `Bearer ${this.token}` }
                }
            );
            return res.ok && res.status !== 404;
        } catch (e) {
            return false;
        }
    }

    /**
     * Increment a numeric value (not natively supported, using get/set pattern)
     * @param {string} key - The cache key
     * @returns {Promise<number>} - The new value
     */
    async incr(key) {
        try {
            const current = await this.get(key, 'text');
            const value = current ? parseInt(current, 10) : 0;
            const newValue = value + 1;
            const success = await this.set(key, newValue.toString(), 3600);
            return success ? newValue : value;
        } catch (e) {
            return 0;
        }
    }

    /**
     * Acquire a lock (using KV as distributed lock)
     *
     * ⚠️  SECURITY WARNING: Cloudflare KV is eventually consistent!
     * This lock implementation is NOT safe for critical operations.
     * Use only for non-critical operations or as a last resort.
     *
     * @param {string} key - The lock key
     * @param {number} ttl - Lock TTL in seconds
     * @returns {Promise<boolean>} - True if lock acquired
     */
    async lock(key, ttl = 60) {
        console.warn('[CloudflareKVCache] ⚠️  SECURITY WARNING: KV is eventually consistent. Locks are NOT strictly safe. Use with caution!');
        
        try {
            // Force TTL >= 60s for KV compliance
            const safeTtl = Math.max(60, ttl);
            
            // Use a unique value to prevent race conditions
            const lockValue = `lock:${Date.now()}:${Math.random()}`;
            const success = await this.set(key, lockValue, safeTtl);
            if (!success) return false;
            
            // Verify we got the lock (with eventual consistency caveat)
            const verify = await this.get(key, 'text');
            return verify === lockValue;
        } catch (e) {
            console.error('[CloudflareKVCache] Lock error:', e.message);
            return false;
        }
    }

    /**
     * Release a lock
     * @param {string} key - The lock key
     * @returns {Promise<boolean>} - True if lock released
     */
    async unlock(key) {
        try {
            return await this.delete(key);
        } catch (e) {
            return false;
        }
    }

    /**
     * List keys with optional prefix filter and pagination support
     * Automatically handles cursor pagination to fetch all keys
     * @param {string} prefix - Key prefix filter
     * @param {number} limit - Maximum number of keys to return (default 1000, 0 = no limit)
     * @returns {Promise<string[]>} - Array of keys
     */
    async listKeys(prefix = '', limit = 1000) {
        let keys = [];
        let cursor = null;
        let list_complete = false;
        let totalFetched = 0;

        try {
            // Loop until pagination is complete or limit is reached
            while (!list_complete) {
                const url = new URL(`${this.apiUrl}/keys`);
                if (prefix) url.searchParams.set('prefix', prefix);
                if (cursor) url.searchParams.set('cursor', cursor);
                
                const res = await this._fetchWithTimeout(url.toString(), {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });

                if (!res.ok) {
                    console.error(`[CloudflareKVCache] listKeys failed with status ${res.status}`);
                    return keys;
                }

                const data = await res.json();
                if (!data.success || !data.result) {
                    console.error('[CloudflareKVCache] listKeys response not successful');
                    return keys;
                }

                // Extract keys from result
                const newKeys = data.result.map(k => k.name);
                keys = keys.concat(newKeys);
                totalFetched += newKeys.length;

                // Check pagination info from result_info
                if (data.result_info) {
                    list_complete = data.result_info.list_complete === true;
                    cursor = data.result_info.cursor;
                    
                    // If no cursor and not marked complete, assume done
                    if (!cursor && !list_complete) {
                        list_complete = true;
                    }
                } else {
                    // No result_info means no more pages
                    list_complete = true;
                }

                // Stop if we've reached the limit (if limit > 0)
                if (limit > 0 && totalFetched >= limit) {
                    break;
                }

                // Safety: if cursor is missing but not complete, stop to avoid infinite loop
                if (!cursor && !list_complete) {
                    console.warn('[CloudflareKVCache] Missing cursor but list not marked complete, stopping');
                    break;
                }
            }

            return keys;
        } catch (e) {
            console.error('[CloudflareKVCache] listKeys error:', e.message);
            return keys;
        }
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return 'cloudflare';
    }
}

export { CloudflareKVCache };