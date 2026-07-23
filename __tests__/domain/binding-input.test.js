import { describe, test, expect } from 'vitest';
import {
    isSkipInput,
    normalizeOptionalBindingInput,
    parseBooleanInput,
    isSensitiveBindingStepName
} from '../../src/domain/binding-input.js';

describe('binding-input helpers', () => {
    test('should treat empty and explicit skip tokens as skip', () => {
        expect(isSkipInput('')).toBe(true);
        expect(isSkipInput('   ')).toBe(true);
        expect(isSkipInput('skip')).toBe(true);
        expect(isSkipInput('/skip')).toBe(true);
        expect(isSkipInput('-')).toBe(true);
        expect(isSkipInput('跳过')).toBe(true);
        expect(isSkipInput('不需要')).toBe(true);
        expect(isSkipInput('secret')).toBe(false);
    });

    test('should normalize optional inputs to empty when skipped', () => {
        expect(normalizeOptionalBindingInput('跳过')).toBe('');
        expect(normalizeOptionalBindingInput(' otp ')).toBe('otp');
    });

    test('should parse boolean yes/no style answers', () => {
        expect(parseBooleanInput('yes')).toEqual({ valid: true, value: true });
        expect(parseBooleanInput('是')).toEqual({ valid: true, value: true });
        expect(parseBooleanInput('no')).toEqual({ valid: true, value: false });
        expect(parseBooleanInput('关闭')).toEqual({ valid: true, value: false });
        expect(parseBooleanInput('maybe')).toEqual({ valid: false });
    });

    test('should detect sensitive binding step names including 2FA codes', () => {
        expect(isSensitiveBindingStepName('WAIT_PASSWORD')).toBe(true);
        expect(isSensitiveBindingStepName('WAIT_OTP_SECRET_KEY')).toBe(true);
        expect(isSensitiveBindingStepName('WAIT_2FA')).toBe(true);
        expect(isSensitiveBindingStepName('WAIT_USERNAME')).toBe(false);
        expect(isSensitiveBindingStepName('WAIT_USE_2FA')).toBe(false);
    });
});
