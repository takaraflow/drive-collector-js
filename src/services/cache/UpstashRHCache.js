/**
 * UpstashRHCache - Upstash Redis HTTP specific provider
 * Extends RedisHTTPCache with Upstash-specific configuration, atomic locks, and pipeline support
 */

import { RedisHTTPCache } from './RedisHTTPCache.js';

class UpstashRHCache extends RedisHTTPCache {
    /**
     * @param {Object} config - Optional config override
     * If not provided, will auto-detect from environment variables
     */
    constructor(config = {}) {
        // Auto-detect from environment if not provided
        const finalConfig = {
            url: config.url || process.env.UPSTASH_REDIS_REST_URL,
            token: config.token || process.env.UPSTASH_REDIS_REST_TOKEN,
            ...config
        };

        if (!finalConfig.url || !finalConfig.token) {
            throw new Error('UpstashRHCache requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
        }

        super(finalConfig);
        
        console.log('[UpstashRHCache] Initialized with Upstash REST API');
    }

    /**
     * Override _sendCommand to handle Upstash-specific response format and telemetry
     * @private
     * @param {Array|Array[]} command - Redis command or pipeline array
     * @returns {Promise<any>} - Command result
     */
    async _sendCommand(command) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);
        
        // Check if this is a pipeline (array of arrays)
        const isPipeline = Array.isArray(command) && command.length > 0 && Array.isArray(command[0]);
        
        try {
            const response = await fetch(`${this.apiUrl}/exec`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(command),
                signal: controller.signal
            });
            
            clearTimeout(id);
            
            // Log telemetry headers if available (DEBUG mode)
            const cost = response.headers.get('Upstash-Request-Cost');
            const latency = response.headers.get('Upstash-Latency');
            if (cost || latency) {
                console.debug(`[UpstashRHCache] Telemetry - Cost: ${cost}, Latency: ${latency}ms`);
            }
            
            if (!response.ok) {
                // Handle specific HTTP errors
                if (response.status === 401) {
                    throw new Error('Upstash authentication failed - check your token');
                }
                if (response.status === 429) {
                    throw new Error('Upstash rate limit exceeded');
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            // Handle error response - Upstash returns {error: "..."} format
            if (data && data.error) {
                throw new Error(`Upstash error: ${data.error}`);
            }
            
            // Handle pipeline response - Upstash returns array of {result: ...} or {error: ...}
            if (isPipeline) {
                if (Array.isArray(data)) {
                    return data.map(item => {
                        // Precise parsing of Upstash response format
                        if (item && item.error) {
                            return new Error(item.error);
                        }
                        // Return result if present, otherwise null
                        return item && 'result' in item ? item.result : null;
                    });
                }
                // Unexpected format, wrap in array
                return [data];
            }
            
            // Handle single command response - Upstash returns {result: ...} format
            if (data && 'result' in data) {
                return data.result;
            }
            
            // Handle edge cases
            if (data === null || data === undefined) {
                return null;
            }
            
            // If we get here, return the data as-is but log a warning
            console.warn('[UpstashRHCache] Unexpected response format:', data);
            return data;
        } catch (error) {
            clearTimeout(id);
            
            // Network errors
            if (error.name === 'AbortError') {
                console.error('[UpstashRHCache] Request timeout');
                throw new Error('Upstash request timeout');
            }
            
            if (error.message.includes('fetch')) {
                console.error('[UpstashRHCache] Network error:', error.message);
                throw new Error('Network error connecting to Upstash');
            }
            
            console.error('[UpstashRHCache] Command error:', error.message);
            throw error;
        }
    }

    /**
     * Acquire a lock using Lua script for atomicity
     * @param {string} key - The lock key
     * @param {number} ttl - Lock TTL in seconds
     * @returns {Promise<boolean>} - True if lock acquired
     */
    async lock(key, ttl = 60) {
        try {
            // Lua script for atomic lock with token
            // SET key value NX PX ttl - Only set if not exists, with millisecond expiration
            const lockScript = `
                if redis.call("set", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then
                    return 1
                else
                    return 0
                end
            `;
            const lockToken = `lock:${Date.now()}:${Math.random()}`;
            const ttlMs = ttl * 1000;
            
            const result = await this._sendCommand(['EVAL', lockScript, '1', key, lockToken, ttlMs]);
            
            // Store token for unlock verification
            if (result === 1) {
                this._lockTokens = this._lockTokens || new Map();
                this._lockTokens.set(key, lockToken);
                console.log(`[UpstashRHCache] Lock acquired: ${key}`);
                return true;
            }
            console.log(`[UpstashRHCache] Lock failed: ${key} (already locked)`);
            return false;
        } catch (error) {
            console.error('[UpstashRHCache] Lock error:', error.message);
            return false;
        }
    }

