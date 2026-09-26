/**
 * Secrets Orchestrator
 * Build-time secret injection and wrangler integration orchestration
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { InfisicalSecretsProvider } from '../services/secrets/InfisicalSecretsProvider.js';
import { DopplerSecretsProvider } from '../services/secrets/DopplerSecretsProvider.js';
import { SecretsConfigManager } from './SecretsConfigManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');

/**
 * @typedef {Object} OrchestratorConfig
 * @property {string} environment - Target environment (dev, pre, prod)
 * @property {string} [provider='infisical'] - Secrets provider to use
 * @property {Object} providerConfig - Provider-specific configuration
 * @property {boolean} [validate=true] - Validate secrets before injection
 * @property {boolean} [dryRun=false] - Dry run mode (don't actually inject)
 * @property {string} [outputDir=projectRoot] - Output directory for generated files
 * @property {boolean} [cleanup=true] - Cleanup temporary files after build
 */

/**
 * @typedef {Object} InjectionResult
 * @property {boolean} success - Whether injection was successful
 * @property {Map<string, string>} secrets - Injected secrets
 * @property {string[]} generatedFiles - List of generated files
 * @property {Object} validation - Validation results
 * @property {string} duration - Injection duration
 * @property {string|null} error - Error message if failed
 */

/**
 * Secrets Orchestrator for build-time injection
 */
export class SecretsOrchestrator {
    /**
     * @param {OrchestratorConfig} config 
     */
    constructor(config = {}) {
        this.config = {
            environment: process.env.NODE_ENV || process.env.DEPLOY_ENV || 'dev',
            provider: config.provider || process.env.SECRETS_PROVIDER || 'infisical',
            validate: true,
            dryRun: false,
            outputDir: projectRoot,
            cleanup: true,
            ...config
        };
        
        this.provider = null;
        this.configManager = new SecretsConfigManager();
        this.generatedFiles = [];
        this.startTime = null;
        
        this._initializeProvider();
    }
    
    /**
     * Initialize secrets provider
     * @private
     * @returns {void}
     */
    _initializeProvider() {
        switch (this.config.provider) {
            case 'infisical':
                this.provider = new InfisicalSecretsProvider({
                    projectId: this.config.providerConfig?.projectId || process.env.INFISICAL_PROJECT_ID,
                    environment: this.config.environment,
                    auth: {
                        token: this.config.providerConfig?.token || process.env.INFISICAL_TOKEN,
                        siteURL: this.config.providerConfig?.siteURL
                    },
                    includeSecrets: this.config.providerConfig?.includeSecrets,
                    excludeSecrets: this.config.providerConfig?.excludeSecrets
                });
                break;
            
            case 'doppler':
                this.provider = new DopplerSecretsProvider({
                    project: this.config.providerConfig?.project || process.env.DOPPLER_PROJECT,
                    config: this.config.environment, // Maps to environment
                    environment: this.config.environment,
                    auth: {
                        serviceToken: this.config.providerConfig?.serviceToken || process.env.DOPPLER_TOKEN,
                        apiToken: this.config.providerConfig?.apiToken || process.env.DOPPLER_API_TOKEN,
                        serviceAccountToken: this.config.providerConfig?.serviceAccountToken || process.env.DOPPLER_SERVICE_ACCOUNT_TOKEN,
                        apiKey: this.config.providerConfig?.apiKey || process.env.DOPPLER_API_KEY,
                        apiHost: this.config.providerConfig?.apiHost
                    },
                    includeSecrets: this.config.providerConfig?.includeSecrets,
                    excludeSecrets: this.config.providerConfig?.excludeSecrets
                });
                break;
            
            default:
                throw new Error(`Unsupported secrets provider: ${this.config.provider}`);
        }
    }
    
