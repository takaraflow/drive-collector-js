/**
 * Secrets Configuration Manager
 * Manifest-driven configuration management for services and secrets
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @typedef {Object} ServiceConfig
 * @property {string} name - Service display name
 * @property {string} description - Service description
 * @property {string} icon - Icon emoji
 * @property {string[]} configKeys - Configuration keys this service depends on
 * @property {string} reinitStrategy - Reinitialization strategy
 * @property {string} healthCheck - Health check method
 * @property {number} timeout - Timeout in milliseconds
 * @property {string[]} dependencies - Service dependencies
 */

/**
 * @typedef {Object} ManifestConfig
 * @property {Object} services - Service configurations
 * @property {Object} reinitStrategies - Reinitialization strategies
 * @property {Object} secretCategories - Secret categories
 * @property {Object} environments - Environment configurations
 * @property {Object} buildTime - Build-time configuration
 * @property {Object} runtime - Runtime configuration
 * @property {Object} validation - Validation rules
 * @property {Object} security - Security settings
 */

/**
 * Secrets Configuration Manager
 */
export class SecretsConfigManager {
    /**
     * @param {string} [manifestPath] - Path to secrets manifest file
     */
    constructor(manifestPath = null) {
        this.manifestPath = manifestPath || path.join(__dirname, 'secrets-manifest.json');
        this.manifest = null;
        this.serviceMap = new Map();
        this.secretToServiceMap = new Map();
        this.environmentConfig = null;
        
        this._loadManifest();
        this._buildServiceMappings();
    }
    
    /**
     * Load and parse the secrets manifest
     * @private
     * @returns {void}
     */
    _loadManifest() {
        try {
            const manifestContent = fs.readFileSync(this.manifestPath, 'utf8');
            this.manifest = JSON.parse(manifestContent);
        } catch (error) {
            throw new Error(`Failed to load secrets manifest: ${error.message}`);
        }
    }
    
    /**
     * Build service mappings for quick lookup
     * @private
     * @returns {void}
     */
    _buildServiceMappings() {
        // Build service map
        for (const [serviceId, serviceConfig] of Object.entries(this.manifest.services)) {
            this.serviceMap.set(serviceId, {
                id: serviceId,
                ...serviceConfig
            });
            
            // Build reverse mapping: secret key -> service
            for (const configKey of serviceConfig.configKeys) {
                if (!this.secretToServiceMap.has(configKey)) {
                    this.secretToServiceMap.set(configKey, []);
                }
                this.secretToServiceMap.get(configKey).push(serviceId);
            }
        }
    }
    
    /**
     * Get service configuration by ID
     * @param {string} serviceId 
     * @returns {ServiceConfig|null}
     */
    getService(serviceId) {
        return this.serviceMap.get(serviceId) || null;
    }
    
    /**
     * Get all service configurations
     * @returns {ServiceConfig[]}
     */
    getAllServices() {
        return Array.from(this.serviceMap.values());
    }
    
    /**
     * Get services that depend on a specific secret key
     * @param {string} secretKey 
     * @returns {string[]}
     */
    getServicesForSecret(secretKey) {
        return this.secretToServiceMap.get(secretKey) || [];
    }
    
    /**
     * Get services affected by secret changes
     * @param {Array<{key: string, type: string}>} changes 
     * @returns {string[]}
     */
    getAffectedServices(changes) {
        const affectedServices = new Set();
        
        for (const change of changes) {
            const services = this.getServicesForSecret(change.key);
            services.forEach(service => affectedServices.add(service));
        }
        
        // Include dependent services
        const allAffected = new Set(affectedServices);
        
        for (const serviceId of affectedServices) {
            const dependents = this.getServiceDependents(serviceId);
            dependents.forEach(dependent => allAffected.add(dependent));
        }
        
        return Array.from(allAffected);
    }
    
    /**
     * Get services that depend on a given service
     * @param {string} serviceId 
     * @returns {string[]}
     */
    getServiceDependents(serviceId) {
        const dependents = [];
        
        for (const [id, service] of this.serviceMap) {
            if (service.dependencies.includes(serviceId)) {
                dependents.push(id);
            }
        }
        
        return dependents;
    }
    
    /**
     * Get reinitialization strategy configuration
     * @param {string} strategyName 
     * @returns {Object|null}
     */
    getReinitStrategy(strategyName) {
        return this.manifest.reinitStrategies[strategyName] || null;
    }
    
    /**
     * Get environment-specific configuration
     * @param {string} environment 
     * @returns {Object|null}
     */
    getEnvironmentConfig(environment) {
        return this.manifest.environments[environment] || null;
    }
    
    /**
     * Get required secrets for an environment
     * @param {string} environment 
     * @returns {string[]}
     */
    getRequiredSecrets(environment) {
        const envConfig = this.getEnvironmentConfig(environment);
        const manifestRequired = envConfig?.requiredSecrets || [];
        const validationRequired = this.manifest.validation?.requiredForEnv?.[environment] || [];
        
        return [...new Set([...manifestRequired, ...validationRequired])];
    }
    
    /**
     * Get environment overrides
     * @param {string} environment 
     * @returns {Object}
     */
    getEnvironmentOverrides(environment) {
        const envConfig = this.getEnvironmentConfig(environment);
        return envConfig?.overrides || {};
    }
    
