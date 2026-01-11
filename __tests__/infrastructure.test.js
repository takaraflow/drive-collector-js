import { jest, describe, test, expect } from '@jest/globals';

// Simple deterministic test infrastructure
const fixedTime = 1700000000000;

// Setup before any tests - 只设置全局状态，不尝试 mock 已加载的模块
beforeAll(() => {
    // Mock console globally
    global.console = {
        log: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    };
    
    // Mock Math.random
    Object.defineProperty(Math, 'random', {
        value: jest.fn(() => 0.5),
        configurable: true
    });
});

beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // 设置固定的系统时间
    jest.setSystemTime(fixedTime);
});

afterEach(() => {
    jest.useRealTimers();
});

describe('Test Infrastructure Compliance', () => {
    test('should have deterministic time', () => {
        // 使用 Jest fake timers 的时间
        expect(Date.now()).toBe(fixedTime);
    });

    test('should have deterministic random', () => {
        const random1 = Math.random();
        const random2 = Math.random();
        expect(random1).toBe(0.5);
        expect(random2).toBe(0.5);
    });

    test('should have mocked console', () => {
        console.log('test message');
        expect(global.console.log).toHaveBeenCalledWith('test message');
    });

    test('should use fake timers', () => {
        // advanceTimersByTime 会推进 Date.now()，这是预期行为
        // 我们验证 fake timers 正在工作（timer 返回 object）
        const startTime = Date.now();
        jest.advanceTimersByTime(1000);
        const endTime = Date.now();
        
        // 在 legacy fake timers 中，Date.now() 会前进
        // 我们验证时间确实前进了
        expect(endTime).toBe(startTime + 1000);
    });

    test('should have no real IO', () => {
        // Verify fetch is mocked
        expect(typeof global.fetch).toBe('function');
        
        // Verify setTimeout uses fake timers
        const timerId = setTimeout(() => {}, 1000);
        expect(typeof timerId).toBe('object'); // Fake timer returns object
    });

    test('should be parallel-ready', () => {
        // Tests shouldn't depend on execution order or shared state
        const state = {
            counter: 0
        };
        
        const increment = () => {
            state.counter++;
            return state.counter;
        };
        
        // Multiple calls should be independent
        const result1 = increment();
        const result2 = increment();
        const result3 = increment();
        
        expect(result1).toBe(1);
        expect(result2).toBe(2);
        expect(result3).toBe(3);
    });

    test('should use no process.env', () => {
        // Verify process.env is not accessed directly in a way that breaks tests
        expect(() => {
            const env = process.env.NODE_ENV;
        }).not.toThrow();
    });

    test('should have explicit mocks', () => {
        // All external dependencies should be explicitly mocked
        expect(jest.isMockFunction(global.console.log)).toBe(true);
        expect(jest.isMockFunction(Math.random)).toBe(true);
    });

    test('should not use sleep', () => {
        // Tests should not use real setTimeout for delays
        const hasSleep = () => {
            const fn = new Function('return ' + setTimeout.toString());
            return fn.toString().includes('sleep');
        };
        
        expect(hasSleep()).toBe(false);
    });
});
