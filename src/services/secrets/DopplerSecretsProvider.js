/**
 * Doppler Secrets Provider - Doppler-specific implementation
 * Handles Doppler authentication and API interactions using @dopplerhq/node-sdk
 */

import { CloudSecretsProvider } from './CloudSecretsProvider.js';
import Doppler from '@dopplerhq/node-sdk';

/**
 * @typedef {Object} DopplerAuthConfig
 * @property {string} [serviceToken] - Doppler service token
 * @property {string} [dopplerToken] - Doppler CLI token (legacy)
 * @property {string} [apiToken] - Doppler API token
 * @property {string} [serviceAccountToken] - Doppler service account token
 * @property {string} [apiKey] - Doppler API key (legacy)
 */

/**
 * @typedef {Object} DopplerSecretsConfig
 * @property {string} [project] - Doppler project name
 * @property {string} [config] - Doppler config name (environment)
 * @property {string[]} [includeSecrets] - Specific secret names to include
 * @property {string[]} [excludeSecrets] - Specific secret names to exclude
 * @property {boolean} [download_secrets=true] - Include secrets in download
 * @property {boolean} [download_logs=false] - Include logs in download
 * @property {string} [format] - Output format (json, env, etc.)
 * @property {DopplerAuthConfig} auth - Authentication configuration
 */

/**
 * Doppler-specific secrets provider implementation
 */
export class DopplerSecretsProvider extends CloudSecretsProvider {
    /**
     * @param {DopplerSecretsConfig} config 
     */
    constructor(config = {}) {
        super({
            enableHashing: true,
            includePatterns: [],
            excludePatterns: [],
            ...config
        });
        
        this.config = {
            config: 'dev', // Default environment
            download_secrets: true,
            download_logs: false,
            format: 'json',
            includeSecrets: [],
            excludeSecrets: [],
            ...config
        };
        
        this.doppler = null;
        this.isAuthenticated = false;
        
        // Validate required configuration
        if (!this.config.auth && !this._hasAuthCredentials()) {
            throw new Error('Authentication configuration is required for DopplerSecretsProvider');
        }
    }
    
    /**
     * Check if any authentication credentials are available
     * @private
     * @returns {boolean}
     */
    _hasAuthCredentials() {
        const auth = this.config.auth || {};
        return !!(auth.serviceToken || auth.dopplerToken || auth.apiToken || 
                  auth.serviceAccountToken || auth.apiKey || 
                  process.env.DOPPLER_TOKEN || process.env.DOPPLER_API_TOKEN ||
                  process.env.DOPPLER_SERVICE_ACCOUNT_TOKEN);
    }
    
    /**
     * Get authentication token in priority order
     * @private
     * @returns {string|null}
     */
    _getAuthToken() {
        const auth = this.config.auth || {};
        
        // Priority order for token selection
        return auth.serviceToken || 
               auth.apiToken || 
               auth.serviceAccountToken || 
               auth.dopplerToken || 
               auth.apiKey ||
               process.env.DOPPLER_TOKEN ||
               process.env.DOPPLER_API_TOKEN ||
               process.env.DOPPLER_SERVICE_ACCOUNT_TOKEN ||
               null;
    }
    
    /**
     * Get project name from config or environment
     * @private
     * @returns {string|null}
     */
    _getProjectName() {
        return this.config.project || 
               process.env.DOPPLER_PROJECT ||
               process.env.DOPPLER_CONFIG_NAME ||
               null;
    }
    
    /**
     * Get environment/config name
     * @private
     * @returns {string}
     */
    _getConfigName() {
        const env = this.config.environment || this.config.config || 'dev';
        
        // Map common environment names to Doppler config names
        const envMap = {
            'dev': 'dev',
            'development': 'dev',
            'stage': 'staging',
            'staging': 'staging',
            'pre': 'staging',
            'pre-production': 'staging',
            'prod': 'prod',
            'production': 'prod'
        };
        
        return envMap[env] || env;
    }
    
    /**
     * Authenticate with Doppler
     * @returns {Promise<void>}
     */
    async authenticate() {
        try {
            const token = this._getAuthToken();
            if (!token) {
                throw new Error('No Doppler authentication token found');
            }
            
            const projectName = this._getProjectName();
            if (!projectName) {
                throw new Error('Doppler project name is required');
            }
            
            // Initialize Doppler SDK
            this.doppler = new Doppler({
                token: token,
                apiHost: this.config.auth?.apiHost || 'https://api.doppler.com'
            });
            
            // Test authentication by fetching a simple response
            await this.doppler.getSecrets({
                project: projectName,
                config: this._getConfigName()
            });
            
            this.isAuthenticated = true;
            
        } catch (error) {
            this.isAuthenticated = false;
            throw new Error(`Doppler authentication failed: ${error.message}`);
        }
    }
    
