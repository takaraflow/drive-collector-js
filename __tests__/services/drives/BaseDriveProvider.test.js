/**
 * BaseDriveProvider 抽象基类测试
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

// Mock logger - must be before imports
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

import { BaseDriveProvider, BindingStep, ActionResult, ValidationResult } from '../../../src/services/drives/BaseDriveProvider.js';

describe('BaseDriveProvider', () => {
    let TestProvider;

    beforeEach(() => {
        TestProvider = class extends BaseDriveProvider {
            constructor() {
                super('test', 'Test Drive');
            }

            getBindingSteps() {
                return [
                    new BindingStep('WAIT_INPUT', 'Please enter input')
                ];
            }

            async handleInput(step, input, session) {
                if (step === 'WAIT_INPUT') {
                    return new ActionResult(true, 'Input received', null, { input });
                }
                return new ActionResult(false, 'Unknown step');
            }

            async validateConfig(configData) {
                if (configData.user && configData.pass) {
                    return new ValidationResult(true);
                }
                return new ValidationResult(false, 'INVALID', 'Missing credentials');
            }
        };
    });

    test('should not allow direct instantiation of BaseDriveProvider', () => {
        expect(() => new BaseDriveProvider('test', 'Test')).toThrow('BaseDriveProvider is abstract');
    });

    test('should create provider instance with type and name', () => {
        const provider = new TestProvider();

        expect(provider.type).toBe('test');
        expect(provider.name).toBe('Test Drive');
    });

    test('should return provider info', () => {
        const provider = new TestProvider();
        const info = provider.getInfo();

        expect(info.type).toBe('test');
        expect(info.name).toBe('Test Drive');
    });

    test('should return binding steps', () => {
        const provider = new TestProvider();
        const steps = provider.getBindingSteps();

        expect(steps).toHaveLength(1);
        expect(steps[0].step).toBe('WAIT_INPUT');
        expect(steps[0].prompt).toBe('Please enter input');
    });

    test('should handle input correctly', async () => {
        const provider = new TestProvider();
        const result = await provider.handleInput('WAIT_INPUT', 'test input', {});

        expect(result.success).toBe(true);
        expect(result.message).toBe('Input received');
        expect(result.data.input).toBe('test input');
    });

    test('should validate config correctly', async () => {
        const provider = new TestProvider();

        const validResult = await provider.validateConfig({ user: 'test@example.com', pass: 'password' });
        expect(validResult.success).toBe(true);

        const invalidResult = await provider.validateConfig({ user: '' });
        expect(invalidResult.success).toBe(false);
        expect(invalidResult.reason).toBe('INVALID');
    });

    test('should throw error for unimplemented abstract methods', async () => {
        const MinimalProvider = class extends BaseDriveProvider {
            constructor() {
                super('minimal', 'Minimal');
            }
        };

        const provider = new MinimalProvider();

        expect(() => provider.getBindingSteps()).toThrow('getBindingSteps() must be implemented');
        await expect(provider.handleInput('step', 'input', {})).rejects.toThrow('handleInput() must be implemented');
        await expect(provider.validateConfig({})).rejects.toThrow('validateConfig() must be implemented');
    });

    test('should provide default processPassword implementation', async () => {
        const provider = new TestProvider();
        const password = 'myPassword123';

        expect(await provider.processPassword(password)).toBe(password);
    });

    test('should provide default getErrorMessage implementation', () => {
        const provider = new TestProvider();

        expect(provider.getErrorMessage('UNKNOWN')).toBe('未知错误');
    });

    test('should generate connection string correctly', () => {
        const provider = new TestProvider();
        const connStr = provider.getConnectionString({ user: 'test@example.com', pass: 'password123' });

        expect(connStr).toBe(':test,user="test@example.com",pass="password123":');
    });

    test('should escape special characters in connection string', () => {
        const provider = new TestProvider();
        const connStr = provider.getConnectionString({ user: 'test"user', pass: 'pass\\word' });

        expect(connStr).toBe(':test,user="test\\"user",pass="pass\\\\word":');
    });
});

describe('BindingStep', () => {
    test('should create BindingStep with all properties', () => {
        const validator = (input) => ({ valid: true });
        const step = new BindingStep('WAIT_EMAIL', 'Enter email', validator);

        expect(step.step).toBe('WAIT_EMAIL');
        expect(step.prompt).toBe('Enter email');
        expect(step.validator).toBe(validator);
    });

    test('should create BindingStep without validator', () => {
        const step = new BindingStep('WAIT_PASS', 'Enter password');

        expect(step.step).toBe('WAIT_PASS');
        expect(step.prompt).toBe('Enter password');
        expect(step.validator).toBeNull();
    });
});

describe('ActionResult', () => {
    test('should create ActionResult with all properties', () => {
        const result = new ActionResult(true, 'Success message', 'NEXT_STEP', { key: 'value' });

        expect(result.success).toBe(true);
        expect(result.message).toBe('Success message');
        expect(result.nextStep).toBe('NEXT_STEP');
        expect(result.data).toEqual({ key: 'value' });
    });

    test('should create ActionResult with default values', () => {
        const result = new ActionResult(false, 'Error');

        expect(result.success).toBe(false);
        expect(result.message).toBe('Error');
        expect(result.nextStep).toBeNull();
        expect(result.data).toBeNull();
    });
});

describe('ValidationResult', () => {
    test('should create ValidationResult with all properties', () => {
        const result = new ValidationResult(false, '2FA', 'Multi-factor required');

        expect(result.success).toBe(false);
        expect(result.reason).toBe('2FA');
        expect(result.details).toBe('Multi-factor required');
    });

    test('should create ValidationResult with default values', () => {
        const result = new ValidationResult(true);

        expect(result.success).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.details).toBeNull();
    });
});