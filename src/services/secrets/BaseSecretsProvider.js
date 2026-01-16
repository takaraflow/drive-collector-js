/**
 * Base Secrets Provider - Abstract foundation for secrets management
 * Provides EventEmitter capabilities, polling control, and common interface
 */

import { EventEmitter } from 'events';

/**
 * @typedef {Object} SecretChange
 * @property {string} key - Secret key name
 * @property {string|undefined} oldValue - Previous value (undefined for new secrets)
 * @property {string|undefined} newValue - New value (undefined for deleted secrets)
 * @property {'added'|'modified'|'deleted'} type - Type of change
 */

/**
 * @typedef {Object} SecretsProviderConfig
 * @property {number} [pollInterval=30000] - Polling interval in milliseconds
 * @property {number} [maxRetries=3] - Maximum retry attempts for failed operations
 * @property {number} [retryDelay=1000] - Base delay between retries (exponential backoff)
 * @property {boolean} [enablePolling=false] - Enable automatic polling
 * @property {string} [environment] - Target environment (dev, prod, pre)
 */

/**
 * Abstract base class for secrets providers
 */
export class BaseSecretsProvider extends EventEmitter {
    /**
     * @param {SecretsProviderConfig} config 
     */
    constructor(config = {}) {
        super();
        
        this.config = {
            pollInterval: 30000,
            maxRetries: 3,
            retryDelay: 1000,
            enablePolling: false,
            environment: process.env.NODE_ENV || 'dev',
            ...config
        };
        
        this.isPolling = false;
        this.pollTimer = null;
        this.lastKnownSecrets = new Map();
        this.currentSecrets = new Map();
        this.isInitialized = false;
        
        // Bind methods to maintain context
        this._onPollTick = this._onPollTick.bind(this);
        this._onError = this._onError.bind(this);
    }
    
    /**
     * Initialize the secrets provider
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }
        
        try {
            await this.authenticate();
            await this.fetchInitialSecrets();
            this.isInitialized = true;
            
            if (this.config.enablePolling) {
                this.startPolling();
            }
            
            this.emit('initialized', {
                provider: this.constructor.name,
                secretsCount: this.currentSecrets.size,
                environment: this.config.environment
            });
        } catch (error) {
            this._onError(error, 'initialization');
            throw error;
        }
    }
    
    /**
     * Abstract method: Authenticate with the secrets provider
     * @returns {Promise<void>}
     */
    async authenticate() {
        throw new Error('authenticate() must be implemented by subclass');
    }
    
    /**
     * Abstract method: Fetch secrets from the provider
     * @returns {Promise<Map<string, string>>}
     */
    async fetchSecrets() {
        throw new Error('fetchSecrets() must be implemented by subclass');
    }
    
    /**
     * Fetch initial secrets and populate internal state
     * @private
     * @returns {Promise<void>}
     */
    async fetchInitialSecrets() {
        const secrets = await this._withRetry(() => this.fetchSecrets());
        this._updateSecretsState(secrets);
        this.lastKnownSecrets = new Map(secrets);
    }
    
    /**
     * Start automatic polling for secret changes
     * @returns {void}
     */
    startPolling() {
        if (this.isPolling) {
            return;
        }
        
        this.isPolling = true;
        this._scheduleNextPoll();
        
        this.emit('pollingStarted', {
            interval: this.config.pollInterval,
            provider: this.constructor.name
        });
    }
    
    /**
     * Stop automatic polling
     * @returns {void}
     */
    stopPolling() {
        if (!this.isPolling) {
            return;
        }
        
        this.isPolling = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        
        this.emit('pollingStopped', {
            provider: this.constructor.name
        });
    }
    
    /**
     * Get current secret value
     * @param {string} key - Secret key
     * @returns {string|undefined}
     */
    getSecret(key) {
        return this.currentSecrets.get(key);
    }
    
    /**
     * Get all current secrets
     * @returns {Map<string, string>}
     */
    getAllSecrets() {
        return new Map(this.currentSecrets);
    }
    
    /**
     * Check if a secret exists
     * @param {string} key - Secret key
     * @returns {boolean}
     */
    hasSecret(key) {
        return this.currentSecrets.has(key);
    }
    
    /**
     * Force refresh secrets from provider
     * @returns {Promise<SecretChange[]>}
     */
    async refreshSecrets() {
        if (!this.isInitialized) {
            await this.initialize();
        }
        
        const secrets = await this._withRetry(() => this.fetchSecrets());
        const changes = this._detectChanges(this.lastKnownSecrets, secrets);
        
        if (changes.length > 0) {
            this._updateSecretsState(secrets);
            this.lastKnownSecrets = new Map(secrets);
            
            this.emit('configChanged', {
                changes,
                provider: this.constructor.name,
                timestamp: Date.now()
            });
        }
        
        return changes;
    }
    
    /**
     * Cleanup resources and stop polling
     * @returns {Promise<void>}
     */
    async cleanup() {
        this.stopPolling();
        this.currentSecrets.clear();
        this.lastKnownSecrets.clear();
        this.isInitialized = false;
        
        this.emit('cleanup', {
            provider: this.constructor.name
        });
        
        this.removeAllListeners();
    }
    
    /**
     * Schedule next poll
     * @private
     * @returns {void}
     */
    _scheduleNextPoll() {
        if (!this.isPolling) {
            return;
        }
        
        this.pollTimer = setTimeout(this._onPollTick, this.config.pollInterval);
    }
    
    /**
     * Handle polling tick
     * @private
     * @returns {void}
     */
    async _onPollTick() {
        if (!this.isPolling) {
            return;
        }
        
        try {
            await this.refreshSecrets();
        } catch (error) {
            this._onError(error, 'polling');
        } finally {
            this._scheduleNextPoll();
        }
    }
    
    /**
     * Update internal secrets state
     * @private
     * @param {Map<string, string>} secrets 
     * @returns {void}
     */
    _updateSecretsState(secrets) {
        this.currentSecrets = new Map(secrets);
    }
    
    /**
     * Detect changes between secret maps
     * @private
     * @param {Map<string, string>} oldSecrets 
     * @param {Map<string, string>} newSecrets 
     * @returns {SecretChange[]}
     */
    _detectChanges(oldSecrets, newSecrets) {
        const changes = [];
        const allKeys = new Set([...oldSecrets.keys(), ...newSecrets.keys()]);
        
        for (const key of allKeys) {
            const oldValue = oldSecrets.get(key);
            const newValue = newSecrets.get(key);
            
            if (oldValue === undefined && newValue !== undefined) {
                changes.push({ key, oldValue, newValue, type: 'added' });
            } else if (oldValue !== undefined && newValue === undefined) {
                changes.push({ key, oldValue, newValue, type: 'deleted' });
            } else if (oldValue !== undefined && newValue !== undefined && oldValue !== newValue) {
                changes.push({ key, oldValue, newValue, type: 'modified' });
            }
        }
        
        return changes;
    }
    
    /**
     * Execute operation with retry logic
     * @private
     * @param {Function} operation 
     * @returns {Promise<any>}
     */
    async _withRetry(operation) {
        let lastError;
        
        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                
                if (attempt === this.config.maxRetries) {
                    break;
                }
                
                const delay = this.config.retryDelay * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        throw lastError;
    }
    
    /**
     * Handle errors consistently
     * @private
     * @param {Error} error 
     * @param {string} context 
     * @returns {void}
     */
    _onError(error, context) {
        this.emit('error', {
            error: {
                message: error.message,
                stack: error.stack,
                code: error.code
            },
            context,
            provider: this.constructor.name,
            timestamp: Date.now()
        });
    }
}