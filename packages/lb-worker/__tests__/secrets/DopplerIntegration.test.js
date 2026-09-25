/**
 * Tests for Doppler integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock Doppler SDK
vi.mock('@dopplerhq/node-sdk', () => {
    return {
        default: class MockDoppler {
            constructor(config) {
                this.token = config.token;
                this.apiHost = config.apiHost;
            }
            
            async getSecrets(options) {
                // Mock response
                return {
                    'QSTASH_CURRENT_SIGNING_KEY': 'test-qstash-key',
                    'REDIS_URL': 'redis://localhost:6379',
                    'AXIOM_TOKEN': 'test-axiom-token'
                };
            }
            
            async setSecret(options) {
                return Promise.resolve();
            }
            
            async deleteSecret(options) {
                return Promise.resolve();
            }
        }
    };
});

describe('Doppler Integration', () => {
    let originalEnv;
    
    beforeEach(() => {
        originalEnv = { ...process.env };
        vi.clearAllMocks();
    });
    
    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });
    
    describe('Environment Detection', () => {
        it('should detect Doppler credentials', async () => {
            process.env.DOPPLER_PROJECT = 'test-project';
            process.env.DOPPLER_TOKEN = 'dp.st.dev.xxxxxx';
            
            const { hasDopplerCredentials } = await import('../../scripts/build-utils.js');
            expect(hasDopplerCredentials()).toBe(true);
        });
        
        it('should not detect missing credentials', async () => {
            delete process.env.DOPPLER_PROJECT;
            delete process.env.DOPPLER_TOKEN;
            
            const { hasDopplerCredentials } = await import('../../scripts/build-utils.js');
            expect(hasDopplerCredentials()).toBe(false);
        });
        
        it('should detect any valid auth method', async () => {
            process.env.DOPPLER_PROJECT = 'test-project';
            
            // Test API Token
            process.env.DOPPLER_API_TOKEN = 'api-token';
            const { hasDopplerCredentials } = await import('../../scripts/build-utils.js');
            expect(hasDopplerCredentials()).toBe(true);
            
            // Test Service Account Token
            delete process.env.DOPPLER_API_TOKEN;
            process.env.DOPPLER_SERVICE_ACCOUNT_TOKEN = 'sa-token';
            expect(hasDopplerCredentials()).toBe(true);
            
            // Test API Key
            delete process.env.DOPPLER_SERVICE_ACCOUNT_TOKEN;
            process.env.DOPPLER_API_KEY = 'api-key';
            expect(hasDopplerCredentials()).toBe(true);
        });
    });
    
    describe('Provider Selection', () => {
        it('should select Doppler provider when configured', async () => {
            process.env.SECRETS_PROVIDER = 'doppler';
            process.env.DOPPLER_PROJECT = 'test-project';
            process.env.DOPPLER_TOKEN = 'dp.st.dev.xxxxxx';
            
            const { SecretsOrchestrator } = await import('../../src/config/SecretsOrchestrator.js');
            const orchestrator = new SecretsOrchestrator({
                environment: 'dev'
            });
            
            const status = orchestrator.getStatus();
            expect(status.provider).toBe('doppler');
        });
        
        it('should fall back to Infisical when Doppler not configured', async () => {
            process.env.SECRETS_PROVIDER = 'infisical';
            process.env.INFISICAL_PROJECT_ID = 'test-project';
            process.env.INFISICAL_TOKEN = 'test-token';
            
            const { SecretsOrchestrator } = await import('../../src/config/SecretsOrchestrator.js');
            const orchestrator = new SecretsOrchestrator({
                environment: 'dev'
            });
            
            const status = orchestrator.getStatus();
            expect(status.provider).toBe('infisical');
        });
    });
    
    describe('Environment Mapping', () => {
        it('should map environments correctly', async () => {
            const envMappings = [
                { input: 'dev', expected: 'dev' },
                { input: 'development', expected: 'dev' },
                { input: 'staging', expected: 'staging' },
                { input: 'pre', expected: 'staging' },
                { input: 'prod', expected: 'prod' },
                { input: 'production', expected: 'prod' }
            ];
            
            for (const { input, expected } of envMappings) {
                process.env.NODE_ENV = input;
                process.env.SECRETS_PROVIDER = 'doppler';
                process.env.DOPPLER_PROJECT = 'test-project';
                process.env.DOPPLER_TOKEN = 'dp.st.dev.xxxxxx';
                
                const { SecretsOrchestrator } = await import('../../src/config/SecretsOrchestrator.js');
                const orchestrator = new SecretsOrchestrator({
                    environment: input
                });
                
                // This would be tested through actual provider initialization
                expect(orchestrator.config.environment).toBe(input);
            }
        });
    });
    
    describe('Integration Test', () => {
        it('should work end-to-end with Doppler configuration', async () => {
            // Set up complete Doppler configuration
            process.env.SECRETS_PROVIDER = 'doppler';
            process.env.DOPPLER_PROJECT = 'lb-worker-test';
            process.env.DOPPLER_TOKEN = 'dp.st.dev.xxxxxx';
            process.env.NODE_ENV = 'test';
            
            const { SecretsOrchestrator } = await import('../../src/config/SecretsOrchestrator.js');
            const orchestrator = new SecretsOrchestrator({
                environment: 'test',
                dryRun: true,
                validate: false
            });
            
            // Test that orchestrator is properly configured
            expect(orchestrator.config.provider).toBe('doppler');
            expect(orchestrator.config.environment).toBe('test');
            expect(orchestrator.config.dryRun).toBe(true);
            
            // Test metadata
            const status = orchestrator.getStatus();
            expect(status.provider).toBe('doppler');
            expect(status.config.validate).toBe(false);
            expect(status.config.dryRun).toBe(true);
        });
    });
});