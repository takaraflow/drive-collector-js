/**
 * Tests for BaseSecretsProvider
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock EventEmitter for testing
class MockEventEmitter {
    constructor() {
        this.events = {};
    }
    
    on(event, listener) {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event].push(listener);
    }
    
    emit(event, data) {
        if (this.events[event]) {
            this.events[event].forEach(listener => listener(data));
        }
    }
    
    removeAllListeners() {
        this.events = {};
    }
}

// Mock BaseSecretsProvider for testing
class TestSecretsProvider extends MockEventEmitter {
    constructor(config) {
        super();
        this.config = {
            pollInterval: 1000,
            maxRetries: 3,
            retryDelay: 100,
            enablePolling: false,
            environment: 'test',
            ...config
        };
        
        this.isPolling = false;
        this.pollTimer = null;
        this.lastKnownSecrets = new Map();
        this.currentSecrets = new Map();
        this.isInitialized = false;
        this.mockSecrets = new Map();
    }
    
    async authenticate() {
        // Mock implementation
        return Promise.resolve();
    }
    
    async fetchSecrets() {
        return Promise.resolve(this.mockSecrets);
    }
    
    setMockSecrets(secrets) {
        this.mockSecrets = new Map(secrets);
    }
    
    // Import methods from BaseSecretsProvider
    getSecret(key) {
        return this.currentSecrets.get(key);
    }
    
    getAllSecrets() {
        return new Map(this.currentSecrets);
    }
    
    hasSecret(key) {
        return this.currentSecrets.has(key);
    }
    
    // Expose protected methods for testing
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
    
    async initialize() {
        if (this.isInitialized) {
            return;
        }
        
        try {
            await this.authenticate();
            const secrets = await this.fetchSecrets();
            this.currentSecrets = new Map(secrets);
            this.lastKnownSecrets = new Map(secrets);
            this.isInitialized = true;
            
            this.emit('initialized', {
                provider: this.constructor.name,
                secretsCount: this.currentSecrets.size,
                environment: this.config.environment
            });
        } catch (error) {
            this.emit('error', {
                error: {
                    message: error.message,
                    stack: error.stack
                },
                context: 'initialization',
                provider: this.constructor.name,
                timestamp: Date.now()
            });
            throw error;
        }
    }
}

describe('BaseSecretsProvider', () => {
    let provider;
    
    beforeEach(() => {
        provider = new TestSecretsProvider({
            environment: 'test',
            enablePolling: false
        });
    });
    
    afterEach(() => {
        if (provider.isPolling) {
            provider.stopPolling();
        }
    });
    
    describe('initialization', () => {
        it('should initialize successfully with valid configuration', async () => {
            provider.setMockSecrets([
                ['TEST_SECRET', 'test_value'],
                ['ANOTHER_SECRET', 'another_value']
            ]);
            
            await provider.initialize();
            
            expect(provider.isInitialized).toBe(true);
            expect(provider.currentSecrets.size).toBe(2);
            expect(provider.getSecret('TEST_SECRET')).toBe('test_value');
        });
        
        it('should emit initialized event after successful initialization', async () => {
            const mockListener = vi.fn();
            provider.on('initialized', mockListener);
            
            provider.setMockSecrets([['TEST_SECRET', 'test_value']]);
            await provider.initialize();
            
            expect(mockListener).toHaveBeenCalledWith({
                provider: 'TestSecretsProvider',
                secretsCount: 1,
                environment: 'test'
            });
        });
        
        it('should not initialize twice', async () => {
            provider.setMockSecrets([['TEST_SECRET', 'test_value']]);
            
            await provider.initialize();
            await provider.initialize(); // Second call should be ignored
            
            expect(provider.isInitialized).toBe(true);
        });
        
        it('should emit error event on initialization failure', async () => {
            const mockErrorListener = vi.fn();
            provider.on('error', mockErrorListener);
            
            // Make authentication fail
            provider.authenticate = () => Promise.reject(new Error('Auth failed'));
            
            await expect(provider.initialize()).rejects.toThrow('Auth failed');
            
            expect(mockErrorListener).toHaveBeenCalledWith({
                error: expect.objectContaining({
                    message: 'Auth failed'
                }),
                context: 'initialization',
                provider: 'TestSecretsProvider',
                timestamp: expect.any(Number)
            });
        });
    });
    
    describe('secrets management', () => {
        beforeEach(async () => {
            provider.setMockSecrets([
                ['SECRET1', 'value1'],
                ['SECRET2', 'value2']
            ]);
            await provider.initialize();
        });
        
        it('should get individual secrets', () => {
            expect(provider.getSecret('SECRET1')).toBe('value1');
            expect(provider.getSecret('NONEXISTENT')).toBeUndefined();
        });
        
        it('should check if secret exists', () => {
            expect(provider.hasSecret('SECRET1')).toBe(true);
            expect(provider.hasSecret('NONEXISTENT')).toBe(false);
        });
        
        it('should get all secrets', () => {
            const allSecrets = provider.getAllSecrets();
            expect(allSecrets.size).toBe(2);
            expect(allSecrets.get('SECRET1')).toBe('value1');
            expect(allSecrets.get('SECRET2')).toBe('value2');
        });
    });
    
    describe('change detection', () => {
        it('should detect added secrets', () => {
            const oldSecrets = new Map([['EXISTING', 'value']]);
            const newSecrets = new Map([
                ['EXISTING', 'value'],
                ['NEW_SECRET', 'new_value']
            ]);
            
            const changes = provider._detectChanges(oldSecrets, newSecrets);
            
            expect(changes).toHaveLength(1);
            expect(changes[0]).toEqual({
                key: 'NEW_SECRET',
                oldValue: undefined,
                newValue: 'new_value',
                type: 'added'
            });
        });
        
        it('should detect modified secrets', () => {
            const oldSecrets = new Map([['SECRET', 'old_value']]);
            const newSecrets = new Map([['SECRET', 'new_value']]);
            
            const changes = provider._detectChanges(oldSecrets, newSecrets);
            
            expect(changes).toHaveLength(1);
            expect(changes[0]).toEqual({
                key: 'SECRET',
                oldValue: 'old_value',
                newValue: 'new_value',
                type: 'modified'
            });
        });
        
        it('should detect deleted secrets', () => {
            const oldSecrets = new Map([
                ['KEEP', 'value'],
                ['DELETE', 'value']
            ]);
            const newSecrets = new Map([['KEEP', 'value']]);
            
            const changes = provider._detectChanges(oldSecrets, newSecrets);
            
            expect(changes).toHaveLength(1);
            expect(changes[0]).toEqual({
                key: 'DELETE',
                oldValue: 'value',
                newValue: undefined,
                type: 'deleted'
            });
        });
        
        it('should detect multiple changes', () => {
            const oldSecrets = new Map([
                ['MODIFY', 'old_value'],
                ['DELETE', 'value']
            ]);
            const newSecrets = new Map([
                ['MODIFY', 'new_value'],
                ['ADD', 'new_secret_value']
            ]);
            
            const changes = provider._detectChanges(oldSecrets, newSecrets);
            
            expect(changes).toHaveLength(3);
            expect(changes.some(c => c.key === 'MODIFY' && c.type === 'modified')).toBe(true);
            expect(changes.some(c => c.key === 'DELETE' && c.type === 'deleted')).toBe(true);
            expect(changes.some(c => c.key === 'ADD' && c.type === 'added')).toBe(true);
        });
        
        it('should detect no changes when secrets are identical', () => {
            const secrets = new Map([['SECRET', 'value']]);
            const changes = provider._detectChanges(secrets, secrets);
            
            expect(changes).toHaveLength(0);
        });
    });
    
    describe('configuration', () => {
        it('should use default configuration when none provided', () => {
            const defaultProvider = new TestSecretsProvider();
            
            expect(defaultProvider.config.pollInterval).toBe(1000);
            expect(defaultProvider.config.maxRetries).toBe(3);
            expect(defaultProvider.config.retryDelay).toBe(100);
            expect(defaultProvider.config.enablePolling).toBe(false);
            expect(defaultProvider.config.environment).toBe('test');
        });
        
        it('should merge custom configuration with defaults', () => {
            const customProvider = new TestSecretsProvider({
                pollInterval: 5000,
                environment: 'production'
            });
            
            expect(customProvider.config.pollInterval).toBe(5000);
            expect(customProvider.config.maxRetries).toBe(3); // Default value
            expect(customProvider.config.environment).toBe('production');
        });
    });
});