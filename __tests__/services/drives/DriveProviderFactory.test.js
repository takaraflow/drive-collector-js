import { DriveProviderFactory } from '../../../src/services/drives/DriveProviderFactory.js';
import { BaseDriveProvider } from '../../../src/services/drives/BaseDriveProvider.js';

/**
 * DriveProviderFactory 单元测试
 * 测试工厂类的注册、获取和单例模式
 */
describe('DriveProviderFactory - Unit Tests', () => {
  // 清除所有注册的 Provider
  beforeEach(() => {
    // 清除所有注册的 Provider
    DriveProviderFactory.clear();
  });

  test('should register a provider', () => {
    class TestProvider extends BaseDriveProvider {
      constructor() {
        super('test', 'Test Drive');
      }
    }

    DriveProviderFactory.register('test', TestProvider);
    const provider = DriveProviderFactory.getProvider('test');

    expect(provider).toBeInstanceOf(TestProvider);
    expect(provider.type).toBe('test');
    expect(provider.name).toBe('Test Drive');
  });

  test('should return same instance for multiple calls (singleton)', () => {
    class TestProvider extends BaseDriveProvider {
      constructor() {
        super('test', 'Test Drive');
      }
    }

    DriveProviderFactory.register('test', TestProvider);
    const provider1 = DriveProviderFactory.getProvider('test');
    const provider2 = DriveProviderFactory.getProvider('test');

    expect(provider1).toBe(provider2);
  });

  test('should throw error when getting unregistered provider', () => {
    expect(() => {
      DriveProviderFactory.getProvider('nonexistent');
    }).toThrow('Provider not registered for type: nonexistent');
  });

  test('should throw error when registering duplicate provider', () => {
    class TestProvider extends BaseDriveProvider {
      constructor() {
        super('test', 'Test Drive');
      }
    }

    DriveProviderFactory.register('test', TestProvider);

    expect(() => {
      DriveProviderFactory.register('test', TestProvider);
    }).toThrow('Provider already registered for type: test');
  });

  test('should get all registered providers', () => {
    class TestProvider1 extends BaseDriveProvider {
      constructor() {
        super('test1', 'Test Drive 1');
      }
    }

    class TestProvider2 extends BaseDriveProvider {
      constructor() {
        super('test2', 'Test Drive 2');
      }
    }

    DriveProviderFactory.register('test1', TestProvider1);
    DriveProviderFactory.register('test2', TestProvider2);

    const providers = DriveProviderFactory.getAllProviders();

    expect(providers).toHaveLength(2);
    expect(providers.find(p => p.type === 'test1')).toBeInstanceOf(TestProvider1);
    expect(providers.find(p => p.type === 'test2')).toBeInstanceOf(TestProvider2);
  });

  test('should get supported drive types', () => {
    class TestProvider1 extends BaseDriveProvider {
      constructor() {
        super('test1', 'Test Drive 1');
      }
    }

    class TestProvider2 extends BaseDriveProvider {
      constructor() {
        super('test2', 'Test Drive 2');
      }
    }

    DriveProviderFactory.register('test1', TestProvider1);
    DriveProviderFactory.register('test2', TestProvider2);

    const types = DriveProviderFactory.getSupportedDriveTypes();

    expect(types).toHaveLength(2);
    expect(types).toContain('test1');
    expect(types).toContain('test2');
  });

  test('should clear all providers', () => {
    class TestProvider extends BaseDriveProvider {
      constructor() {
        super('test', 'Test Drive');
      }
    }

    DriveProviderFactory.register('test', TestProvider);
    expect(DriveProviderFactory.getSupportedDriveTypes()).toHaveLength(1);

    DriveProviderFactory.clear();
    expect(DriveProviderFactory.getSupportedDriveTypes()).toHaveLength(0);
  });

  test('should handle provider with custom processPassword', () => {
    class CustomProvider extends BaseDriveProvider {
      constructor() {
        super('custom', 'Custom Drive');
      }

      processPassword(password) {
        return `obscured-${password}`;
      }
    }

    DriveProviderFactory.register('custom', CustomProvider);
    const provider = DriveProviderFactory.getProvider('custom');

    expect(provider.processPassword('secret')).toBe('obscured-secret');
  });

  test('should handle provider with async methods', async () => {
    class AsyncProvider extends BaseDriveProvider {
      constructor() {
        super('async', 'Async Drive');
      }

      async validateCredentials(credentials) {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({ success: credentials.valid === true });
          }, 10);
        });
      }
    }

    DriveProviderFactory.register('async', AsyncProvider);
    const provider = DriveProviderFactory.getProvider('async');

    const result = await provider.validateCredentials({ valid: true });
    expect(result.success).toBe(true);
  });
});
