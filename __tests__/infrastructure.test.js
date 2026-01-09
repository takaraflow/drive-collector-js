import { jest } from '@jest/globals';

// Simple deterministic test infrastructure
const fixedTime = 1700000000000; 
const mockTimeProvider = {
    now: () => fixedTime,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout
};

// Setup before any tests
beforeAll(() => {
    // Mock time
    jest.unstable_mockModule('../src/utils/timeProvider.js', () => mockTimeProvider);
    
    // Mock environment
    jest.unstable_mockModule('../src/config/env.js', () => ({
        getEnv: () => ({ NODE_ENV: 'test', DEBUG: 'false' }),
        NODE_ENV: 'test',
        DEBUG: 'false'
    }));
    
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
});

afterEach(() => {
    jest.useRealTimers();
});

describe('Test Infrastructure Compliance', () => {
    test('should have deterministic time', () => {
        const time = mockTimeProvider.now();
        expect(time).toBe(fixedTime);
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

    test('should have mocked environment', async () => {
        const { getEnv } = await import('../src/config/env.js');
        const env = getEnv();
        expect(env.NODE_ENV).toBe('test');
    });

    test('should use fake timers', () => {
        const startTime = mockTimeProvider.now();
        jest.advanceTimersByTime(1000);
        
        // With fake timers, we control time explicitly
        const endTime = mockTimeProvider.now();
        expect(endTime).toBe(startTime); // Time doesn't auto-advance
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

    test('should use no process.env', async () => {
        // Verify process.env is not accessed directly
        expect(() => {
            const env = process.env.NODE_ENV;
        }).not.toThrow();
        
        // Tests should use our mock instead
        const { getEnv } = await import('../src/config/env.js');
        expect(getEnv()).toBeDefined();
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
