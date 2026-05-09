import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getBeijingTimestamp, getBeijingISOString } from '../../../src/utils/timeUtils.js';

describe('timeUtils', () => {
    // 2024-01-01T12:00:00.000Z
    const fixedTime = 1704110400000;
    const originalTZ = process.env.TZ;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(fixedTime);
    });

    afterEach(() => {
        vi.useRealTimers();
        process.env.TZ = originalTZ;
    });

    describe('getBeijingTimestamp', () => {
        it('should format correctly in UTC', () => {
            process.env.TZ = 'UTC';
            const result = getBeijingTimestamp();
            expect(result).toBe('2024-01-01 20:00:00');
        });

        it('should format correctly in America/New_York', () => {
            process.env.TZ = 'America/New_York';
            const result = getBeijingTimestamp();
            expect(result).toBe('2024-01-01 20:00:00');
        });

        it('should format correctly in Asia/Shanghai', () => {
            process.env.TZ = 'Asia/Shanghai';
            const result = getBeijingTimestamp();
            expect(result).toBe('2024-01-01 20:00:00');
        });
    });

    describe('getBeijingISOString', () => {
        it('should format correctly in UTC', () => {
            process.env.TZ = 'UTC';
            const result = getBeijingISOString();
            expect(result).toBe('2024-01-01T20:00:00.000+08:00');
        });

        it('should format correctly in America/New_York', () => {
            process.env.TZ = 'America/New_York';
            const result = getBeijingISOString();
            expect(result).toBe('2024-01-01T20:00:00.000+08:00');
        });

        it('should format correctly in Asia/Shanghai', () => {
            process.env.TZ = 'Asia/Shanghai';
            const result = getBeijingISOString();
            expect(result).toBe('2024-01-01T20:00:00.000+08:00');
        });
    });
});
