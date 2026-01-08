/**
 * NorthFlankRTCache - Redis cache for Northflank platform
 * Automatically detects and parses NF_REDIS_URL from environment
 * Hardened for Northflank platform with enhanced TLS and error handling
 */

import { RedisTLSCache } from './RedisTLSCache.js';

class NorthFlankRTCache extends RedisTLSCache {
    static detectConfig(env = process.env, options = {}) {
        const allowRedisUrl = options.allowRedisUrl !== false;
        const redisUrl = env.NF_REDIS_URL || (allowRedisUrl ? env.REDIS_URL : undefined);
        if (!redisUrl) {
            return null;
        }

        const parsedConfig = NorthFlankRTCache.parseRedisUrlStatic(redisUrl);
        return { ...parsedConfig, url: redisUrl };
    }

    /**
     * @param {Object} config - Optional config override
     * If not provided, will auto-detect from env.NF_REDIS_URL
     */
    constructor(config = {}) {
        const { env, url, ...restConfig } = config;
        let resolvedConfig = { ...restConfig };
        let resolvedUrl = url;

        if (!resolvedUrl && env) {
            const detected = NorthFlankRTCache.detectConfig(env);
            if (detected) {
                resolvedUrl = detected.url;
                const { url: _ignored, ...detectedConfig } = detected;
                resolvedConfig = { ...detectedConfig, ...restConfig };
            }
        }

        if (resolvedUrl && (!resolvedConfig.host || !resolvedConfig.port)) {
            const parsedConfig = NorthFlankRTCache.parseRedisUrlStatic(resolvedUrl);
            resolvedConfig = { ...parsedConfig, ...restConfig };
        }

        // If config is provided, use it directly
        if (resolvedConfig.host && resolvedConfig.port) {
            // Apply Northflank-specific TLS defaults if not specified
            const hardenedConfig = {
                ...resolvedConfig,
                tls: resolvedConfig.tls || {
                    rejectUnauthorized: false,
                    // Additional TLS options for Northflank compatibility
                    enableOfflineQueue: false,
                    maxRetriesPerRequest: 1
                },
                // Connection timeout settings for container environments
                connectTimeout: 10000,
                commandTimeout: 5000,
                // Retry strategy for container environments
                maxRetriesPerRequest: 1,
                retryStrategy: (times) => {
                    // Quick failover for container environments
                    if (times <= 2) {
                        return Math.min(times * 50, 200);
                    }
                    return null; // Stop retrying
                }
            };
            
            super(hardenedConfig);
            this.source = 'provided-config';
            this.redisUrl = resolvedUrl || `${resolvedConfig.host}:${resolvedConfig.port}`;
            console.log('[NorthFlankRTCache] Using provided configuration with Northflank hardening');
            return;
        }

        // Auto-detect from environment
        const detected = NorthFlankRTCache.detectConfig(process.env);
        
        if (!detected) {
            throw new Error('[NorthFlankRTCache] No Redis URL found in environment (NF_REDIS_URL or REDIS_URL)');
        }

        // Parse Redis URL format: redis://user:password@host:port/db
        // Use static method to avoid 'this' before super() issue
        const { url: detectedUrl, ...parsedConfig } = detected;
        
        // Merge with any additional config and apply Northflank hardening
        const finalConfig = {
            ...parsedConfig,
            ...restConfig,
            // 🔒 FORCE TLS for Northflank (defensive default)
            // Northflank requires TLS for external connections
            tls: restConfig.tls || parsedConfig.tls || {
                rejectUnauthorized: false, // Support self-signed certs
                // Additional TLS options for Northflank compatibility
                enableOfflineQueue: false
            },
            // ⚡ Connection settings optimized for container environments
            connectTimeout: 10000,  // 10s connection timeout
            commandTimeout: 5000,   // 5s command timeout
            maxRetriesPerRequest: 1, // Quick failover
            // Custom retry strategy for quick failover
            retryStrategy: (times) => {
                if (times <= 2) {
                    return Math.min(times * 50, 200);
                }
                return null; // Stop retrying after 2 attempts
            }
        };

        super(finalConfig);
        this.source = 'env-detection';
        this.redisUrl = detectedUrl;
        this.parsedConfig = parsedConfig;
        
        console.log('[NorthFlankRTCache] ✅ Auto-detected configuration with Northflank hardening');
        console.log(`[NorthFlankRTCache] 🌐 Connection: ${this._maskUrl(detectedUrl)}`);
        console.log(`[NorthFlankRTCache] 🔒 TLS: ${finalConfig.tls ? 'ENABLED' : 'DISABLED'} (rejectUnauthorized: ${finalConfig.tls?.rejectUnauthorized})`);
    }

