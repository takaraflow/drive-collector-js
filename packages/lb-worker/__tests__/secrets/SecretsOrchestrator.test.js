/**
 * Integration tests for SecretsOrchestrator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock InfisicalSecretsProvider
class MockInfisicalSecretsProvider {
    constructor(config) {
        this.config = config;
        this.isInitialized = false;
        this.mockSecrets = new Map([
            ['QSTASH_CURRENT_SIGNING_KEY', 'test-qstash-key'],
            ['UPSTASH_REDIS_REST_URL', 'redis://localhost:6379'],
            ['UPSTASH_REDIS_REST_TOKEN', 'test-redis-token'],
            ['AXIOM_TOKEN', 'test-axiom-token'],
            ['AXIOM_DATASET', 'test-dataset'],
            ['DEBUG_LOGS', 'false']
        ]);
    }
    
    async initialize() {
        this.isInitialized = true;
        return Promise.resolve();
    }
    
    async getAllSecrets() {
        if (!this.isInitialized) {
            throw new Error('Provider not initialized');
        }
        return Promise.resolve(this.mockSecrets);
    }
    
    getMetadata() {
        return {
            provider: 'InfisicalSecretsProvider',
            environment: this.config.environment,
            secretsCount: this.mockSecrets.size,
            isInitialized: this.isInitialized
        };
    }
    
    async cleanup() {
        this.isInitialized = false;
    }
}

describe('SecretsOrchestrator Integration Tests', () => {
    let SecretsOrchestrator;
    let orchestrator;
    let tempOutputDir;
    
    beforeEach(async () => {
        vi.resetModules();
        
        // Create temporary output directory
        tempOutputDir = path.join(__dirname, 'temp-secrets-output');
        if (!fs.existsSync(tempOutputDir)) {
            fs.mkdirSync(tempOutputDir, { recursive: true });
        }
        
        // Mock the InfisicalSecretsProvider import
        vi.doMock('../../src/services/secrets/InfisicalSecretsProvider.js', () => ({
            InfisicalSecretsProvider: MockInfisicalSecretsProvider
        }));
        
        const module = await import('../../src/config/SecretsOrchestrator.js');
        SecretsOrchestrator = module.SecretsOrchestrator;
    });
    
    afterEach(() => {
        // Cleanup temporary directory
        if (fs.existsSync(tempOutputDir)) {
            const files = fs.readdirSync(tempOutputDir);
            files.forEach(file => {
                const filePath = path.join(tempOutputDir, file);
                try { fs.unlinkSync(filePath); } catch(e) {}
            });
            try { fs.rmdirSync(tempOutputDir); } catch(e) {}
        }
        
        // Reset mocks
        vi.restoreAllMocks();
    });
    
    describe('basic orchestration', () => {
        beforeEach(() => {
            orchestrator = new SecretsOrchestrator({
                environment: 'test',
                provider: 'infisical',
                providerConfig: {
                    projectId: 'test-project-id',
                    token: 'test-token'
                },
                validate: true,
                dryRun: false,
                outputDir: tempOutputDir,
                cleanup: false // Don't cleanup for testing
            });
        });
        
        afterEach(async () => {
            if (orchestrator) await orchestrator.cleanup();
        });
        
        it('should execute complete secrets injection workflow', async () => {
            const result = await orchestrator.executeInjection();
            
            expect(result.success).toBe(true);
            expect(result.secrets.size).toBeGreaterThan(0);
            expect(result.generatedFiles.length).toBeGreaterThan(0);
            expect(result.duration).toBeDefined();
            expect(result.error).toBeNull();
            
            // Check that expected files were generated
            const expectedFiles = ['secrets.json', '.env.build', 'secrets-metadata.json'];
            expectedFiles.forEach(filename => {
                const filePath = path.join(tempOutputDir, filename);
                expect(fs.existsSync(filePath)).toBe(true);
            });
        });
        
        it('should generate correct secrets.json format', async () => {
            await orchestrator.executeInjection();
            
            const secretsJsonPath = path.join(tempOutputDir, 'secrets.json');
            const secretsContent = JSON.parse(fs.readFileSync(secretsJsonPath, 'utf8'));
            
            expect(secretsContent).toBeInstanceOf(Object);
            expect(Object.keys(secretsContent).length).toBeGreaterThan(0);
            
            // Should not contain infrastructure variables
            expect(secretsContent).not.toHaveProperty('NODE_ENV');
            expect(secretsContent).not.toHaveProperty('INFISICAL_TOKEN');
            
            // Should contain expected secrets
            expect(secretsContent).toHaveProperty('QSTASH_CURRENT_SIGNING_KEY');
            expect(secretsContent).toHaveProperty('UPSTASH_REDIS_REST_URL');
        });
        
        it('should generate correct .env.build format', async () => {
            await orchestrator.executeInjection();
            
            const envBuildPath = path.join(tempOutputDir, '.env.build');
            const envContent = fs.readFileSync(envBuildPath, 'utf8');
            
            expect(envContent).toContain('# Generated secrets for environment: test');
            expect(envContent).toContain('QSTASH_CURRENT_SIGNING_KEY=');
            expect(envContent).toContain('UPSTASH_REDIS_REST_URL=');
            
            // Should contain masked values
            expect(envContent).toContain('****');
        });
        
        it('should generate metadata with correct information', async () => {
            await orchestrator.executeInjection();
            
            const metadataPath = path.join(tempOutputDir, 'secrets-metadata.json');
            const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            
            expect(metadata.environment).toBe('test');
            expect(metadata.provider).toBe('infisical');
            expect(metadata.timestamp).toBeDefined();
            expect(metadata.secretsCount).toBeGreaterThan(0);
            expect(metadata.generatedFiles).toBeDefined();
            expect(metadata.manifest).toBeDefined();
            expect(metadata.providerMetadata).toBeDefined();
        });
    });
    
    describe('dry run mode', () => {
        beforeEach(() => {
            orchestrator = new SecretsOrchestrator({
                environment: 'test',
                provider: 'infisical',
                dryRun: true,
                outputDir: tempOutputDir,
                cleanup: false
            });
        });
        
        it('should not generate files in dry run mode', async () => {
            const result = await orchestrator.executeInjection();
            
            expect(result.success).toBe(true);
            expect(result.generatedFiles).toHaveLength(0);
            
            // Ensure no files were created
            const files = fs.readdirSync(tempOutputDir);
            expect(files).toHaveLength(0);
        });
        
        it('should still fetch and validate secrets in dry run mode', async () => {
            const result = await orchestrator.executeInjection();
            
            expect(result.success).toBe(true);
            expect(result.secrets.size).toBeGreaterThan(0);
            expect(result.validation).toBeDefined();
        });
    });
    
    describe('error handling', () => {
        beforeEach(() => {
            orchestrator = new SecretsOrchestrator({
                environment: 'test',
                provider: 'infisical',
                dryRun: false,
                outputDir: tempOutputDir,
                cleanup: false
            });
        });
        
        it('should handle provider initialization failure', async () => {
            // Mock provider to fail initialization
            class FailingProvider extends MockInfisicalSecretsProvider {
                async initialize() {
                    throw new Error('Initialization failed');
                }
            }
            
            orchestrator.provider = new FailingProvider({});
            
            const result = await orchestrator.executeInjection();
            
            expect(result.success).toBe(false);
            expect(result.error).toContain('Initialization failed');
            expect(result.secrets.size).toBe(0);
        });
        
        it('should handle secrets fetch failure', async () => {
            // Mock provider to fail fetching
            class FailingFetchProvider extends MockInfisicalSecretsProvider {
                async getAllSecrets() {
                    throw new Error('Fetch failed');
                }
            }
            
            orchestrator.provider = new FailingFetchProvider({});
            
            const result = await orchestrator.executeInjection();
            
            expect(result.success).toBe(false);
            expect(result.error).toContain('Fetch failed');
        });
    });
    
    describe('configuration options', () => {
        it('should use custom provider configuration', () => {
            orchestrator = new SecretsOrchestrator({
                environment: 'custom',
                provider: 'infisical',
                providerConfig: {
                    projectId: 'custom-project',
                    token: 'custom-token',
                    includeSecrets: ['SELECTED_SECRET']
                }
            });
            
            expect(orchestrator.config.providerConfig.projectId).toBe('custom-project');
            expect(orchestrator.config.providerConfig.includeSecrets).toEqual(['SELECTED_SECRET']);
        });
        
        it('should support different environments', () => {
            const environments = ['dev', 'pre', 'prod'];
            
            environments.forEach(env => {
                const envOrchestrator = new SecretsOrchestrator({
                    environment: env,
                    provider: 'infisical'
                });
                
                expect(envOrchestrator.config.environment).toBe(env);
            });
        });
    });
    
    describe('status and metadata', () => {
        beforeEach(() => {
            orchestrator = new SecretsOrchestrator({
                environment: 'test',
                provider: 'infisical',
                dryRun: false,
                outputDir: tempOutputDir
            });
        });
        
        it('should return correct status information', () => {
            const status = orchestrator.getStatus();
            
            expect(status.provider).toBe('infisical');
            expect(status.environment).toBe('test');
            expect(status.config).toBeDefined();
            expect(status.config.dryRun).toBe(false);
            expect(status.config.validate).toBe(true);
        });
        
        it('should update status after initialization', async () => {
            await orchestrator.provider.initialize();
            
            const status = orchestrator.getStatus();
            expect(status.isInitialized).toBe(true);
        });
    });
    
    describe('file cleanup', () => {
        it('should cleanup temporary files when enabled', async () => {
            orchestrator = new SecretsOrchestrator({
                environment: 'test',
                provider: 'infisical',
                dryRun: false,
                outputDir: tempOutputDir,
                cleanup: true
            });
            
            await orchestrator.executeInjection();
            
            // Files should be cleaned up (except metadata)
            const files = fs.readdirSync(tempOutputDir);
            
            // Should only have metadata file after cleanup
            expect(files.length).toBeLessThanOrEqual(1);
            if (files.length === 1) {
                expect(files[0]).toBe('secrets-metadata.json');
            }
        });
    });
});
