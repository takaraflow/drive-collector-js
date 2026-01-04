import { logger } from './logger.js';

const INFISICAL_API_BASE = 'https://app.infisical.com/api/v3';

/**
 * InfisicalClient - Secure in-memory secret retrieval
 * Fetches secrets directly from Infisical API without writing to disk.
 */
class InfisicalClient {
    constructor() {
        this.secretsCache = null;
        this.cacheTimestamp = null;
        this.CACHE_TTL = 5 * 60 * 1000; // 5 minutes
    }

    /**
     * Fetches secrets from Infisical using REST API
     * Implements retry logic and returns a key-value map
     */
    async fetchSecrets() {
        const token = process.env.INFISICAL_TOKEN;
        const projectId = process.env.INFISICAL_PROJECT_ID;
        const env = process.env.INFISICAL_ENV || 'prod';
        const secretPath = process.env.INFISICAL_SECRET_PATH || '/';

        if (!token || !projectId) {
            logger.warn('⚠️ InfisicalClient: Missing INFISICAL_TOKEN or INFISICAL_PROJECT_ID');
            return null;
        }

        // Check cache
        if (this.secretsCache && this.cacheTimestamp && 
            (Date.now() - this.cacheTimestamp < this.CACHE_TTL)) {
            logger.debug('ℹ️ InfisicalClient: Using cached secrets');
            return this.secretsCache;
        }

        const MAX_RETRIES = 3;
        const RETRY_DELAY = 1000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                logger.info(`🚀 InfisicalClient: Fetching secrets (Attempt ${attempt}/${MAX_RETRIES})...`);
                
                // Build URL with query parameters
                const url = new URL(`${INFISICAL_API_BASE}/secrets/raw`);
                url.searchParams.append('workspaceId', projectId);
                url.searchParams.append('environment', env);
                url.searchParams.append('secretPath', secretPath);

                // Use fetch with timeout
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                const response = await fetch(url.toString(), {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`HTTP ${response.status}: ${errorText}`);
                }

                const data = await response.json();

                if (data && data.secrets) {
                    const secretsMap = {};
                    
                    // Convert array of secrets to key-value map
                    data.secrets.forEach(secret => {
                        // Strip quotes if present (common issue with Infisical API)
                        let value = secret.secretValue;
                        if (typeof value === 'string') {
                            value = value.trim();
                            if ((value.startsWith('"') && value.endsWith('"')) || 
                                (value.startsWith("'") && value.endsWith("'"))) {
                                value = value.slice(1, -1);
                            }
                        }
                        secretsMap[secret.secretKey] = value;
                    });

                    // Update cache
                    this.secretsCache = secretsMap;
                    this.cacheTimestamp = Date.now();

                    logger.info(`✅ InfisicalClient: Successfully fetched ${Object.keys(secretsMap).length} secrets`);
                    return secretsMap;
                }
            } catch (error) {
                const isLastAttempt = attempt === MAX_RETRIES;
                
                // Handle fetch-specific errors
                if (error.name === 'AbortError') {
                    logger.error(`❌ InfisicalClient Timeout (Attempt ${attempt}): Request timed out`);
                } else if (error.message.includes('HTTP')) {
                    logger.error(`❌ InfisicalClient API Error (Attempt ${attempt}): ${error.message}`);
                } else {
                    logger.error(`❌ InfisicalClient Error (Attempt ${attempt}): ${error.message}`);
                }

                if (isLastAttempt) {
                    logger.error('❌ InfisicalClient: All retry attempts failed');
                    return null;
                }

                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }

        return null;
    }

    /**
     * Gets secrets with fallback to process.env
     * Returns merged config object
     */
    async getMergedConfig() {
        const infisicalSecrets = await this.fetchSecrets();
        
        // If Infisical failed, return process.env only
        if (!infisicalSecrets) {
            logger.warn('⚠️ InfisicalClient: Falling back to process.env');
            return { ...process.env };
        }

        // Merge: Infisical secrets override process.env
        // But we keep process.env for cloud provider specific vars
        return {
            ...process.env,      // Cloud provider config (lower priority)
            ...infisicalSecrets  // Infisical config (higher priority)
        };
    }

    /**
     * Clear cache (useful for testing)
     */
    clearCache() {
        this.secretsCache = null;
        this.cacheTimestamp = null;
    }
}

// Singleton instance
const infisicalClient = new InfisicalClient();

export default infisicalClient;