    /**
     * Static method to parse Redis URL (can be called before super())
     * @param {string} url - Redis URL (redis:// or rediss://)
     * @returns {Object} - Parsed configuration
     */
    static parseRedisUrlStatic(url) {
        try {
            // Validate URL format
            if (!url || typeof url !== 'string') {
                throw new Error('Invalid URL format');
            }

            const parsed = new URL(url);
            
            // Validate required components
            if (!parsed.hostname) {
                throw new Error('Missing hostname');
            }

            const config = {
                host: parsed.hostname,
                port: parseInt(parsed.port) || 6379,
                password: parsed.password || undefined,
                db: parsed.pathname && parsed.pathname.length > 1 ?
                     parseInt(parsed.pathname.substring(1)) : 0
            };

            // Handle protocol-specific TLS settings
            const protocol = parsed.protocol.toLowerCase();
            
            if (protocol === 'rediss:') {
                // Explicit TLS requested
                config.tls = {
                    rejectUnauthorized: false
                };
                console.log('[NorthFlankRTCache] Detected rediss:// protocol, enabling TLS');
            } else if (protocol === 'redis:') {
                // Redis without TLS - but for Northflank, we'll still recommend TLS
                console.log('[NorthFlankRTCache] Detected redis:// protocol, applying defensive TLS for Northflank');
                config.tls = {
                    rejectUnauthorized: false
                };
            } else {
                throw new Error(`Unsupported protocol: ${parsed.protocol}. Expected 'redis://' or 'rediss://'`);
            }

            // Remove undefined values
            Object.keys(config).forEach(key => {
                if (config[key] === undefined) {
                    delete config[key];
                }
            });

            return config;
        } catch (error) {
            // Enhanced error message with debugging info
            const errorMsg = `[NorthFlankRTCache] Failed to parse Redis URL: ${error.message}. ` +
                           `Expected format: redis://[:password@]host:port[/db] or rediss://[:password@]host:port[/db]`;
            console.error(errorMsg);
            throw new Error(errorMsg);
        }
    }

    /**
     * Parse Redis connection URL (instance method for backward compatibility)
     * @param {string} url - Redis URL (redis:// or rediss://)
     * @returns {Object} - Parsed configuration
     */
    _parseRedisUrl(url) {
        return NorthFlankRTCache.parseRedisUrlStatic(url);
    }

    /**
     * Override error reporting from RedisCache to add Northflank-specific guidance
     * @param {Error} error
     */
    _reportError(error) {
        if (error.code === 'ECONNREFUSED') {
            console.error('═══════════════════════════════════════════════════════════════');
            console.error('[NorthFlankRTCache] ❌ ECONNREFUSED - Connection refused by server');
            console.error('═══════════════════════════════════════════════════════════════');
            console.error('');
            console.error('[NorthFlankRTCache] 🎯 Troubleshooting steps for Northflank:');
            console.error('  1. ✅ Verify Redis service is running in Northflank dashboard');
            console.error('  2. ✅ Check "Publicly accessible" toggle is ENABLED');
            console.error('  3. ✅ Review Northflank network policies and firewall rules');
            console.error('  4. ✅ Confirm host/port match Northflank Redis credentials');
            console.error('  5. ✅ Ensure TLS is enabled (Northflank requires TLS for external connections)');
            console.error('  6. ✅ Check if Redis instance is in "Running" state (not "Starting")');
            console.error('');
            console.error('[NorthFlankRTCache] 💡 Common Northflank issues:');
            console.error('  • Redis credentials change after instance restart');
            console.error('  • Public access requires manual toggle in dashboard');
            console.error('  • TLS certificates may be self-signed (rejectUnauthorized: false needed)');
            console.error('');
            console.error('[NorthFlankRTCache] 🔄 Will trigger failover mechanism to next provider');
            console.error('═══════════════════════════════════════════════════════════════');
        } else if (error.code === 'ETIMEDOUT') {
            console.error('[NorthFlankRTCache] ⏱️  ETIMEDOUT - Connection timeout');
            console.error('[NorthFlankRTCache] Possible causes:');
            console.error('  • Network latency between your server and Northflank');
            console.error('  • Redis instance under high load');
            console.error('  • Firewall blocking connection');
        } else if (error.code === 'ECONNRESET') {
            console.error('[NorthFlankRTCache] 🔄 ECONNRESET - Connection reset by peer');
            console.error('[NorthFlankRTCache] This usually means:');
            console.error('  • Northflank Redis instance is restarting');
            console.error('  • Network interruption occurred');
            console.error('  • Redis max connections limit reached');
        } else if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
            console.error('[NorthFlankRTCache] 🌐 DNS resolution failed:', error.message);
            console.error('[NorthFlankRTCache] Check:');
            console.error('  • Northflank Redis hostname is correct');
            console.error('  • DNS resolution is working from your environment');
        } else {
            console.error(`[NorthFlankRTCache] ⚠️  Connection error (${error.code}):`, error.message);
        }
        
