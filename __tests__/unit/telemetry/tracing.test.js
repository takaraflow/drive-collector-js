import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

// Ensure no NEW_RELIC_LICENSE_KEY is set so the no-op path is tested
const originalNrKey = process.env.NEW_RELIC_LICENSE_KEY;
delete process.env.NEW_RELIC_LICENSE_KEY;

describe('OTel Tracing Bootstrap (no-op path)', () => {
    let tracingModule;

    beforeEach(async () => {
        // Re-import the module fresh for each test
        vi.resetModules();
        delete process.env.NEW_RELIC_LICENSE_KEY;
        tracingModule = await import('../../../src/telemetry/tracing.js');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(() => {
        // Restore original env
        if (originalNrKey !== undefined) {
            process.env.NEW_RELIC_LICENSE_KEY = originalNrKey;
        }
    });

    it('should export otelSDK as null when no license key is set', () => {
        expect(tracingModule.otelSDK).toBeNull();
    });

    it('should export isOTelEnabled as false when no license key is set', () => {
        expect(tracingModule.isOTelEnabled).toBe(false);
    });

    it('should have shutdownOTel as a callable function', () => {
        expect(typeof tracingModule.shutdownOTel).toBe('function');
    });

    it('should have shutdownOTel resolve without error when SDK is null', async () => {
        // Should not throw — just a no-op
        await expect(tracingModule.shutdownOTel()).resolves.toBeUndefined();
    });

    it('should not load any OTel packages when no license key is set', () => {
        // If OTel packages were loaded, sdk would be non-null
        // This indirectly verifies the dynamic import guard works
        expect(tracingModule.otelSDK).toBeNull();
        expect(tracingModule.isOTelEnabled).toBe(false);
    });
});