    /**
     * Fetch secrets from Doppler
     * @returns {Promise<Map<string, string>>}
     */
    async fetchSecrets() {
        if (!this.isAuthenticated || !this.doppler) {
            throw new Error('Not authenticated with Doppler');
        }
        
        try {
            const projectName = this._getProjectName();
            const configName = this._getConfigName();
            
            const options = {
                project: projectName,
                config: configName
            };
            
            // Add filtering options if specified
            if (this.config.includeSecrets.length > 0) {
                options.names = this.config.includeSecrets;
            }
            
            // Fetch secrets from Doppler
            const response = await this.doppler.getSecrets(options);
            
            this.lastFetchTime = new Date().toISOString();
            
            // Transform Doppler response to standard format
            const standardResponse = {
                secrets: Object.entries(response).map(([key, value]) => ({
                    key,
                    value: typeof value === 'string' ? value : JSON.stringify(value),
                    source: 'doppler'
                }))
            };
            
            return this.parseSecrets(standardResponse);
            
        } catch (error) {
            throw new Error(`Failed to fetch secrets from Doppler: ${error.message}`);
        }
    }
    
    /**
     * Create a new secret in Doppler
     * @param {string} key 
     * @param {string} value 
     * @param {Object} options 
     * @returns {Promise<void>}
     */
    async createSecret(key, value, options = {}) {
        if (!this.isAuthenticated || !this.doppler) {
            throw new Error('Not authenticated with Doppler');
        }
        
        try {
            const projectName = this._getProjectName();
            const configName = this._getConfigName();
            
            await this.doppler.setSecret({
                project: projectName,
                config: configName,
                name: key,
                value: value,
                ...options
            });
            
            // Refresh secrets after creation
            await this.refreshSecrets();
            
        } catch (error) {
            throw new Error(`Failed to create secret in Doppler: ${error.message}`);
        }
    }
    
    /**
     * Update an existing secret in Doppler
     * @param {string} key 
     * @param {string} value 
     * @param {Object} options 
     * @returns {Promise<void>}
     */
    async updateSecret(key, value, options = {}) {
        if (!this.isAuthenticated || !this.doppler) {
            throw new Error('Not authenticated with Doppler');
        }
        
        try {
            const projectName = this._getProjectName();
            const configName = this._getConfigName();
            
            await this.doppler.setSecret({
                project: projectName,
                config: configName,
                name: key,
                value: value,
                ...options
            });
            
            // Refresh secrets after update
            await this.refreshSecrets();
            
        } catch (error) {
            throw new Error(`Failed to update secret in Doppler: ${error.message}`);
        }
    }
    
    /**
     * Delete a secret from Doppler
     * @param {string} key 
     * @returns {Promise<void>}
     */
    async deleteSecret(key) {
        if (!this.isAuthenticated || !this.doppler) {
            throw new Error('Not authenticated with Doppler');
        }
        
        try {
            const projectName = this._getProjectName();
            const configName = this._getConfigName();
            
            await this.doppler.deleteSecret({
                project: projectName,
                config: configName,
                name: key
            });
            
            // Refresh secrets after deletion
            await this.refreshSecrets();
            
        } catch (error) {
            throw new Error(`Failed to delete secret in Doppler: ${error.message}`);
        }
    }
    
    /**
     * Get extended metadata including Doppler-specific information
     * @returns {Object}
     */
    getMetadata() {
        return {
            ...super.getMetadata(),
            provider: 'DopplerSecretsProvider',
            project: this._getProjectName(),
            config: this._getConfigName(),
            environment: this.config.environment,
            isAuthenticated: this.isAuthenticated,
            includeSecrets: this.config.includeSecrets,
            excludeSecrets: this.config.excludeSecrets,
            authMethod: this._getAuthToken() ? 'token' : 'none',
            apiHost: this.config.auth?.apiHost || 'https://api.doppler.com'
        };
    }
    
    /**
     * Cleanup with client disconnection
     * @returns {Promise<void>}
     */
    async cleanup() {
        this.isAuthenticated = false;
        this.doppler = null;
        await super.cleanup();
    }
    
    /**
     * Validate Doppler response format
     * @protected
     * @param {any} response 
     * @returns {boolean}
     */
    validateResponse(response) {
        if (!response || typeof response !== 'object') {
            return false;
        }
        
        // Doppler API returns an object with secret keys as properties
        return true;
    }
    
    /**
     * Parse Doppler response to standard format
     * @protected
     * @param {Object} response 
     * @returns {Map<string, string>}
     */
    parseSecrets(response) {
        const secrets = new Map();
        
        if (!this.validateResponse(response)) {
            throw new Error('Invalid response format from Doppler');
        }
        
        // If the response is already in our standard format, use it
        if (response.secrets && Array.isArray(response.secrets)) {
            for (const secret of response.secrets) {
                if (secret.key && secret.value !== undefined) {
                    if (this._shouldIncludeSecret(secret.key)) {
                        secrets.set(secret.key, String(secret.value));
                    }
                }
            }
        } else {
            // Direct Doppler API response format: { key1: value1, key2: value2 }
            for (const [key, value] of Object.entries(response)) {
                if (this._shouldIncludeSecret(key)) {
                    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
                    secrets.set(key, stringValue);
                }
            }
        }
        
        return secrets;
    }
}