    /**
     * Execute the complete secrets injection workflow
     * @returns {Promise<InjectionResult>}
     */
    async executeInjection() {
        this.startTime = Date.now();
        
        try {
            console.log(`🚀 Starting secrets injection for environment: ${this.config.environment}`);
            
            // 1. Initialize provider
            await this.provider.initialize();
            console.log(`✅ Initialized ${this.config.provider} provider`);
            
            // 2. Fetch secrets
            console.log('📥 Fetching secrets...');
            const secrets = await this.provider.getAllSecrets();
            console.log(`✅ Fetched ${secrets.size} secrets`);
            
            // 3. Apply environment overrides
            const overrides = this.configManager.getEnvironmentOverrides(this.config.environment);
            this._applyOverrides(secrets, overrides);
            
            // 4. Validate configuration
            let validation = null;
            if (this.config.validate) {
                console.log('🔍 Validating configuration...');
                validation = this.configManager.validateConfiguration(this.config.environment, secrets);
                
                if (!validation.valid) {
                    console.error('❌ Configuration validation failed:');
                    validation.errors.forEach(error => console.error(`  - ${error}`));
                    throw new Error('Configuration validation failed');
                }
                
                if (validation.warnings.length > 0) {
                    console.warn('⚠️ Configuration warnings:');
                    validation.warnings.forEach(warning => console.warn(`  - ${warning}`));
                }
                console.log('✅ Configuration validation passed');
            }
            
            // 5. Generate output files
            if (!this.config.dryRun) {
                console.log('📝 Generating output files...');
                await this._generateOutputFiles(secrets);
                console.log(`✅ Generated ${this.generatedFiles.length} output files`);
            } else {
                console.log('🔍 Dry run mode - skipping file generation');
            }
            
            const duration = `${Date.now() - this.startTime}ms`;
            
            const result = {
                success: true,
                secrets,
                generatedFiles: [...this.generatedFiles],
                validation,
                duration,
                error: null
            };
            
            console.log(`🎉 Secrets injection completed successfully in ${duration}`);
            return result;
            
        } catch (error) {
            const duration = `${Date.now() - this.startTime}ms`;
            
            const result = {
                success: false,
                secrets: new Map(),
                generatedFiles: [...this.generatedFiles],
                validation: null,
                duration,
                error: error.message
            };
            
            console.error(`❌ Secrets injection failed after ${duration}: ${error.message}`);
            return result;
        } finally {
            // Cleanup temporary files
            if (this.config.cleanup && !this.config.dryRun) {
                await this._cleanup();
            }
        }
    }
    
    /**
     * Apply environment overrides to secrets
     * @private
     * @param {Map<string, string>} secrets 
     * @param {Object} overrides 
     * @returns {void}
     */
    _applyOverrides(secrets, overrides) {
        for (const [key, value] of Object.entries(overrides)) {
            if (!this.configManager.isProtectedKey(key)) {
                secrets.set(key, String(value));
                console.log(`🔧 Applied override: ${key}`);
            } else {
                console.warn(`⚠️ Skipping protected key override: ${key}`);
            }
        }
    }
    
    /**
     * Generate output files for wrangler integration
     * @private
     * @param {Map<string, string>} secrets 
     * @returns {Promise<void>}
     */
    async _generateOutputFiles(secrets) {
        const buildConfig = this.configManager.getBuildTimeConfig();
        const targetFiles = buildConfig.targetFiles || ['secrets.json', '.env.build'];
        
        // Generate secrets.json for wrangler bulk upload
        if (targetFiles.includes('secrets.json')) {
            await this._generateSecretsJson(secrets);
        }
        
        // Generate .env.build for local development
        if (targetFiles.includes('.env.build')) {
            await this._generateEnvFile(secrets);
        }
        
        // Generate wrangler.toml secrets section if needed
        if (buildConfig.includeWranglerToml) {
            await this._generateWranglerTomlSecrets(secrets);
        }
        
        // Generate metadata file
        if (buildConfig.generateMetadata) {
            await this._generateMetadata(secrets);
        }
    }
    
    /**
     * Generate secrets.json for wrangler bulk upload
     * @private
     * @param {Map<string, string>} secrets 
     * @returns {Promise<void>}
     */
    async _generateSecretsJson(secrets) {
        const filePath = path.join(this.config.outputDir, 'secrets.json');
        const secretsObj = {};
        
        // Filter out infrastructure variables that shouldn't be secrets
        const blacklist = ['NODE_ENV', 'INFISICAL_TOKEN', 'INFISICAL_PROJECT_ID'];
        
        for (const [key, value] of secrets) {
            if (!blacklist.includes(key) && !this.configManager.isProtectedKey(key)) {
                secretsObj[key] = value;
            }
        }
        
        fs.writeFileSync(filePath, JSON.stringify(secretsObj, null, 2));
        this.generatedFiles.push(filePath);
        console.log(`📄 Generated secrets.json with ${Object.keys(secretsObj).length} secrets`);
    }
    
