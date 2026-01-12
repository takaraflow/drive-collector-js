/**
 * Logger Safeguard Tests
 * 验证 Axiom 日志保底逻辑的正确性
 */

import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';

// 我们要测试的是 src/logger.js 中的实际逻辑
import { sanitizeLogData, flushLogs, logger, configureBaseLoggerTransport } from '../src/logger.js';

// 模拟 Cloudflare context
const mockContext = {
  waitUntil: vi.fn(),
  _axiomDebugRequestId: 'test-request-123'
};

describe('Logger Safeguard - sanitizeLogData', () => {
  describe('字符串长度限制', () => {
    test('should_truncate_strings_exceeding_10000_characters', () => {
      const longString = 'a'.repeat(15000);
      const result = sanitizeLogData(longString);
      
      expect(result.length).toBe(10000 + '...[TRUNCATED]'.length);
      expect(result).toContain('[TRUNCATED]');
    });

    test('should_preserve_strings_under_10000_characters', () => {
      const shortString = 'a'.repeat(5000);
      const result = sanitizeLogData(shortString);
      
      expect(result).toBe(shortString);
      expect(result).not.toContain('[TRUNCATED]');
    });

    test('应处理嵌套对象中的长字符串', () => {
      const data = {
        level: 'info',
        message: 'test',
        nested: {
          longField: 'b'.repeat(15000)
        }
      };
      const result = sanitizeLogData(data);
      
      expect(result.nested.longField).toContain('[TRUNCATED]');
    });
  });

  describe('字段数量限制', () => {
    test('应限制单条日志字段数不超过 50 个', () => {
      const data = { level: 'info', message: 'test' };
      
      for (let i = 0; i < 60; i++) {
        data[`field${i}`] = `value${i}`;
      }
      
      const result = sanitizeLogData(data);
      
      // 检查非关键字段的数量
      const priorityKeys = ['timestamp', 'level', 'message', 'requestId'];
      const otherKeys = Object.keys(result).filter(k => !priorityKeys.includes(k) && k !== '_truncated_fields');
      
      expect(otherKeys.length).toBeLessThanOrEqual(50);
      expect(result._truncated_fields).toBe(true);
    });

    test('应优先保留关键字段', () => {
      const data = {
        level: 'info',
        message: 'test',
        requestId: 'req-123',
        timestamp: '2024-01-01T00:00:00Z',
        extra1: 'value1',
        extra2: 'value2'
      };
      
      const result = sanitizeLogData(data);
      
      expect(result.level).toBe('info');
      expect(result.message).toBe('test');
      expect(result.requestId).toBe('req-123');
      // src/logger.js: Date will be ISO string if it was a Date object, 
      // but here it's already a string. sanitizeLogData doesn't change it if it's already a string.
      expect(result.timestamp).toBe('2024-01-01T00:00:00Z'); 
      expect(result.extra1).toBe('value1');
      expect(result.extra2).toBe('value2');
    });

    test('应处理字段数不超过限制的情况', () => {
      const data = { level: 'info', message: 'test' };
      
      for (let i = 0; i < 30; i++) {
        data[`field${i}`] = `value${i}`;
      }
      
      const result = sanitizeLogData(data);
      
      const priorityKeys = ['timestamp', 'level', 'message', 'requestId'];
      const otherKeys = Object.keys(result).filter(k => !priorityKeys.includes(k) && k !== '_truncated_fields');
      
      expect(otherKeys.length).toBe(30);
      expect(result._truncated_fields).toBeUndefined();
    });
  });

  describe('深度限制', () => {
    test('应限制嵌套深度为 4 层', () => {
      const data = {
        level: 'info',
        message: 'test',
        level1: {
          level2: {
            level3: {
              level4: {
                level5: {
                  level6: 'too deep'
                }
              }
            }
          }
        }
      };
      
      const result = sanitizeLogData(data);
      
      // src/logger.js: depth > 4 截断
      // level1(1), level2(2), level3(3), level4(4), level5(5) -> 截断
      expect(result.level1.level2.level3.level4.level5).toBe('[DEPTH_EXCEEDED]');
    });

    test('应保留 4 层以内的嵌套', () => {
      const data = {
        level: 'info',
        message: 'test',
        level1: {
          level2: {
            level3: {
              level4: 'valid value'
            }
          }
        }
      };
      
      const result = sanitizeLogData(data);
      
      expect(result.level1.level2.level3.level4).toBe('valid value');
    });

    test('应处理数组中的深度嵌套', () => {
      const data = {
        level: 'info',
        message: 'test',
        items: [
          {
            nested: {
              deep: {
                deeper: {
                  deepest: 'value'
                }
              }
            }
          }
        ]
      };
      
      const result = sanitizeLogData(data);
      
      expect(result.items[0].nested.deep.deeper).toBe('[DEPTH_EXCEEDED]');
    });
  });

  describe('特殊值处理', () => {
    test('应正确处理 null 和 undefined', () => {
      const data = {
        level: 'info',
        message: 'test',
        nullField: null,
        undefinedField: undefined
      };
      
      const result = sanitizeLogData(data);
      
      expect(result.nullField).toBeNull();
      expect(result.undefinedField).toBeUndefined();
    });

    test('应处理特殊数据类型', () => {
      const data = {
        level: 'info',
        message: 'test',
        number: 123,
        boolean: true,
        date: new Date('2024-01-01T00:00:00Z'),
        func: function() { return 'test'; }
      };
      
      const result = sanitizeLogData(data);
      
      expect(result.number).toBe(123);
      expect(result.boolean).toBe(true);
      expect(result.date).toBe('2024-01-01T00:00:00.000Z');
      // In src/logger.js, typeof val !== 'object' returns val. 
      // Functions are not 'object', so it returns the function itself.
      // But Vitest might be seeing it as string if it was JSON stringified? No.
      expect(typeof result.func).toBe('function');
    });
  });
});

