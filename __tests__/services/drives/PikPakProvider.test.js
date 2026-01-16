/**
 * PikPakProvider Test
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { PikPakProvider } from '../../../src/services/drives/PikPakProvider.js';
import { BindingStep, ActionResult } from '../../../src/services/drives/BaseDriveProvider.js';

vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        withModule: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })
    }
}));

vi.mock('../../../src/services/rclone.js', () => ({
    CloudTool: {
        validateConfig: vi.fn(),
        _obscure: vi.fn((password) => `obscured_${password}`)
    }
}));

describe('PikPakProvider', () => {
    let provider;
    beforeEach(() => {
        vi.clearAllMocks();
        provider = new PikPakProvider();
    });

    test('should have correct type', () => {
        expect(provider.type).toBe('pikpak');
    });

    test('should return correct binding steps', () => {
        const steps = provider.getBindingSteps();
        expect(steps).toHaveLength(2);
        expect(steps[0].step).toBe('WAIT_USER');
        expect(steps[1].step).toBe('WAIT_PASS');
    });

    test('should handle user input', async () => {
        const result = await provider.handleInput('WAIT_USER', 'user', {});
        expect(result.success).toBe(true);
        expect(result.nextStep).toBe('WAIT_PASS');
        expect(result.data.user).toBe('user');
    });

    test('should generate connection string', () => {
        const conn = provider.getConnectionString({ user: 'u', pass: 'p' });
        expect(conn).toBe(':pikpak,user="u",pass="p":');
    });
});
