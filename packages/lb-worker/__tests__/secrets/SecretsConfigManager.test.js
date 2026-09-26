/**
 * Tests for SecretsConfigManager
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SecretsConfigManager } from '../../src/config/SecretsConfigManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('SecretsConfigManager', () => {
    let configManager;
    let tempManifestPath;
    
    beforeEach(() => {
        // Create a temporary manifest file for testing
        const randomId = Math.random().toString(36).substring(7);
        tempManifestPath = path.join(__dirname, `temp-secrets-manifest-${randomId}.json`);
        
        const testManifest = {
            manifest_version: "1.0",
            name: "Test Secrets Manifest",
            version: "1.0.0",
            services: {
                "cache": {
                    name: "Cache Service",
                    description: "Test cache service",
                    icon: "🗄️",
                    configKeys: ["REDIS_URL", "REDIS_TOKEN"],
                    reinitStrategy: "reconnect",
                    healthCheck: "ping",
                    timeout: 5000,
                    dependencies: []
                },
                "auth": {
                    name: "Auth Service",
                    description: "Test authentication service",
                    icon: "🔐",
                    configKeys: ["API_KEY", "SECRET_KEY"],
                    reinitStrategy: "restart",
                    healthCheck: "verify",
                    timeout: 3000,
                    dependencies: ["cache"]
                }
            },
            reinitStrategies: {
                "reconnect": {
                    description: "Reestablish connections",
                    steps: ["disconnect", "connect"],
                    gracefulShutdown: true
                },
                "restart": {
                    description: "Full service restart",
                    steps: ["stop", "start"],
                    gracefulShutdown: true
                }
            },
            environments: {
                "dev": {
                    description: "Development",
                    overrides: {
                        "DEBUG": "true"
                    },
                    requiredSecrets: ["REDIS_URL"]
                },
                "prod": {
                    description: "Production",
                    overrides: {
                        "DEBUG": "false"
                    },
                    requiredSecrets: ["REDIS_URL", "API_KEY", "SECRET_KEY"]
                }
            },
            validation: {
                secretKeys: {
                    pattern: "^[A-Z][A-Z0-9_]*$",
                    maxLength: 50,
                    minLength: 3
                },
                secretValues: {
                    maxLength: 1000,
                    allowEmpty: false
                },
                requiredForEnv: {
                    "prod": ["API_KEY"],
                    "dev": []
                }
            },
            security: {
                protection: {
                    preventOverride: ["NODE_ENV", "INFISICAL_TOKEN"]
                },
                masking: {
                    patterns: [".*KEY.*", ".*SECRET.*"],
                    maskChar: "*",
                    showLast: 4
                }
            }
        };
        
        fs.writeFileSync(tempManifestPath, JSON.stringify(testManifest, null, 2));
        
        configManager = new SecretsConfigManager(tempManifestPath);
    });
    
    afterEach(() => {
        // Clean up temporary manifest file
        if (fs.existsSync(tempManifestPath)) {
            fs.unlinkSync(tempManifestPath);
        }
    });
    
    describe('service management', () => {
        it('should get service configuration by ID', () => {
            const service = configManager.getService('cache');
            
            expect(service).toBeTruthy();
            expect(service.id).toBe('cache');
            expect(service.name).toBe('Cache Service');
            expect(service.configKeys).toEqual(['REDIS_URL', 'REDIS_TOKEN']);
            expect(service.reinitStrategy).toBe('reconnect');
        });
        
        it('should return null for non-existent service', () => {
            const service = configManager.getService('nonexistent');
            expect(service).toBeNull();
        });
        
        it('should get all services', () => {
            const services = configManager.getAllServices();
            
            expect(services).toHaveLength(2);
            expect(services.map(s => s.id)).toEqual(['cache', 'auth']);
        });
        
        it('should get services for a specific secret', () => {
            const services = configManager.getServicesForSecret('REDIS_URL');
            expect(services).toEqual(['cache']);
            
            const apiServices = configManager.getServicesForSecret('API_KEY');
            expect(apiServices).toEqual(['auth']);
            
            const noServices = configManager.getServicesForSecret('NONEXISTENT');
            expect(noServices).toEqual([]);
        });
        
        it('should get affected services for secret changes', () => {
            const changes = [
                { key: 'REDIS_URL', type: 'modified' },
                { key: 'API_KEY', type: 'added' }
            ];
            
            const affected = configManager.getAffectedServices(changes);
            
            // Should include direct dependencies and their dependents
            expect(affected).toContain('cache');
            expect(affected).toContain('auth');
        });
        
        it('should order services for reinitialization based on dependencies', () => {
            const serviceIds = ['auth', 'cache']; // auth depends on cache
            const ordered = configManager.orderServicesForReinit(serviceIds);
            
            // cache should come before auth due to dependency
            expect(ordered.indexOf('cache')).toBeLessThan(ordered.indexOf('auth'));
        });
        
        it('should detect circular dependencies', () => {
            // Create circular dependency in the manifest
            const manifest = JSON.parse(fs.readFileSync(tempManifestPath, 'utf8'));
            manifest.services.cache.dependencies = ['auth'];
            manifest.services.auth.dependencies = ['cache'];
            fs.writeFileSync(tempManifestPath, JSON.stringify(manifest, null, 2));
            
            configManager = new SecretsConfigManager(tempManifestPath);
            
            expect(() => {
                configManager.orderServicesForReinit(['cache', 'auth']);
            }).toThrow('Circular dependency detected');
        });
    });
    
    describe('reinitialization strategies', () => {
        it('should get reinitialization strategy by name', () => {
            const strategy = configManager.getReinitStrategy('reconnect');
            
            expect(strategy).toBeTruthy();
            expect(strategy.description).toBe('Reestablish connections');
            expect(strategy.steps).toEqual(['disconnect', 'connect']);
        });
        
        it('should return null for non-existent strategy', () => {
            const strategy = configManager.getReinitStrategy('nonexistent');
            expect(strategy).toBeNull();
        });
    });
    
    describe('environment management', () => {
        it('should get environment configuration', () => {
            const envConfig = configManager.getEnvironmentConfig('dev');
            
            expect(envConfig).toBeTruthy();
            expect(envConfig.description).toBe('Development');
            expect(envConfig.overrides).toEqual({ DEBUG: 'true' });
            expect(envConfig.requiredSecrets).toEqual(['REDIS_URL']);
        });
        
        it('should get required secrets for environment', () => {
            const devSecrets = configManager.getRequiredSecrets('dev');
            expect(devSecrets).toContain('REDIS_URL');
            
            const prodSecrets = configManager.getRequiredSecrets('prod');
            expect(prodSecrets).toContain('REDIS_URL');
            expect(prodSecrets).toContain('API_KEY');
            expect(prodSecrets).toContain('SECRET_KEY');
            expect(prodSecrets).toContain('API_KEY'); // from validation.requiredForEnv
        });
        
        it('should get environment overrides', () => {
            const devOverrides = configManager.getEnvironmentOverrides('dev');
            expect(devOverrides).toEqual({ DEBUG: 'true' });
            
            const prodOverrides = configManager.getEnvironmentOverrides('prod');
            expect(prodOverrides).toEqual({ DEBUG: 'false' });
        });
        
        it('should return empty object for non-existent environment', () => {
            const envConfig = configManager.getEnvironmentConfig('nonexistent');
            expect(envConfig).toBeNull();
            
            const overrides = configManager.getEnvironmentOverrides('nonexistent');
            expect(overrides).toEqual({});
        });
    });
    
    describe('validation', () => {
        it('should validate secret key format', () => {
            expect(configManager.validateSecretKey('VALID_KEY')).toBe(true);
            expect(configManager.validateSecretKey('ANOTHER_VALID_KEY_123')).toBe(true);
            expect(configManager.validateSecretKey('invalid-key')).toBe(false); // lowercase
            expect(configManager.validateSecretKey('AB')).toBe(false); // too short
            expect(configManager.validateSecretKey('A'.repeat(51))).toBe(false); // too long
        });
        
        it('should validate secret value format', () => {
            expect(configManager.validateSecretValue('valid_value')).toBe(true);
            expect(configManager.validateSecretValue('')).toBe(false); // empty not allowed
            expect(configManager.validateSecretValue('   ')).toBe(false); // whitespace only
            expect(configManager.validateSecretValue('A'.repeat(1001))).toBe(false); // too long
        });
        
        it('should validate complete configuration', () => {
            const secrets = new Map([
                ['REDIS_URL', 'redis://localhost:6379'],
                ['API_KEY', 'test-api-key'],
                ['SECRET_KEY', 'test-secret-key']
            ]);
            
            const validation = configManager.validateConfiguration('prod', secrets);
            
            expect(validation.valid).toBe(true);
            expect(validation.errors).toHaveLength(0);
            expect(validation.requiredSecrets.length).toBeGreaterThan(0);
        });
        
        it('should report missing required secrets', () => {
            const secrets = new Map([
                ['REDIS_URL', 'redis://localhost:6379']
                // Missing API_KEY and SECRET_KEY
            ]);
            
            const validation = configManager.validateConfiguration('prod', secrets);
            
            expect(validation.valid).toBe(false);
            expect(validation.errors.length).toBeGreaterThan(0);
            expect(validation.errors.some(e => e.includes('API_KEY'))).toBe(true);
            expect(validation.errors.some(e => e.includes('SECRET_KEY'))).toBe(true);
        });
    });
    
    describe('security', () => {
        it('should identify protected keys', () => {
            expect(configManager.isProtectedKey('NODE_ENV')).toBe(true);
            expect(configManager.isProtectedKey('INFISICAL_TOKEN')).toBe(true);
            expect(configManager.isProtectedKey('API_KEY')).toBe(false);
        });
        
        it('should mask sensitive information', () => {
            expect(configManager.maskSecret('API_KEY', '12345678')).toBe('****5678');
            expect(configManager.maskSecret('SECRET_KEY', 'abcdef')).toBe('**cdef');
            expect(configManager.maskSecret('NORMAL_VAR', 'normal_value')).toBe('normal_value');
            expect(configManager.maskSecret('API_KEY', '123')).toBe('***'); // shorter than showLast
        });
    });
    
    describe('metadata', () => {
        it('should return manifest metadata', () => {
            const metadata = configManager.getManifestMetadata();
            
            expect(metadata.name).toBe('Test Secrets Manifest');
            expect(metadata.version).toBe('1.0.0');
            expect(metadata.serviceCount).toBe(2);
            expect(metadata.lastLoaded).toBeDefined();
        });
    });
    
    describe('error handling', () => {
        it('should throw error for invalid manifest file', () => {
            expect(() => {
                new SecretsConfigManager('nonexistent-manifest.json');
            }).toThrow('Failed to load secrets manifest');
        });
        
        it('should throw error for malformed JSON', () => {
            const invalidManifestPath = path.join(__dirname, 'invalid-manifest.json');
            fs.writeFileSync(invalidManifestPath, 'invalid json content');
            
            try {
                expect(() => {
                    new SecretsConfigManager(invalidManifestPath);
                }).toThrow('Failed to load secrets manifest');
            } finally {
                if (fs.existsSync(invalidManifestPath)) {
                    fs.unlinkSync(invalidManifestPath);
                }
            }
        });
    });
});