    /**
     * Generate .env.build file for local development
     * @private
     * @param {Map<string, string>} secrets 
     * @returns {Promise<void>}
     */
    async _generateEnvFile(secrets) {
        const filePath = path.join(this.config.outputDir, '.env.build');
        const lines = [];
        
        lines.push(`# Generated secrets for environment: ${this.config.environment}`);
        lines.push(`# Generated at: ${new Date().toISOString()}`);
        lines.push('');
        
        for (const [key, value] of secrets) {
            const maskedValue = this.configManager.maskSecret(key, value);
            lines.push(`${key}="${maskedValue}"`);
        }
        
        fs.writeFileSync(filePath, lines.join('\n'));
        this.generatedFiles.push(filePath);
        console.log(`📄 Generated .env.build with ${secrets.size} variables`);
    }
    
    /**
     * Generate wrangler.toml secrets section
     * @private
     * @param {Map<string, string>} secrets 
     * @returns {Promise<void>}
     */
    async _generateWranglerTomlSecrets(secrets) {
        const filePath = path.join(this.config.outputDir, 'wrangler.secrets.toml');
        const lines = [];
        
        lines.push('[secrets]');
        lines.push('# Secrets for Cloudflare Workers');
        lines.push(`# Environment: ${this.config.environment}`);
        lines.push(`# Generated: ${new Date().toISOString()}`);
        lines.push('');
        
        for (const [key, value] of secrets) {
            const maskedValue = this.configManager.maskSecret(key, value);
            lines.push(`${key} = "${maskedValue}"`);
        }
        
        fs.writeFileSync(filePath, lines.join('\n'));
        this.generatedFiles.push(filePath);
        console.log(`📄 Generated wrangler.secrets.toml`);
    }
    
    /**
     * Generate metadata file with injection information
     * @private
     * @param {Map<string, string>} secrets 
     * @returns {Promise<void>}
     */
    async _generateMetadata(secrets) {
        const filePath = path.join(this.config.outputDir, 'secrets-metadata.json');
        const metadata = {
            environment: this.config.environment,
            provider: this.config.provider,
            timestamp: new Date().toISOString(),
            secretsCount: secrets.size,
            secretKeys: Array.from(secrets.keys()),
            generatedFiles: this.generatedFiles,
            manifest: this.configManager.getManifestMetadata(),
            providerMetadata: this.provider.getMetadata()
        };
        
        fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2));
        this.generatedFiles.push(filePath);
        console.log(`📄 Generated secrets-metadata.json`);
    }
    
    /**
     * Cleanup temporary files
     * @private
     * @returns {Promise<void>}
     */
    async _cleanup() {
        const buildConfig = this.configManager.getBuildTimeConfig();
        
        if (!buildConfig.cleanupAfterBuild) {
            return;
        }
        
        // Keep certain files, remove others
        const keepFiles = ['secrets-metadata.json'];
        const filesToCleanup = this.generatedFiles.filter(file => 
            !keepFiles.some(keep => path.basename(file) === keep)
        );
        
        for (const file of filesToCleanup) {
            try {
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file);
                    console.log(`🗑️ Cleaned up: ${path.basename(file)}`);
                }
            } catch (error) {
                console.warn(`⚠️ Failed to cleanup ${file}: ${error.message}`);
            }
        }
    }
    
    /**
     * Get injection status and metadata
     * @returns {Object}
     */
    getStatus() {
        return {
            provider: this.config.provider,
            environment: this.config.environment,
            isInitialized: this.provider?.isInitialized || false,
            generatedFiles: [...this.generatedFiles],
            config: {
                validate: this.config.validate,
                dryRun: this.config.dryRun,
                cleanup: this.config.cleanup
            },
            providerMetadata: this.provider?.getMetadata() || null
        };
    }
    
    /**
     * Cleanup provider resources
     * @returns {Promise<void>}
     */
    async cleanup() {
        if (this.provider) {
            await this.provider.cleanup();
        }
        this.generatedFiles = [];
    }
}