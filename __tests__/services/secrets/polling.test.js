import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import InfisicalSecretsProvider from '../../../src/services/secrets/InfisicalSecretsProvider.js';
import CloudSecretsProvider from '../../../src/services/secrets/CloudSecretsProvider.js';
import BaseSecretsProvider from '../../../src/services/secrets/BaseSecretsProvider.js';

describe('Infisical Secrets Auto-Update (Polling)', () => {
  let provider;
  let mockConsoleLog;
  let mockConsoleWarn;
  let mockConsoleError;

  beforeEach(() => {
    vi.useFakeTimers();
    mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  describe('轮询基础功能', () => {
    it('应该正确初始化 provider', () => {
      provider = new InfisicalSecretsProvider({});
      
      expect(provider.authType).toBeNull();
      expect(provider.isPolling).toBe(false);
      expect(provider.pollInterval).toBeNull();
    });

    it('启动轮询后 isPolling 应为 true', () => {
      provider = new InfisicalSecretsProvider({});
      
      provider.startPolling(60000);
      
      expect(provider.isPolling).toBe(true);
    });

    it('stopPolling 应清除定时器和状态', () => {
      provider = new InfisicalSecretsProvider({});
      
      // Mock clearInterval
      const mockClearInterval = vi.fn();
      global.clearInterval = mockClearInterval;
      
      provider.startPolling(60000);
      provider.stopPolling();
      
      expect(mockClearInterval).toHaveBeenCalled();
      expect(provider.isPolling).toBe(false);
      expect(provider.pollInterval).toBeNull();
    });
  });

  describe('轮询变更检测', () => {
    it('应该检测新增的 secret', () => {
      provider = new InfisicalSecretsProvider({});
      const changesLog = [];
      
      provider.on('configChanged', changes => {
        changesLog.push(...changes);
      });
      
      provider.currentSecrets = { EXISTING_KEY: 'old_value' };
      const newSecrets = { EXISTING_KEY: 'old_value', NEW_KEY: 'new_value' };
      
      provider.detectChanges(newSecrets);
      
      expect(changesLog).toHaveLength(1);
      expect(changesLog[0]).toEqual({
        key: 'NEW_KEY',
        oldValue: undefined,
        newValue: 'new_value'
      });
    });

    it('应该检测修改的 secret', () => {
      provider = new InfisicalSecretsProvider({});
      const changesLog = [];
      
      provider.on('configChanged', changes => {
        changesLog.push(...changes);
      });
      
      provider.currentSecrets = { KEY1: 'old_value' };
      const newSecrets = { KEY1: 'new_value' };
      
      provider.detectChanges(newSecrets);
      
      expect(changesLog).toHaveLength(1);
      expect(changesLog[0]).toEqual({
        key: 'KEY1',
        oldValue: 'old_value',
        newValue: 'new_value'
      });
    });

    it('应该检测删除的 secret', () => {
      provider = new InfisicalSecretsProvider({});
      const changesLog = [];
      
      provider.on('configChanged', changes => {
        changesLog.push(...changes);
      });
      
      provider.currentSecrets = { KEY1: 'value1', KEY2: 'value2' };
      const newSecrets = { KEY2: 'value2' };
      
      provider.detectChanges(newSecrets);
      
      expect(changesLog).toHaveLength(1);
      expect(changesLog[0]).toEqual({
        key: 'KEY1',
        oldValue: 'value1',
        newValue: undefined
      });
    });

    it('无变更时不应触发事件', () => {
      provider = new InfisicalSecretsProvider({});
      const mockCallback = vi.fn();
      
      provider.on('configChanged', mockCallback);
      provider.currentSecrets = { KEY1: 'value1' };
      
      provider.detectChanges({ KEY1: 'value1' });
      
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('应正确更新 currentSecrets', () => {
      provider = new InfisicalSecretsProvider({});
      
      provider.currentSecrets = { OLD_KEY: 'old_value' };
      const newSecrets = { NEW_KEY: 'new_value' };
      
      provider.detectChanges(newSecrets);
      
      expect(provider.currentSecrets).toEqual(newSecrets);
    });
  });

  describe('轮询定时行为', () => {
    it('应该按指定间隔触发 fetchSecrets', () => {
      provider = new InfisicalSecretsProvider({});
      
      // Mock fetchSecrets - return resolved Promise
      provider.fetchSecrets = vi.fn().mockResolvedValue({ TEST_KEY: 'test_value' });
      provider.onError = vi.fn();
      
      provider.startPolling(1000);
      
      // 推进时间到第一次触发
      vi.advanceTimersByTime(1000);
      
      expect(provider.fetchSecrets).toHaveBeenCalledTimes(1);
    });

    it('应该多次触发 fetchSecrets', () => {
      provider = new InfisicalSecretsProvider({});
      
      provider.fetchSecrets = vi.fn().mockResolvedValue({ TEST_KEY: 'test_value' });
      provider.onError = vi.fn();
      
      provider.startPolling(500);
      
      // 推进时间，触发 3 次
      vi.advanceTimersByTime(1500);
      
      expect(provider.fetchSecrets).toHaveBeenCalledTimes(3);
    });

    it('fetchSecrets 失败时应触发 onError', async () => {
      provider = new InfisicalSecretsProvider({});
      
      provider.fetchSecrets = vi.fn().mockRejectedValue(new Error('Fetch failed'));
      const errorCallback = vi.fn();
      provider.on('error', errorCallback);
      
      provider.startPolling(1000);
      
      vi.advanceTimersByTime(1000);
      await vi.runOnlyPendingTimersAsync();
      
      expect(errorCallback).toHaveBeenCalled();
      expect(errorCallback).toHaveBeenCalledWith(new Error('Fetch failed'));
    });

    it('stopPolling 后不应继续触发 fetch', () => {
      provider = new InfisicalSecretsProvider({});
      
      provider.fetchSecrets = vi.fn().mockResolvedValue({});
      provider.onError = vi.fn();
      
      provider.startPolling(1000);
      
      // 启动后停止
      provider.stopPolling();
      
      // 推进时间
      vi.advanceTimersByTime(1000);
      
      expect(provider.fetchSecrets).not.toHaveBeenCalled();
    });
  });

  describe('getCurrentSecrets 快照', () => {
    it('应返回当前 secrets 的副本', () => {
      provider = new InfisicalSecretsProvider({});
      
      provider.currentSecrets = { KEY1: 'value1', KEY2: 'value2' };
      
      const snapshot = provider.getCurrentSecrets();
      
      expect(snapshot).toEqual({ KEY1: 'value1', KEY2: 'value2' });
      
      // 修改副本不应影响原对象
      snapshot.KEY1 = 'modified';
      
      expect(provider.currentSecrets.KEY1).toBe('value1');
    });

    it('空 secrets 应返回空对象', () => {
      provider = new InfisicalSecretsProvider({});
      
      provider.currentSecrets = {};
      
      const snapshot = provider.getCurrentSecrets();
      
      expect(snapshot).toEqual({});
    });
  });

  describe('cleanup 资源清理', () => {
    it('应停止轮询并移除监听器', () => {
      provider = new InfisicalSecretsProvider({});
      
      // Mock clearInterval
      const mockClearInterval = vi.fn();
      global.clearInterval = mockClearInterval;
      
      // 添加监听器
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      provider.on('configChanged', listener1);
      provider.on('error', listener2);
      
      // 启动轮询
      provider.startPolling(1000);
      
      // 清理
      provider.cleanup();
      
      expect(mockClearInterval).toHaveBeenCalled();
      expect(provider.isPolling).toBe(false);
      expect(provider.pollInterval).toBeNull();
      expect(provider.listenerCount('configChanged')).toBe(0);
      expect(provider.listenerCount('error')).toBe(0);
    });
  });
});

describe('CloudSecretsProvider 轮询逻辑', () => {
  let provider;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  describe('hashSecrets 版本计算', () => {
    it('应为相同输入生成一致哈希', () => {
      provider = new CloudSecretsProvider({});
      
      const secrets = { KEY1: 'value1', KEY2: 'value2' };
      
      const hash1 = provider.hashSecrets(secrets);
      const hash2 = provider.hashSecrets(secrets);
      
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('应为不同输入生成不同哈希', () => {
      provider = new CloudSecretsProvider({});
      
      const hash1 = provider.hashSecrets({ KEY1: 'value1' });
      const hash2 = provider.hashSecrets({ KEY1: 'value2' });
      
      expect(hash1).not.toBe(hash2);
    });

    it('空对象应生成有效哈希', () => {
      provider = new CloudSecretsProvider({});
      
      const hash = provider.hashSecrets({});
      
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('validateResponse 响应验证', () => {
    it('应通过有效对象响应', () => {
      provider = new CloudSecretsProvider({});
      
      const response = { secrets: [] };
      
      expect(() => provider.validateResponse(response)).not.toThrow();
    });

    it('应拒绝 null 响应', () => {
      provider = new CloudSecretsProvider({});
      
      expect(() => provider.validateResponse(null)).toThrow(
        'Invalid secrets response: expected object'
      );
    });

    it('应拒绝 undefined 响应', () => {
      provider = new CloudSecretsProvider({});
      
      expect(() => provider.validateResponse(undefined)).toThrow(
        'Invalid secrets response: expected object'
      );
    });

    it('应拒绝非对象响应', () => {
      provider = new CloudSecretsProvider({});
      
      expect(() => provider.validateResponse('string')).toThrow(
        'Invalid secrets response: expected object'
      );
    });
  });

  describe('parseSecrets 响应解析', () => {
    it('应正确解析 secrets 数组', () => {
      provider = new CloudSecretsProvider({});
      
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

    it('空 secrets 数组应返回空对象', () => {
      provider = new CloudSecretsProvider({});
      
      const response = { secrets: [] };
      
      const result = provider.parseSecrets(response);
      
      expect(result).toEqual({});
    });

    it('无 secrets 属性应返回空对象', () => {
      provider = new CloudSecretsProvider({});
      
      const response = {};
      
      const result = provider.parseSecrets(response);
      
      expect(result).toEqual({});
    });
  });
});
