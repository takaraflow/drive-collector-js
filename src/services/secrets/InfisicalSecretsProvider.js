/**
 * Infisical Secrets Provider - Infisical-specific implementation
 * Handles Infisical authentication and API interactions using @infisical/sdk
 */

import { CloudSecretsProvider } from './CloudSecretsProvider.js';
import { InfisicalClient } from '@infisical/sdk';

/**
 * @typedef {Object} InfisicalAuthConfig
 * @property {string} token - Service token for authentication
 * @property {string} [siteURL] - Custom Infisical site URL
 * @property {string} [universalAuthClientId] - Universal auth client ID
 * @property {string} [universalAuthClientSecret] - Universal auth client secret
 * @property {string} [machineIdentityClientId] - Machine identity client ID
 * @property {string} [machineIdentityClientSecret] - Machine identity client secret
 * @property {number} [machineIdentityIdentityId] - Machine identity ID
 */

/**
 * @typedef {Object} InfisicalSecretsConfig
 * @property {string} projectId - Infisical project ID
 * @property {string} [environment='dev'] - Environment name (dev, staging, prod)
 * @property {string} [path='/'] - Secret path in Infisical
 * @property {string[]} [includeSecrets] - Specific secret names to include
 * @property {string[]} [excludeSecrets] - Specific secret names to exclude
 * @property {boolean} [importSecrets=true] - Import secrets into environment
 * @property {InfisicalAuthConfig} auth - Authentication configuration
 */

/**
 * Infisical-specific secrets provider implementation
 */
export class InfisicalSecretsProvider extends CloudSecretsProvider {
    /**
     * @param {InfisicalSecretsConfig} config 
     */
    constructor(config = {}) {
        super({
            enableHashing: true,
            includePatterns: [],
            excludePatterns: [],
            environment: 'dev',
            path: '/',
            includeSecrets: [],
            excludeSecrets: [],
            importSecrets: true,
            ...config
        });
        
        this.client = null;
        this.isAuthenticated = false;
        
        // Validate required configuration
        if (!this.config.projectId) {
            throw new Error('projectId is required for InfisicalSecretsProvider');
        }
        
        if (!this.config.auth && !this.config.auth?.token) {
            throw new Error('Authentication configuration is required');
        }
    }
    
    /**
     * Authenticate with Infisical
     * @returns {Promise<void>}
     */
    async authenticate() {
        try {
            const clientConfig = {};
            if (this.config.auth?.siteURL) {
                clientConfig.siteURL = this.config.auth.siteURL;
            }
            
            if (this.config.auth?.token) {
                // Service Token authentication
                this.client = new InfisicalClient({
                    ...clientConfig,
                    accessToken: this.config.auth.token
                });
            } else if (this.config.auth?.universalAuthClientId && this.config.auth?.universalAuthClientSecret) {
                // Universal Auth
                this.client = new InfisicalClient({
                    ...clientConfig,
                    auth: {
                        universalAuth: {
                            clientId: this.config.auth.universalAuthClientId,
                            clientSecret: this.config.auth.universalAuthClientSecret
                        }
                    }
                });
            } else if (this.config.auth?.machineIdentityClientId) {
                // Machine Identity authentication
                this.client = new InfisicalClient({
                    ...clientConfig,
                    auth: {
                        machineIdentity: {
                            clientId: this.config.auth.machineIdentityClientId,
                            clientSecret: this.config.auth.machineIdentityClientSecret,
                            identityId: this.config.auth.machineIdentityIdentityId
                        }
                    }
                });
            } else {
                throw new Error('No valid authentication method provided');
            }
            
            this.isAuthenticated = true;
            
        } catch (error) {
            this.isAuthenticated = false;
            const message = error?.message || (typeof error === 'string' ? error : 'Unknown error');
            throw new Error(`Infisical authentication failed: ${message}`);
        }
    }
    
    /**
     * Fetch secrets from Infisical
     * @returns {Promise<Map<string, string>>}
     */
    async fetchSecrets() {
        if (!this.isAuthenticated || !this.client) {
            throw new Error('Not authenticated with Infisical');
        }
        
        try {
            const secrets = await this.client.listSecrets({
                projectId: this.config.projectId,
                environment: this._mapEnvironment(this.config.environment),
                path: this.config.path,
                includeSecrets: (this.config.includeSecrets && this.config.includeSecrets.length > 0) ? this.config.includeSecrets : undefined,
                excludeSecrets: (this.config.excludeSecrets && this.config.excludeSecrets.length > 0) ? this.config.excludeSecrets : undefined
            });
            
            this.lastFetchTime = new Date().toISOString();
            
            // Transform Infisical response to standard format
            // The SDK returns an array of secret objects
            const standardResponse = {
                secrets: secrets.map(secret => ({
                    key: secret.secretKey,
                    value: secret.secretValue,
                    version: secret.version,
                    createdAt: secret.createdAt,
                    updatedAt: secret.updatedAt
                }))
            };
            
            return this.parseSecrets(standardResponse);
            
        } catch (error) {
            const message = error?.message || (typeof error === 'string' ? error : 'Unknown error');
            throw new Error(`Failed to fetch secrets from Infisical: ${message}`);
        }
    }
    
