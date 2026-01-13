import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import BaseSecretsProvider from '../../../src/services/secrets/BaseSecretsProvider.js';
import CloudSecretsProvider from '../../../src/services/secrets/CloudSecretsProvider.js';
import InfisicalSecretsProvider from '../../../src/services/secrets/InfisicalSecretsProvider.js';

describe('BaseSecretsProvider', () => {
  describe('constructor', () => {
    it('should initialize with default values', () => {
      const provider = new BaseSecretsProvider();
      
      expect(provider.pollInterval).toBeNull();
      expect(provider.isPolling).toBe(false);
    });
  });

  describe('fetchSecrets', () => {
    it('should throw error when not implemented by subclass', async () => {
      const provider = new BaseSecretsProvider();
      
      await expect(provider.fetchSecrets()).rejects.toThrow(
        'fetchSecrets must be implemented by subclass'
      );
    });
  });

  describe('stopPolling', () => {
    it('should clear poll interval and reset polling state', () => {
      const provider = new BaseSecretsProvider();
      
      // Mock clearInterval
      global.clearInterval = vi.fn();
      
      provider.pollInterval = setInterval(() => {}, 1000);
      provider.isPolling = true;
      
      provider.stopPolling();
      
      expect(clearInterval).toHaveBeenCalled();
      expect(provider.pollInterval).toBeNull();
      expect(provider.isPolling).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should remove all listeners', () => {
      const provider = new BaseSecretsProvider();
      
      // Mock remove all listeners
      const mockRemoveAll = vi.fn();
      provider.removeAllListeners = mockRemoveAll;
      
      provider.cleanup();
      
      expect(mockRemoveAll).toHaveBeenCalled();
    });
  });
});

