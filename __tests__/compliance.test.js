import { jest, describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { setupTimeMocks, cleanupTimeMocks, mockDateNow, fixedTime } from './setup/timeMocks.js';

// Set minimal Jest config
beforeEach(() => {
    jest.clearAllMocks();
    setupTimeMocks();

    // Mock console per test
    global.console = {
        log: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn()
    };
    
    // Ensure deterministic random
    Object.defineProperty(Math, 'random', {
        value: jest.fn(() => 0.5),
        configurable: true
    });
});

afterEach(() => {
    cleanupTimeMocks();
    jest.clearAllMocks();
});

describe('Compliance Test Suite', () => {
    test('should pass simple math operation', () => {
        expect(2 + 2).toBe(4);
    });

    test('should handle string operations', () => {
        expect('hello'.toUpperCase()).toBe('HELLO');
    });

    test('should handle boolean logic', () => {
        expect(true && false).toBe(false);
        expect(true || false).toBe(true);
        expect(!true).toBe(false);
    });

    test('should handle array operations', () => {
        const arr = [1, 2, 3];
        expect(arr.length).toBe(3);
        expect(arr.indexOf(2)).toBe(1);
    });

    test('should handle object operations', () => {
        const obj = { name: 'test', value: 42 };
        expect(obj.name).toBe('test');
        expect(obj.value).toBe(42);
    });

    test('should handle async operations', async () => {
        const promise = Promise.resolve('async-result');
        const result = await promise;
        expect(result).toBe('async-result');
    });

    test('should handle error scenarios', () => {
        expect(() => {
            throw new Error('test error');
        }).toThrow('test error');
    });

    test('should use deterministic random', () => {
        const random1 = Math.random();
        const random2 = Math.random();
        expect(random1).toBe(0.5);
        expect(random2).toBe(0.5);
    });

    test('should use fake timers', () => {
        // Set a known starting point
        jest.setSystemTime(fixedTime);
        
        const startTime = Date.now();
        expect(startTime).toBe(fixedTime);
        
        // Without advancing timers, time should remain stable
        const currentTime = Date.now();
        expect(currentTime).toBe(startTime);
        
        // When we advance timers, Date.now() should advance accordingly
        jest.advanceTimersByTime(1000);
        const endTime = Date.now();
        expect(endTime).toBeGreaterThan(startTime); // Should be greater after advance
        
        // Verify the time advanced by exactly the amount we requested
        expect(endTime - startTime).toBe(1000);
    });

    test('should use mocked console', () => {
        console.log('test message');
        expect(global.console.log).toHaveBeenCalledWith('test message');
    });
});