describe('Logger Safeguard - flushLogs', () => {
  beforeEach(() => {
    configureBaseLoggerTransport({
      AXIOM_TOKEN: 'test-token',
      AXIOM_DATASET: 'test-dataset',
      AXIOM_ORG_ID: 'test-org',
      NODE_ENV: 'test'
    });
    
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'OK'
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('应正常处理小体积 batch', async () => {
    const logBuffer = [
      { level: 'info', message: 'test1', timestamp: '2024-01-01T00:00:00Z' },
      { level: 'warn', message: 'test2', timestamp: '2024-01-01T00:00:01Z' }
    ];

    await flushLogs(logBuffer);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(logBuffer.length).toBe(0);
  });

  test('应处理大体积 batch 并进行截断', async () => {
    const largeLog = {
      level: 'info',
      message: 'x'.repeat(10000),
      data: 'y'.repeat(10000)
    };
    
    const logBuffer = [];
    for (let i = 0; i < 300; i++) {
      logBuffer.push({ ...largeLog, index: i });
    }

    await flushLogs(logBuffer);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(logBuffer.length).toBe(0);
    
    const callArgs = global.fetch.mock.calls[0];
    const body = callArgs[1].body;
    const bodySize = new TextEncoder().encode(body).length;
    expect(bodySize).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});

describe('Logger Safeguard - Integration', () => {
  beforeEach(() => {
    configureBaseLoggerTransport({
      AXIOM_TOKEN: 'test-token',
      AXIOM_DATASET: 'test-dataset',
      NODE_ENV: 'test'
    });
    
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'OK'
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('logger 方法应自动应用清洗逻辑', async () => {
    const longString = 'a'.repeat(15000);

    const testLogBuffer = [];
    const testLogger = logger.child({ logBuffer: testLogBuffer });

    await testLogger.info('test message', {
      longField: longString,
      nested: {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: 'too deep'
              }
            }
          }
        }
      }
    });

    expect(testLogBuffer.length).toBe(1);
    const logEntry = testLogBuffer[0];
    expect(logEntry.message).toBe('test message');
    expect(logEntry.longField.length).toBeLessThan(15000);
    expect(logEntry.longField).toContain('...[TRUNCATED]');
    // 检查深度截断
    expect(JSON.stringify(logEntry)).toContain('[DEPTH_EXCEEDED]');
  });
});

describe('Logger env field', () => {
  test('should include env field in info logs', async () => {
    const logBuffer = [];
    const testLogger = logger.child({ logBuffer: logBuffer, env: 'test' });
    await testLogger.info('test message', { custom: 'data' });
    expect(logBuffer[0].env).toBe('test');
  });

  test('should convert development to dev', async () => {
    const logBuffer = [];
    const testLogger = logger.child({ logBuffer: logBuffer, env: 'development' });
    await testLogger.info('test message', { custom: 'data' });
    expect(logBuffer[0].env).toBe('dev');
  });

  test('should convert staging to pre', async () => {
    const logBuffer = [];
    const testLogger = logger.child({ logBuffer: logBuffer, env: 'staging' });
    await testLogger.info('test message', { custom: 'data' });
    expect(logBuffer[0].env).toBe('pre');
  });

  test('should handle production environment', async () => {
    const logBuffer = [];
    const testLogger = logger.child({ logBuffer: logBuffer, env: 'production' });
    await testLogger.info('test message', { custom: 'data' });
    expect(logBuffer[0].env).toBe('prod');
  });
});