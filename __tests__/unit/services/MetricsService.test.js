import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsService } from '../../../src/services/MetricsService.js';

describe('MetricsService', () => {
    let metricsService;

    beforeEach(() => {
        metricsService = new MetricsService();
    });

    describe('Initialization', () => {
        it('should initialize counters, gauges, and timings as empty Maps', () => {
            expect(metricsService.counters).toBeInstanceOf(Map);
            expect(metricsService.counters.size).toBe(0);

            expect(metricsService.gauges).toBeInstanceOf(Map);
            expect(metricsService.gauges.size).toBe(0);

            expect(metricsService.timings).toBeInstanceOf(Map);
            expect(metricsService.timings.size).toBe(0);
        });
    });

    describe('Counters', () => {
        it('should initialize a counter with 1 if no value is provided', () => {
            metricsService.increment('test_counter');
            expect(metricsService.getCounter('test_counter')).toBe(1);
        });

        it('should increment an existing counter', () => {
            metricsService.increment('test_counter');
            metricsService.increment('test_counter');
            expect(metricsService.getCounter('test_counter')).toBe(2);
        });

        it('should increment by a specific value', () => {
            metricsService.increment('test_counter', 5);
            expect(metricsService.getCounter('test_counter')).toBe(5);
            metricsService.increment('test_counter', 3);
            expect(metricsService.getCounter('test_counter')).toBe(8);
        });

        it('should return undefined for non-existent counter', () => {
            expect(metricsService.getCounter('non_existent')).toBeUndefined();
        });
    });

    describe('Gauges', () => {
        it('should set a gauge value', () => {
            metricsService.gauge('test_gauge', 10);
            expect(metricsService.getGauge('test_gauge')).toBe(10);
        });

        it('should overwrite an existing gauge value', () => {
            metricsService.gauge('test_gauge', 10);
            metricsService.gauge('test_gauge', 20);
            expect(metricsService.getGauge('test_gauge')).toBe(20);
        });

        it('should return undefined for non-existent gauge', () => {
            expect(metricsService.getGauge('non_existent')).toBeUndefined();
        });
    });

    describe('Timings', () => {
        it('should record multiple timings for the same metric', () => {
            metricsService.timing('test_timing', 100);
            metricsService.timing('test_timing', 200);
            metricsService.timing('test_timing', 300);

            // Check internal map to ensure values are appended properly
            expect(metricsService.timings.get('test_timing')).toEqual([100, 200, 300]);
        });
    });

    describe('getMetrics', () => {
        it('should return an object with counters, gauges, and timings', () => {
            const currentMetrics = metricsService.getMetrics();
            expect(currentMetrics).toHaveProperty('counters');
            expect(currentMetrics).toHaveProperty('gauges');
            expect(currentMetrics).toHaveProperty('timings');
        });

        it('should correctly calculate timing statistics', () => {
            metricsService.timing('api_call', 100);
            metricsService.timing('api_call', 200);
            metricsService.timing('api_call', 150);

            const currentMetrics = metricsService.getMetrics();
            const stats = currentMetrics.timings.api_call;

            expect(stats.count).toBe(3);
            expect(stats.total).toBe(450);
            expect(stats.average).toBe(150);
            expect(stats.min).toBe(100);
            expect(stats.max).toBe(200);
        });

        it('should round average timing to 2 decimal places', () => {
            metricsService.timing('precise_call', 10);
            metricsService.timing('precise_call', 10);
            metricsService.timing('precise_call', 11); // sum 31, avg 10.3333...

            const currentMetrics = metricsService.getMetrics();
            expect(currentMetrics.timings.precise_call.average).toBe(10.33);
        });

        it('should handle timings with no durations gracefully (should not appear in timings result if empty array)', () => {
            // Internally set empty array to simulate state
            metricsService.timings.set('empty_timing', []);
            const currentMetrics = metricsService.getMetrics();

            // The method checks `if (durations.length > 0)`
            expect(currentMetrics.timings.empty_timing).toBeUndefined();
        });

        it('should serialize counters and gauges correctly', () => {
            metricsService.increment('counter1', 5);
            metricsService.gauge('gauge1', 15);

            const currentMetrics = metricsService.getMetrics();
            expect(currentMetrics.counters).toEqual({ counter1: 5 });
            expect(currentMetrics.gauges).toEqual({ gauge1: 15 });
        });
    });

    describe('reset', () => {
        it('should clear all metrics', () => {
            metricsService.increment('test_counter');
            metricsService.gauge('test_gauge', 10);
            metricsService.timing('test_timing', 100);

            metricsService.reset();

            expect(metricsService.counters.size).toBe(0);
            expect(metricsService.gauges.size).toBe(0);
            expect(metricsService.timings.size).toBe(0);

            const currentMetrics = metricsService.getMetrics();
            expect(currentMetrics.counters).toEqual({});
            expect(currentMetrics.gauges).toEqual({});
            expect(currentMetrics.timings).toEqual({});
        });
    });
});
