/**
 * MegaProvider 测试
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MegaProvider } from '../../../src/services/drives/MegaProvider.js';
import { BindingStep, ActionResult, ValidationResult } from '../../../src/services/drives/BaseDriveProvider.js';

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

describe('MegaProvider', () => {
    let provider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new MegaProvider();
    });

    describe('Basic Properties', () => {
        test('should have correct type and name', () => {
            expect(provider.type).toBe('mega');
            expect(provider.name).toBe('Mega 网盘');
        });

        test('should return correct provider info', () => {
            const info = provider.getInfo();

            expect(info.type).toBe('mega');
            expect(info.name).toBe('Mega 网盘');
        });
    });

    describe('Binding Steps', () => {
        test('should return correct binding steps', () => {
            const steps = provider.getBindingSteps();

            expect(steps).toHaveLength(2);
            expect(steps[0]).toBeInstanceOf(BindingStep);
            expect(steps[0].step).toBe('WAIT_EMAIL');
            expect(steps[0].prompt).toBe('input_email');
            expect(steps[1].step).toBe('WAIT_PASS');
            expect(steps[1].prompt).toBe('input_pass');
        });

        test('should have email validator on first step', () => {
            const steps = provider.getBindingSteps();

            expect(steps[0].validator).toBeDefined();
            expect(typeof steps[0].validator).toBe('function');
        });
    });

    describe('Email Validation', () => {
        test('should validate correct email', () => {
            const result = provider._validateEmail('test@example.com');

            expect(result.valid).toBe(true);
        });

        test('should reject email without @', () => {
            const result = provider._validateEmail('invalid-email');

            expect(result.valid).toBe(false);
            expect(result.message).toBeDefined();
        });

        test('should reject empty email', () => {
            const result = provider._validateEmail('');

            expect(result.valid).toBe(false);
        });

        test('should reject null email', () => {
            const result = provider._validateEmail(null);

            expect(result.valid).toBe(false);
        });
    });

    describe('Handle Input - Email Step', () => {
        test('should handle valid email input', async () => {
            const result = await provider.handleInput('WAIT_EMAIL', 'user@mega.nz', {});

            expect(result).toBeInstanceOf(ActionResult);
            expect(result.success).toBe(true);
            expect(result.nextStep).toBe('WAIT_PASS');
            expect(result.data.email).toBe('user@mega.nz');
        });

        test('should reject invalid email input', async () => {
            const result = await provider.handleInput('WAIT_EMAIL', 'not-an-email', {});

            expect(result.success).toBe(false);
        });

        test('should trim email input', async () => {
            const result = await provider.handleInput('WAIT_EMAIL', '  user@mega.nz  ', {});

            expect(result.success).toBe(true);
            expect(result.data.email).toBe('user@mega.nz');
        });
    });

    describe('Handle Input - Password Step', () => {
        test('should handle valid password with successful validation', async () => {
            const { CloudTool } = await import('../../../src/services/rclone.js');
            CloudTool.validateConfig.mockResolvedValue({ success: true });

            const session = { data: { email: 'user@mega.nz' } };
            const result = await provider.handleInput('WAIT_PASS', 'password123', session);

            expect(result).toBeInstanceOf(ActionResult);
            expect(result.success).toBe(true);
            expect(result.data.user).toBe('user@mega.nz');
            expect(result.data.pass).toBe('password123');
        });

        test('should reject password when no email in session', async () => {
            const session = { data: {} };
            const result = await provider.handleInput('WAIT_PASS', 'password123', session);

            expect(result.success).toBe(false);
        });

        test('should handle validation failure', async () => {
            const { CloudTool } = await import('../../../src/services/rclone.js');
            CloudTool.validateConfig.mockResolvedValue({
                success: false,
                reason: 'LOGIN_FAILED',
                details: "couldn't login"
            });

            const session = { data: { email: 'user@mega.nz' } };
            const result = await provider.handleInput('WAIT_PASS', 'wrongpassword', session);

            expect(result.success).toBe(false);
            expect(result.message).toContain('绑定失败');
        });

        test('should handle 2FA error', async () => {
            const { CloudTool } = await import('../../../src/services/rclone.js');
            CloudTool.validateConfig.mockResolvedValue({
                success: false,
                reason: '2FA',
                details: 'Two-factor authentication required'
            });

            const session = { data: { email: 'user@mega.nz' } };
            const result = await provider.handleInput('WAIT_PASS', 'password123', session);

            expect(result.success).toBe(false);
            expect(result.message).toContain('2FA');
        });
    });

    describe('Handle Input - Unknown Step', () => {
        test('should return error for unknown step', async () => {
            const result = await provider.handleInput('UNKNOWN_STEP', 'input', {});

            expect(result.success).toBe(false);
            expect(result.message).toBe('未知步骤');
        });
    });

    describe('Validate Config', () => {
        test('should call CloudTool.validateConfig with correct parameters', async () => {
            const { CloudTool } = await import('../../../src/services/rclone.js');
            CloudTool.validateConfig.mockResolvedValue({ success: true });

            await provider.validateConfig({ user: 'test@example.com', pass: 'password' });

            expect(CloudTool.validateConfig).toHaveBeenCalledWith('mega', {
                user: 'test@example.com',
                pass: 'obscured_password'
            });
        });

        test('should return success ValidationResult on valid config', async () => {
            const { CloudTool } = await import('../../../src/services/rclone.js');
            CloudTool.validateConfig.mockResolvedValue({ success: true });

            const result = await provider.validateConfig({ user: 'test@example.com', pass: 'password' });

            expect(result).toBeInstanceOf(ValidationResult);
            expect(result.success).toBe(true);
        });

        test('should return failure ValidationResult on invalid config', async () => {
            const { CloudTool } = await import('../../../src/services/rclone.js');
            CloudTool.validateConfig.mockResolvedValue({
                success: false,
                reason: 'LOGIN_FAILED',
                details: 'Invalid credentials'
            });

            const result = await provider.validateConfig({ user: 'test@example.com', pass: 'wrong' });

            expect(result.success).toBe(false);
            expect(result.reason).toBe('LOGIN_FAILED');
            expect(result.details).toBe('Invalid credentials');
        });

        test('should handle errors during validation', async () => {
            const { CloudTool } = await import('../../../src/services/rclone.js');
            CloudTool.validateConfig.mockRejectedValue(new Error('Network error'));

            const result = await provider.validateConfig({ user: 'test@example.com', pass: 'password' });

            expect(result.success).toBe(false);
            expect(result.reason).toBe('ERROR');
            expect(result.details).toBe('Network error');
        });
    });

    describe('Process Password', () => {
        test('should obscure password using CloudTool', () => {
            const result = provider.processPassword('myPassword');

            expect(result).toBe('obscured_myPassword');
        });
    });

    describe('Get Error Message', () => {
        test('should return 2FA error message', () => {
            const message = provider.getErrorMessage('2FA');

            expect(message).toContain('两步验证');
        });

        test('should return login failed error message', () => {
            const message = provider.getErrorMessage('LOGIN_FAILED');

            expect(message).toContain('登录失败');
        });

        test('should return network error message', () => {
            const message = provider.getErrorMessage('NETWORK_ERROR');

            expect(message).toBeDefined();
        });

        test('should return unknown error message for unrecognized type', () => {
            const message = provider.getErrorMessage('SOME_OTHER_ERROR');

            expect(message).toBeDefined();
        });
    });

    describe('Connection String', () => {
        test('should generate correct connection string', () => {
            const connStr = provider.getConnectionString({
                user: 'test@mega.nz',
                pass: 'password123'
            });

            expect(connStr).toBe(':mega,user="test@mega.nz",pass="password123":');
        });

        test('should escape special characters in connection string', () => {
            const connStr = provider.getConnectionString({
                user: 'test"user@mega.nz',
                pass: 'pass\\word'
            });

            expect(connStr).toBe(':mega,user="test\\"user@mega.nz",pass="pass\\\\word":');
        });
    });
});