    /**
     * Validate secret key format
     * @param {string} key 
     * @returns {boolean}
     */
    validateSecretKey(key) {
        const rules = this.manifest.validation?.secretKeys;
        if (!rules) return true;
        
        // Pattern validation
        if (rules.pattern && !new RegExp(rules.pattern).test(key)) {
            return false;
        }
        
        // Length validation
        if (rules.minLength && key.length < rules.minLength) {
            return false;
        }
        
        if (rules.maxLength && key.length > rules.maxLength) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Validate secret value format
     * @param {string} value 
     * @returns {boolean}
     */
    validateSecretValue(value) {
        const rules = this.manifest.validation?.secretValues;
        if (!rules) return true;
        
        // Empty value validation
        if (!rules.allowEmpty && (!value || value.trim() === '')) {
            return false;
        }
        
        // Length validation
        if (rules.maxLength && value.length > rules.maxLength) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Check if a secret key is protected from override
     * @param {string} key 
     * @returns {boolean}
     */
    isProtectedKey(key) {
        const protection = this.manifest.security?.protection?.preventOverride || [];
        return protection.includes(key);
    }
    
    /**
     * Mask sensitive information in logs
     * @param {string} key 
     * @param {string} value 
     * @returns {string}
     */
    maskSecret(key, value) {
        if (!value) return value;
        
        const masking = this.manifest.security?.masking;
        if (!masking) return value;
        
        // Check if key matches any masking pattern
        const shouldMask = masking.patterns.some(pattern => 
            new RegExp(pattern).test(key)
        );
        
        if (!shouldMask) return value;
        
        const maskChar = masking.maskChar || '*';
        const showLast = masking.showLast || 4;
        
        if (value.length <= showLast) {
            return maskChar.repeat(value.length);
        }
        
        const visiblePart = value.slice(-showLast);
        const maskedPart = maskChar.repeat(value.length - showLast);
        return maskedPart + visiblePart;
    }
    
    /**
     * Get build-time configuration
     * @returns {Object}
     */
    getBuildTimeConfig() {
        return this.manifest.buildTime || {};
    }
    
    /**
     * Get runtime configuration
     * @returns {Object}
     */
    getRuntimeConfig() {
        return this.manifest.runtime || {};
    }
    
    /**
     * Get notification configuration
     * @returns {Object}
     */
    getNotificationsConfig() {
        return this.manifest.notifications || {};
    }
    
    /**
     * Get secret category information
     * @param {string} category 
     * @returns {Object|null}
     */
    getSecretCategory(category) {
        return this.manifest.secretCategories?.[category] || null;
    }
    
    /**
     * Get all secret categories
     * @returns {Object}
     */
    getAllSecretCategories() {
        return this.manifest.secretCategories || {};
    }
    
    /**
     * Order services for reinitialization based on dependencies
     * @param {string[]} serviceIds 
     * @returns {string[]}
     */
    orderServicesForReinit(serviceIds) {
        const ordered = [];
        const visited = new Set();
        const visiting = new Set();
        
        const visit = (serviceId) => {
            if (visiting.has(serviceId)) {
                throw new Error(`Circular dependency detected involving ${serviceId}`);
            }
            
            if (visited.has(serviceId)) {
                return;
            }
            
            const service = this.getService(serviceId);
            if (!service) return;
            
            visiting.add(serviceId);
            
            // Visit dependencies first
            for (const depId of service.dependencies) {
                if (serviceIds.includes(depId)) {
                    visit(depId);
                }
            }
            
            visiting.delete(serviceId);
            visited.add(serviceId);
            ordered.push(serviceId);
        };
        
        for (const serviceId of serviceIds) {
            visit(serviceId);
        }
        
        return ordered;
    }
    
    /**
     * Get manifest metadata
     * @returns {Object}
     */
    getManifestMetadata() {
        return {
            version: this.manifest.version,
            name: this.manifest.name,
            description: this.manifest.description,
            manifestVersion: this.manifest.manifest_version,
            serviceCount: this.serviceMap.size,
            lastLoaded: new Date().toISOString()
        };
    }
    
    /**
     * Validate complete configuration against environment
     * @param {string} environment 
     * @param {Map<string, string>} secrets 
     * @returns {Object}
     */
    validateConfiguration(environment, secrets) {
        const errors = [];
        const warnings = [];
        const requiredSecrets = this.getRequiredSecrets(environment);
        
        // Check required secrets
        for (const secretKey of requiredSecrets) {
            if (!secrets.has(secretKey)) {
                errors.push(`Required secret '${secretKey}' is missing for environment '${environment}'`);
            }
        }
        
        // Validate secret formats
        for (const [key, value] of secrets) {
            if (!this.validateSecretKey(key)) {
                errors.push(`Secret key '${key}' does not match validation pattern`);
            }
            
            if (!this.validateSecretValue(value)) {
                warnings.push(`Secret value for '${key}' may be invalid`);
            }
        }
        
        return {
            valid: errors.length === 0,
            errors,
            warnings,
            requiredSecrets,
            providedSecrets: Array.from(secrets.keys())
        };
    }
}