    /**
     * Map environment names to Infisical environment format
     * @private
     * @param {string} environment 
     * @returns {string}
     */
    _mapEnvironment(environment) {
        const envMap = {
            'dev': 'dev',
            'development': 'dev',
            'stage': 'staging',
            'staging': 'staging',
            'pre': 'pre',
            'prod': 'prod',
            'production': 'prod'
        };
        
        return envMap[environment] || environment;
    }
    
    /**
     * Import secrets into process environment
     * @returns {void}
     */
    importSecretsToEnv() {
        if (!this.config.importSecrets) {
            return;
        }
        
        for (const [key, value] of this.currentSecrets) {
            // Don't override protected environment variables
            const protectedVars = [
                'NODE_ENV', 'INFISICAL_TOKEN', 'INFISICAL_PROJECT_ID',
                'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'
            ];
            
            if (!protectedVars.includes(key)) {
                process.env[key] = value;
            }
        }
    }
    
    /**
     * Create a new secret in Infisical
     * @param {string} key 
     * @param {string} value 
     * @param {Object} options 
     * @returns {Promise<void>}
     */
    async createSecret(key, value, options = {}) {
        if (!this.isAuthenticated || !this.client) {
            throw new Error('Not authenticated with Infisical');
        }
        
        try {
            await this.client.createSecret({
                projectId: this.config.projectId,
                environment: this._mapEnvironment(this.config.environment),
                path: this.config.path,
                secretKey: key,
                secretValue: value,
                ...options
            });
            
            // Refresh secrets after creation
            await this.refreshSecrets();
            
        } catch (error) {
            throw new Error(`Failed to create secret in Infisical: ${error.message}`);
        }
    }
    
    /**
     * Update an existing secret in Infisical
     * @param {string} key 
     * @param {string} value 
     * @param {Object} options 
     * @returns {Promise<void>}
     */
    async updateSecret(key, value, options = {}) {
        if (!this.isAuthenticated || !this.client) {
            throw new Error('Not authenticated with Infisical');
        }
        
        try {
            await this.client.updateSecret({
                projectId: this.config.projectId,
                environment: this._mapEnvironment(this.config.environment),
                path: this.config.path,
                secretKey: key,
                secretValue: value,
                ...options
            });
            
            // Refresh secrets after update
            await this.refreshSecrets();
            
        } catch (error) {
            throw new Error(`Failed to update secret in Infisical: ${error.message}`);
        }
    }
    
    /**
     * Delete a secret from Infisical
     * @param {string} key 
     * @returns {Promise<void>}
     */
    async deleteSecret(key) {
        if (!this.isAuthenticated || !this.client) {
            throw new Error('Not authenticated with Infisical');
        }
        
        try {
            await this.client.deleteSecret({
                projectId: this.config.projectId,
                environment: this._mapEnvironment(this.config.environment),
                path: this.config.path,
                secretKey: key
            });
            
            // Refresh secrets after deletion
            await this.refreshSecrets();
            
        } catch (error) {
            throw new Error(`Failed to delete secret from Infisical: ${error.message}`);
        }
    }
    
    /**
     * Get extended metadata including Infisical-specific information
     * @returns {Object}
     */
    getMetadata() {
        return {
            ...super.getMetadata(),
            projectId: this.config.projectId,
            environment: this._mapEnvironment(this.config.environment),
            path: this.config.path,
            isAuthenticated: this.isAuthenticated,
            includeSecrets: this.config.includeSecrets,
            excludeSecrets: this.config.excludeSecrets,
            authMethod: this.config.auth?.token ? 'service-token' : 'machine-identity',
            siteURL: this.config.auth?.siteURL
        };
    }
    
    /**
     * Cleanup with client disconnection
     * @returns {Promise<void>}
     */
    async cleanup() {
        this.isAuthenticated = false;
        this.client = null;
        await super.cleanup();
    }
}