    /**
     * Release a lock using Lua script for atomicity
     * Only deletes if the value matches our token (prevents deleting someone else's lock)
     * @param {string} key - The lock key
     * @returns {Promise<boolean>} - True if lock released
     */
    async unlock(key) {
        try {
            // Get stored token
            this._lockTokens = this._lockTokens || new Map();
            const lockToken = this._lockTokens.get(key);
            
            if (!lockToken) {
                console.warn('[UpstashRHCache] No token found for lock:', key);
                return false;
            }
            
            // Lua script for atomic unlock with token verification
            // Only delete if the current value matches our token
            const unlockScript = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;
            
            const result = await this._sendCommand(['EVAL', unlockScript, '1', key, lockToken]);
            
            if (result === 1) {
                this._lockTokens.delete(key);
                console.log(`[UpstashRHCache] Lock released: ${key}`);
                return true;
            }
            console.log(`[UpstashRHCache] Lock release failed: ${key} (token mismatch or already released)`);
            return false;
        } catch (error) {
            console.error('[UpstashRHCache] Unlock error:', error.message);
            return false;
        }
    }

    /**
     * Create a pipeline for batch operations
     * Uses Upstash's optimized pipeline endpoint for reduced RTT
     * @returns {UpstashPipeline} - Pipeline instance
     */
    pipeline() {
        console.log('[UpstashRHCache] Creating pipeline for batch operations');
        return new UpstashPipeline(this);
    }

    /**
     * Execute pipeline commands using Upstash's /pipeline endpoint
     * @private
     * @param {Array} commands - Array of Redis commands
     * @returns {Promise<Array>} - Array of results
     */
    async _executePipeline(commands) {
        if (!commands || commands.length === 0) {
            return [];
        }

        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT * 2); // Longer timeout for pipelines

        try {
            // Try /pipeline endpoint first (optimized), fall back to /exec
            const endpoint = `${this.apiUrl}/pipeline`;
            
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(commands),
                signal: controller.signal
            });

            clearTimeout(id);

            // Log telemetry
            const cost = response.headers.get('Upstash-Request-Cost');
            const latency = response.headers.get('Upstash-Latency');
            if (cost || latency) {
                console.debug(`[UpstashRHCache] Pipeline Telemetry - Cost: ${cost}, Latency: ${latency}ms`);
            }

            if (!response.ok) {
                // If /pipeline not supported, fall back to /exec
                if (response.status === 404) {
                    console.log('[UpstashRHCache] /pipeline not available, falling back to /exec');
                    return await this._sendCommand(commands);
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            // Handle error response
            if (data.error) {
                throw new Error(`Upstash pipeline error: ${data.error}`);
            }

            // Parse pipeline response format
            if (Array.isArray(data)) {
                return data.map(item => {
                    if (item.error) {
                        return new Error(item.error);
                    }
                    return item.result !== undefined ? item.result : null;
                });
            }

            // Fallback: if response is not array, treat as single result
            if ('result' in data) {
                return [data.result];
            }

            return data;
        } catch (error) {
            clearTimeout(id);
            
            if (error.name === 'AbortError') {
                console.error('[UpstashRHCache] Pipeline timeout');
                throw new Error('Pipeline request timeout');
            }

            console.error('[UpstashRHCache] Pipeline error:', error.message);
            throw error;
        }
    }

    /**
     * Get connection info for debugging
     * @returns {Object} - Connection details
     */
    getConnectionInfo() {
        return {
            provider: this.getProviderName(),
            url: this._maskUrl(this.url),
            hasToken: !!this.token,
            endpoint: 'Upstash REST API'
        };
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return 'UpstashRHCache';
    }

    /**
     * Cleanup resources
     * @returns {Promise<void>}
     */
    async destroy() {
        this._lockTokens?.clear();
        console.log('[UpstashRHCache] Connection closed');
    }
}

/**
 * UpstashPipeline - Pipeline for batch operations
 * Extends base Pipeline with Upstash-specific optimizations
 */
class UpstashPipeline {
    constructor(cache) {
        this.cache = cache;
        this.commands = [];
    }

    /**
     * Add SET command to pipeline
     */
    set(key, value, ttl) {
        const serializedValue = typeof value === 'string' ? value : JSON.stringify(value);
        if (ttl) {
            this.commands.push(['SET', key, serializedValue, 'EX', ttl]);
        } else {
            this.commands.push(['SET', key, serializedValue]);
        }
        return this;
    }

    /**
     * Add GET command to pipeline
     */
    get(key) {
        this.commands.push(['GET', key]);
        return this;
    }

    /**
     * Add DEL command to pipeline
     */
    del(key) {
        this.commands.push(['DEL', key]);
        return this;
    }

    /**
     * Add EXISTS command to pipeline
     */
    exists(key) {
        this.commands.push(['EXISTS', key]);
        return this;
    }

    /**
     * Add INCR command to pipeline
     */
    incr(key) {
        this.commands.push(['INCR', key]);
        return this;
    }

    /**
     * Add EXPIRE command to pipeline
     */
    expire(key, seconds) {
        this.commands.push(['EXPIRE', key, seconds]);
        return this;
    }

    /**
     * Execute all commands in pipeline
     * @returns {Promise<Array>} - Array of results
     */
    async exec() {
        if (this.commands.length === 0) {
            return [];
        }

        try {
            // Use the optimized pipeline execution method
            const results = await this.cache._executePipeline(this.commands);
            
            // Filter out Error objects and return clean results
            return results.map(result => {
                if (result instanceof Error) {
                    // Return error message or null based on preference
                    return null;
                }
                return result;
            });
        } catch (error) {
            console.error('[UpstashPipeline] Execution error:', error.message);
            throw error;
        }
    }
}

export { UpstashRHCache, UpstashPipeline };
