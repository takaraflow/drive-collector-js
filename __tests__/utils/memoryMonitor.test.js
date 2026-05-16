import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkMemoryPressure, startMemoryMonitor, stopMemoryMonitor } from '../../src/utils/memoryMonitor.js';

describe('MemoryMonitor', () => {
    let warnSpy;
    let memoryUsageSpy;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        memoryUsageSpy = vi.spyOn(process, 'memoryUsage').mockReturnValue({
            heapUsed: 100 * 1024 * 1024,
            heapTotal: 200 * 1024 * 1024,
            external: 0,
            arrayBuffers: 0,
            rss: 0
        });
        process.env.NODE_OPTIONS = '--max-old-space-size=200';
    });

    afterEach(() => {
        vi.restoreAllMocks();
        stopMemoryMonitor();
        delete process.env.NODE_OPTIONS;
    });

    describe('checkMemoryPressure', () => {
        it('should return correct memory stats without warnings when heap is healthy', () => {
            memoryUsageSpy.mockReturnValueOnce({ heapUsed: 100 * 1024 * 1024 }); // 50%
            const result = checkMemoryPressure();
            expect(warnSpy).not.toHaveBeenCalled();
            expect(result.heapRatio).toBe(0.5);
        });

        it('should warn when heap usage is above warning ratio', () => {
            memoryUsageSpy.mockReturnValueOnce({ heapUsed: 160 * 1024 * 1024 }); // 80%
            checkMemoryPressure();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('⚠️ Memory pressure'));
        });

        it('should warn and suggest --expose-gc when critical without global.gc', () => {
            memoryUsageSpy.mockReturnValueOnce({ heapUsed: 190 * 1024 * 1024 }); // 95%
            const originalGc = global.gc;
            delete global.gc;

            checkMemoryPressure();

            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('🚨 Memory critical'));
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Add --expose-gc'));

            global.gc = originalGc;
        });

        it('should call global.gc and warn when critical with global.gc available', () => {
            const mockGc = vi.fn();
            global.gc = mockGc;

            // Initial call returns 95%, second call (after gc) returns 50%
            memoryUsageSpy
                .mockReturnValueOnce({ heapUsed: 190 * 1024 * 1024 })
                .mockReturnValueOnce({ heapUsed: 100 * 1024 * 1024 });

            checkMemoryPressure();

            expect(mockGc).toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('🚨 内存紧急'));
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('GC后 100.0MB'));

            delete global.gc;
        });
    });

    describe('startMemoryMonitor / stopMemoryMonitor', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should not start monitor if NODE_OPTIONS lacks max-old-space-size', () => {
            process.env.NODE_OPTIONS = '';
            startMemoryMonitor(1000);

            memoryUsageSpy.mockClear();
            vi.advanceTimersByTime(2000);

            expect(memoryUsageSpy).not.toHaveBeenCalled();
        });

        it('should start monitor and check memory periodically', () => {
            startMemoryMonitor(1000);

            memoryUsageSpy.mockClear();
            vi.advanceTimersByTime(2500);

            expect(memoryUsageSpy).toHaveBeenCalledTimes(2);
        });

        it('should stop monitor', () => {
            startMemoryMonitor(1000);
            stopMemoryMonitor();

            memoryUsageSpy.mockClear();
            vi.advanceTimersByTime(2500);

            expect(memoryUsageSpy).not.toHaveBeenCalled();
        });
    });
});
