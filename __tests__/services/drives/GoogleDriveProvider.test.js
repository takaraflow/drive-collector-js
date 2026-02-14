/**
 * GoogleDriveProvider 测试
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock logger
vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        withModule: () => ({
            info: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            warn: vi.fn()
        })
    }
}));

// Mock CloudTool
vi.mock('../../../src/services/rclone.js', () => ({
    CloudTool: {
        validateConfig: vi.fn(),
        _obscure: vi.fn((password) => `obscured_${password}`)
    }
}));

import { GoogleDriveProvider } from '../../../src/services/drives/GoogleDriveProvider.js';
import { BindingStep, ActionResult, ValidationResult } from '../../../src/services/drives/BaseDriveProvider.js';

describe('GoogleDriveProvider', () => {
    let provider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new GoogleDriveProvider();
    });

    describe('Basic Properties', () => {
        test('should have correct type and name', () => {
            expect(provider.type).toBe('google_drive');
            expect(provider.name).toBe('Google Drive');
        });
    });

    describe('Binding Steps', () => {
        test('should return correct binding steps', () => {
            const steps = provider.getBindingSteps();

            expect(steps).toHaveLength(1);
            expect(steps[0]).toBeInstanceOf(BindingStep);
            expect(steps[0].step).toBe('WAIT_TOKEN');
            expect(steps[0].prompt).toBe('input_token');
            expect(typeof steps[0].validator).toBe('function');
        });
    });

    describe('Token Validation', () => {
        test('should validate correct json token', () => {
            const token = JSON.stringify({ access_token: "abc", refresh_token: "def" });
            const result = provider._validateToken(token);

            expect(result.valid).toBe(true);
        });

        test('should reject non-json token', () => {
            const result = provider._validateToken('not-a-json');

            expect(result.valid).toBe(false);
        });

        test('should reject token without access_token', () => {
            const token = JSON.stringify({ foo: "bar" });
            const result = provider._validateToken(token);

            expect(result.valid).toBe(false);
        });
    });

    describe('Handle Input - Token Step', () => {
        test('should handle valid token input', async () => {
            const { CloudTool } = await import('../../../src/services/rclone.js');
            CloudTool.validateConfig.mockResolvedValue({ success: true });

            const tokenObj = { access_token: "abc", refresh_token: "def" };
            const tokenStr = JSON.stringify(tokenObj);
            
            const result = await provider.handleInput('WAIT_TOKEN', tokenStr, {});

            expect(result).toBeInstanceOf(ActionResult);
            expect(result.success).toBe(true);
            expect(result.data.token).toBe(tokenStr);
        });

        test('should reject invalid token input', async () => {
            const result = await provider.handleInput('WAIT_TOKEN', 'invalid', {});

            expect(result.success).toBe(false);
        });

        test('should handle validation failure from CloudTool', async () => {
            const { CloudTool } = await import('../../../src/services/rclone.js');
            CloudTool.validateConfig.mockResolvedValue({
                success: false,
                reason: 'TOKEN_INVALID',
                details: "Token expired"
            });

            const tokenStr = JSON.stringify({ access_token: "abc" });
            const result = await provider.handleInput('WAIT_TOKEN', tokenStr, {});

            expect(result.success).toBe(false);
            expect(result.message).toContain('Token 无效');
        });
    });

    describe('Connection String', () => {
        test('should generate correct connection string with token', () => {
            const token = '{"access_token":"123"}';
            const connStr = provider.getConnectionString({
                token: token
            });

            // " in token should be escaped to \"
            // And since token is wrapped in ", the internal quotes are escaped.
            // wait, token is '{"access_token":"123"}'
            // replace " with \" => '{\"access_token\":\"123\"}'
            // result: :drive,token="{\"access_token\":\"123\"}":
            
            const escapedToken = '{\\"access_token\\":\\"123\\"}';
            expect(connStr).toBe(`:drive,token="${escapedToken}":`);
        });
    });
});
