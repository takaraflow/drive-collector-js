import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import timeProvider, { TimeProvider } from '../../../src/utils/timeProvider.js';

describe('TimeProvider', () => {
    let provider;

    beforeEach(() => {
        provider = new TimeProvider();
    });

    describe('Core Time Management', () => {
        it('should initialize with a fixed timestamp', () => {
            expect(provider.getTime()).toBe(1700000000000);
        });

        it('should allow setting the time', () => {
            provider.setTime(1600000000000);
            expect(provider.getTime()).toBe(1600000000000);
        });

        it('should allow advancing the time', () => {
            provider.setTime(1600000000000);
            provider.advanceTime(5000);
            expect(provider.getTime()).toBe(1600000005000);
        });
    });

    describe('Date Helpers', () => {
        it('now() should return the current time', () => {
            provider.setTime(1600000000000);
            expect(provider.now()).toBe(1600000000000);
            provider.advanceTime(1000);
            expect(provider.now()).toBe(1600000001000);
        });

        it('nowAsDate() should return a Date object for the current time', () => {
            provider.setTime(1600000000000);
            const date = provider.nowAsDate();
            expect(date).toBeInstanceOf(Date);
            expect(date.getTime()).toBe(1600000000000);
        });

        it('formatTimestamp() should return an ISO string of the current time', () => {
            provider.setTime(1600000000000);
            const isoString = provider.formatTimestamp();
            expect(isoString).toBe(new Date(1600000000000).toISOString());
        });
    });

    describe('Timer Methods', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('setTimeout and clearTimeout should work', () => {
            const callback = vi.fn();
            const timeoutId = provider.setTimeout(callback, 1000);

            expect(callback).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1000);
            expect(callback).toHaveBeenCalledTimes(1);

            // Test clear
            const callback2 = vi.fn();
            const timeoutId2 = provider.setTimeout(callback2, 1000);
            provider.clearTimeout(timeoutId2);
            vi.advanceTimersByTime(1000);
            expect(callback2).not.toHaveBeenCalled();
        });

        it('setInterval and clearInterval should work', () => {
            const callback = vi.fn();
            const intervalId = provider.setInterval(callback, 1000);

            expect(callback).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1000);
            expect(callback).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(1000);
            expect(callback).toHaveBeenCalledTimes(2);

            provider.clearInterval(intervalId);
            vi.advanceTimersByTime(1000);
            expect(callback).toHaveBeenCalledTimes(2); // Should not increase
        });
    });

    describe('Singleton Instance', () => {
        it('should export a singleton instance with default time', () => {
            expect(timeProvider.getTime()).toBe(1700000000000);
        });

        it('should share state when singleton is modified', () => {
            timeProvider.setTime(100);
            expect(timeProvider.getTime()).toBe(100);
            // Reset for other potential tests using the singleton
            timeProvider.setTime(1700000000000);
        });
    });
});