        // Call parent's error reporting if needed
        if (super._reportError) {
            super._reportError(error);
        }
    }

    /**
     * Get connection info for debugging
     * @returns {Object} - Connection details
     */
    getConnectionInfo() {
        const info = {
            provider: this.getProviderName(),
            source: this.source,
            host: this.config.host,
            port: this.config.port,
            db: this.config.db,
            hasPassword: !!this.config.password,
            tlsEnabled: !!this.config.tls,
            urlMasked: this.redisUrl ? this._maskUrl(this.redisUrl) : undefined,
            // Northflank-specific settings
            connectTimeout: this.config.connectTimeout,
            commandTimeout: this.config.commandTimeout,
            maxRetriesPerRequest: this.config.maxRetriesPerRequest,
            tlsConfig: this.config.tls
        };
        
        // Log connection info for debugging
        console.log('[NorthFlankRTCache] Connection Info:', JSON.stringify(info, null, 2));
        return info;
    }

    /**
     * Mask URL for logging (hide password)
     * @param {string} url
     * @returns {string} - Masked URL
     */
    _maskUrl(url) {
        try {
            const parsed = new URL(url);
            if (parsed.password) {
                parsed.password = '***';
            }
            // Also mask user if present
            if (parsed.username) {
                parsed.username = '***';
            }
            return parsed.toString();
        } catch {
            // If URL parsing fails, try basic masking
            return url.replace(/:\/\/[^@]*@/, '://***:***@');
        }
    }

    /**
     * Validate connection configuration before attempting to connect
     * @returns {Object} - Validation result with isValid and errors
     */
    validateConnectionConfig() {
        const errors = [];
        const warnings = [];
        
        if (!this.config.host) {
            errors.push('Missing host configuration');
        }
        
        if (!this.config.port) {
            errors.push('Missing port configuration');
        } else if (this.config.port < 1 || this.config.port > 65535) {
            errors.push('Invalid port number');
        }
        
        if (!this.config.tls) {
            warnings.push('TLS is not enabled - this may not work on Northflank public networks');
        } else if (this.config.tls.rejectUnauthorized === false) {
            warnings.push('TLS verification is disabled - using self-signed certificates');
        }
        
        if (!this.config.password) {
            warnings.push('No password provided - ensure Redis allows anonymous connections');
        }
        
        const isValid = errors.length === 0;
        
        if (!isValid) {
            console.error('[NorthFlankRTCache] Configuration validation failed:', errors);
        }
        
        if (warnings.length > 0) {
            console.warn('[NorthFlankRTCache] Configuration warnings:', warnings);
        }
        
        return {
            isValid,
            errors,
            warnings
        };
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return 'NorthFlankRTCache';
    }

    /**
     * Test connection with detailed diagnostics
     * @returns {Promise<boolean>} - True if connection successful
     */
    async testConnection() {
        try {
            console.log('[NorthFlankRTCache] Testing connection...');
            
            // Validate config first
            const validation = this.validateConnectionConfig();
            if (!validation.isValid) {
                console.error('[NorthFlankRTCache] Config validation failed before connection test');
                return false;
            }
            
            // Test ping
            const startTime = Date.now();
            await this.redis.ping();
            const duration = Date.now() - startTime;
            
            console.log(`[NorthFlankRTCache] Connection test successful (ping: ${duration}ms)`);
            return true;
        } catch (error) {
            console.error('[NorthFlankRTCache] Connection test failed:', error.message);
            this._reportError(error);
            return false;
        }
    }
}

export { NorthFlankRTCache };