describe('CloudSecretsProvider', () => {
  describe('constructor', () => {
    it('should initialize with options', () => {
      const options = { test: 'value' };
      const provider = new CloudSecretsProvider(options);
      
      expect(provider.options).toEqual(options);
      expect(provider.currentSecrets).toEqual({});
      expect(provider.lastVersion).toBeNull();
    });
  });

  describe('detectChanges', () => {
    it('should detect added secrets', () => {
      const provider = new CloudSecretsProvider();
      const mockOnConfigChange = vi.fn();
      provider.on('configChanged', mockOnConfigChange);
      
      const newSecrets = { NEW_KEY: 'new_value' };
      
      provider.detectChanges(newSecrets);
      
      expect(mockOnConfigChange).toHaveBeenCalledWith([
        { key: 'NEW_KEY', oldValue: undefined, newValue: 'new_value' }
      ]);
      expect(provider.currentSecrets).toEqual(newSecrets);
    });

    it('should detect modified secrets', () => {
      const provider = new CloudSecretsProvider();
      const mockOnConfigChange = vi.fn();
      provider.on('configChanged', mockOnConfigChange);
      provider.currentSecrets = { KEY1: 'old_value' };
      
      const newSecrets = { KEY1: 'new_value' };
      
      provider.detectChanges(newSecrets);
      
      expect(mockOnConfigChange).toHaveBeenCalledWith([
        { key: 'KEY1', oldValue: 'old_value', newValue: 'new_value' }
      ]);
    });

    it('should detect deleted secrets', () => {
      const provider = new CloudSecretsProvider();
      const mockOnConfigChange = vi.fn();
      provider.on('configChanged', mockOnConfigChange);
      provider.currentSecrets = { KEY1: 'value1' };
      
      const newSecrets = {};
      
      provider.detectChanges(newSecrets);
      
      expect(mockOnConfigChange).toHaveBeenCalledWith([
        { key: 'KEY1', oldValue: 'value1', newValue: undefined }
      ]);
    });

    it('should not emit event when no changes', () => {
      const provider = new CloudSecretsProvider();
      const mockOnConfigChange = vi.fn();
      provider.on('configChanged', mockOnConfigChange);
      provider.currentSecrets = { KEY1: 'value1' };
      
      const newSecrets = { KEY1: 'value1' };
      
      provider.detectChanges(newSecrets);
      
      expect(mockOnConfigChange).not.toHaveBeenCalled();
    });
  });

  describe('validateResponse', () => {
    it('should validate correct object response', () => {
      const provider = new CloudSecretsProvider();
      const response = { secrets: [] };
      
      expect(() => provider.validateResponse(response)).not.toThrow();
    });

    it('should throw error for null response', () => {
      const provider = new CloudSecretsProvider();
      
      expect(() => provider.validateResponse(null)).toThrow(
        'Invalid secrets response: expected object'
      );
    });

    it('should throw error for undefined response', () => {
      const provider = new CloudSecretsProvider();
      
      expect(() => provider.validateResponse(undefined)).toThrow(
        'Invalid secrets response: expected object'
      );
    });

    it('should throw error for non-object response', () => {
      const provider = new CloudSecretsProvider();
      
      expect(() => provider.validateResponse('string')).toThrow(
        'Invalid secrets response: expected object'
      );
    });

    it('should accept array response (arrays are objects)', () => {
      const provider = new CloudSecretsProvider();
      
      // Array is technically an object in JavaScript, so it passes basic validation
      expect(() => provider.validateResponse([])).not.toThrow();
    });
  });

  describe('parseSecrets', () => {
    it('should parse secrets array into key-value pairs', () => {
      const provider = new CloudSecretsProvider();
      const response = {
        secrets: [
          { secretKey: 'API_KEY', secretValue: 'key123' },
          { secretKey: 'SECRET', secretValue: 'value456' }
        ]
      };
      
      const result = provider.parseSecrets(response);
      
      expect(result).toEqual({
        API_KEY: 'key123',
        SECRET: 'value456'
      });
    });

    it('should return empty object when secrets array is empty', () => {
      const provider = new CloudSecretsProvider();
      const response = { secrets: [] };
      
      const result = provider.parseSecrets(response);
      
      expect(result).toEqual({});
    });

    it('should return empty object when response has no secrets', () => {
      const provider = new CloudSecretsProvider();
      const response = {};
      
      const result = provider.parseSecrets(response);
      
      expect(result).toEqual({});
    });
  });

  describe('hashSecrets', () => {
    it('should generate consistent SHA256 hash for same input', () => {
      const provider = new CloudSecretsProvider();
      const secrets = { KEY1: 'value1', KEY2: 'value2' };
      
      const hash1 = provider.hashSecrets(secrets);
      const hash2 = provider.hashSecrets(secrets);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate different hash for different input', () => {
      const provider = new CloudSecretsProvider();
      const secrets1 = { KEY1: 'value1' };
      const secrets2 = { KEY1: 'value2' };
      
      const hash1 = provider.hashSecrets(secrets1);
      const hash2 = provider.hashSecrets(secrets2);
      
      expect(hash1).not.toBe(hash2);
    });

    it('should generate hash for empty object', () => {
      const provider = new CloudSecretsProvider();
      
      const hash = provider.hashSecrets({});
      
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('getCurrentSecrets', () => {
    it('should return copy of current secrets', () => {
      const provider = new CloudSecretsProvider();
      provider.currentSecrets = { KEY1: 'value1', KEY2: 'value2' };
      
      const result = provider.getCurrentSecrets();
      
      expect(result).toEqual({ KEY1: 'value1', KEY2: 'value2' });
    });

    it('should return empty object when no secrets', () => {
      const provider = new CloudSecretsProvider();
      
      const result = provider.getCurrentSecrets();
      
      expect(result).toEqual({});
    });

    it('should not return reference to internal object', () => {
      const provider = new CloudSecretsProvider();
      provider.currentSecrets = { KEY1: 'value1' };
      
      const result = provider.getCurrentSecrets();
      result.KEY1 = 'modified';
      
      expect(provider.currentSecrets.KEY1).toBe('value1');
    });
  });
});

describe('InfisicalSecretsProvider', () => {
  describe('constructor', () => {
    it('should initialize authType as null', () => {
      const provider = new InfisicalSecretsProvider({});
      
      expect(provider.authType).toBeNull();
    });
  });

  describe('validateResponse', () => {
    it('should validate correct response with secrets array', () => {
      const provider = new InfisicalSecretsProvider({});
      const response = { secrets: [] };
      
      expect(() => provider.validateResponse(response)).not.toThrow();
    });

    it('should throw error when secrets property is missing', () => {
      const provider = new InfisicalSecretsProvider({});
      const response = {};
      
      expect(() => provider.validateResponse(response)).toThrow(
        'Invalid Infisical response: missing secrets array'
      );
    });

    it('should throw error when secrets is not an array', () => {
      const provider = new InfisicalSecretsProvider({});
      const response = { secrets: 'not-an-array' };
      
      expect(() => provider.validateResponse(response)).toThrow(
        'Invalid Infisical response: missing secrets array'
      );
    });

    it('should throw error when secrets is null', () => {
      const provider = new InfisicalSecretsProvider({});
      const response = { secrets: null };
      
      expect(() => provider.validateResponse(response)).toThrow(
        'Invalid Infisical response: missing secrets array'
      );
    });
  });

  describe('setupWebhookListener', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should log warning that webhook listener is not implemented', () => {
      const provider = new InfisicalSecretsProvider({});
      
      provider.setupWebhookListener();
      
      expect(console.warn).toHaveBeenCalledWith(
        '⚠️ Webhook listener not yet implemented'
      );
    });
  });
});
