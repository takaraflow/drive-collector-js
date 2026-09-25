/**
 * Cloud Secrets Provider - Generic cloud implementation
 * Implements change detection, hashing, response validation, and generic cloud provider logic
 */

import { BaseSecretsProvider } from './BaseSecretsProvider.js';
import { createHash } from 'crypto';

/**
 * @typedef {Object} CloudSecretsConfig
 * @property {string} [environment] - Target environment
 * @property {string} [projectId] - Project identifier
 * @property {string} [workspaceId] - Workspace identifier
 * @property {boolean} [enableHashing=true] - Enable SHA256 hashing for change detection
 * @property {string[]} [includePatterns] - Include patterns for secret keys (regex)
 * @property {string[]} [excludePatterns] - Exclude patterns for secret keys (regex)
 */

/**
 * Generic cloud secrets provider with common functionality
 */
export class CloudSecretsProvider extends BaseSecretsProvider {
    /**
     * @param {CloudSecretsConfig} config 
     */
    constructor(config = {}) {
        super({
            enableHashing: true,
            includePatterns: [],
            excludePatterns: [],
            ...config
        });
        
        this.secretHashes = new Map();
        this.lastFetchTime = null;
    }
    
    /**
     * Validate response format from cloud provider
     * @protected
     * @param {any} response 
     * @returns {boolean}
     */
    validateResponse(response) {
        if (!response || typeof response !== 'object') {
            return false;
        }
        
        // Should have either secrets array or object
        const hasSecretsArray = Array.isArray(response.secrets);
        const hasSecretsObject = typeof response.secrets === 'object' && response.secrets !== null;
        
        return hasSecretsArray || hasSecretsObject;
    }
    
    /**
     * Parse secrets from provider-specific format to standardized Map
     * @protected
     * @param {any} response 
     * @returns {Map<string, string>}
     */
    parseSecrets(response) {
        const secrets = new Map();
        
        if (!this.validateResponse(response)) {
            throw new Error('Invalid response format from secrets provider');
        }
        
        let rawSecrets;
        if (Array.isArray(response.secrets)) {
            // Array format: [{ key: 'name', value: 'secret' }, ...]
            rawSecrets = response.secrets.reduce((acc, secret) => {
                if (secret.key && secret.value !== undefined) {
                    acc[secret.key] = String(secret.value);
                }
                return acc;
            }, {});
        } else if (typeof response.secrets === 'object') {
            // Object format: { key1: 'value1', key2: 'value2' }
            rawSecrets = response.secrets;
        } else {
            throw new Error('Unsupported secrets format');
        }
        
        // Apply filters and convert to Map
        for (const [key, value] of Object.entries(rawSecrets)) {
            if (this._shouldIncludeSecret(key)) {
                secrets.set(key, String(value));
            }
        }
        
        return secrets;
    }
    
    /**
     * Generate SHA256 hash for secret value
     * @protected
     * @param {string} value 
     * @returns {string}
     */
    generateHash(value) {
        if (!this.config.enableHashing) {
            return value;
        }
        
        return createHash('sha256').update(value).digest('hex');
    }
    
    /**
     * Check if secret should be included based on patterns
     * @private
     * @param {string} key 
     * @returns {boolean}
     */
    _shouldIncludeSecret(key) {
        // Check exclude patterns first
        for (const pattern of this.config.excludePatterns) {
            if (new RegExp(pattern).test(key)) {
                return false;
            }
        }
        
        // If include patterns are specified, key must match one
        if (this.config.includePatterns.length > 0) {
            for (const pattern of this.config.includePatterns) {
                if (new RegExp(pattern).test(key)) {
                    return true;
                }
            }
            return false;
        }
        
        return true;
    }
    
    /**
     * Detect changes using hashing for efficient comparison
     * @protected
     * @param {Map<string, string>} oldSecrets 
     * @param {Map<string, string>} newSecrets 
     * @returns {Array}
     */
    detectChangesWithHashing(oldSecrets, newSecrets) {
        const changes = [];
        const allKeys = new Set([...oldSecrets.keys(), ...newSecrets.keys()]);
        
        for (const key of allKeys) {
            const oldValue = oldSecrets.get(key);
            const newValue = newSecrets.get(key);
            const oldHash = this.secretHashes.get(key);
            
            if (oldValue === undefined && newValue !== undefined) {
                // Added
                const newHash = this.generateHash(newValue);
                this.secretHashes.set(key, newHash);
                changes.push({ key, oldValue, newValue, type: 'added' });
            } else if (oldValue !== undefined && newValue === undefined) {
                // Deleted
                this.secretHashes.delete(key);
                changes.push({ key, oldValue, newValue, type: 'deleted' });
            } else if (oldValue !== undefined && newValue !== undefined) {
                // Check if modified
                const newHash = this.generateHash(newValue);
                if (oldHash !== newHash) {
                    this.secretHashes.set(key, newHash);
                    changes.push({ key, oldValue, newValue, type: 'modified' });
                }
            }
        }
        
        return changes;
    }
    
    /**
     * Override changes detection to use hashing
     * @protected
     * @param {Map<string, string>} oldSecrets 
     * @param {Map<string, string>} newSecrets 
     * @returns {Array}
     */
    _detectChanges(oldSecrets, newSecrets) {
        if (this.config.enableHashing) {
            return this.detectChangesWithHashing(oldSecrets, newSecrets);
        }
        return super._detectChanges(oldSecrets, newSecrets);
    }
    
    /**
     * Update secrets state with hash tracking
     * @private
     * @param {Map<string, string>} secrets 
     * @returns {void}
     */
    _updateSecretsState(secrets) {
        super._updateSecretsState(secrets);
        
        // Update hashes for all secrets
        for (const [key, value] of secrets) {
            this.secretHashes.set(key, this.generateHash(value));
        }
        
        // Remove hashes for secrets that no longer exist
        const currentKeys = new Set(secrets.keys());
        for (const key of this.secretHashes.keys()) {
            if (!currentKeys.has(key)) {
                this.secretHashes.delete(key);
            }
        }
    }
    
    /**
     * Get secrets metadata
     * @returns {Object}
     */
    getMetadata() {
        return {
            provider: this.constructor.name,
            environment: this.config.environment,
            secretsCount: this.currentSecrets.size,
            lastFetchTime: this.lastFetchTime,
            isPolling: this.isPolling,
            isInitialized: this.isInitialized,
            hashEnabled: this.config.enableHashing,
            includePatterns: this.config.includePatterns,
            excludePatterns: this.config.excludePatterns
        };
    }
    
    /**
     * Export secrets for backup/debugging
     * @param {boolean} includeValues=false 
     * @returns {Object}
     */
    exportSecrets(includeValues = false) {
        const exportData = {
            metadata: this.getMetadata(),
            secrets: {}
        };
        
        for (const [key, value] of this.currentSecrets) {
            exportData.secrets[key] = includeValues ? value : this.secretHashes.get(key);
        }
        
        return exportData;
    }
    
    /**
     * Cleanup with hash state clearing
     * @returns {Promise<void>}
     */
    async cleanup() {
        this.secretHashes.clear();
        this.lastFetchTime = null;
        await super.cleanup();
    }
}