import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        withModule: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })
    }
}));

vi.mock('../../../src/services/rclone.js', () => ({
    CloudTool: {
        validateConfig: vi.fn(),
        normalizePasswordForRclone: vi.fn((value, options = {}) => {
            if (options.format === 'rclone_obscured') return value;
            return `obs_${value}`;
        })
    }
}));

import { ProtonDriveProvider } from '../../../src/services/drives/ProtonDriveProvider.js';

describe('ProtonDriveProvider', () => {
    let provider;

    beforeEach(() => {
        vi.clearAllMocks();
        provider = new ProtonDriveProvider();
    });

    test('should expose protondrive metadata as advanced', () => {
        expect(provider.getInfo()).toMatchObject({
            type: 'protondrive',
            name: 'Proton Drive',
            supportLevel: 'advanced'
        });
    });

    test('should declare code-first binding steps with optional advanced fields', () => {
        const steps = provider.getBindingSteps();
        expect(steps.map(step => step.step)).toEqual([
            'WAIT_USERNAME',
            'WAIT_PASSWORD',
            'WAIT_USE_2FA',
            'WAIT_2FA',
            'WAIT_OTP_SECRET_KEY',
            'WAIT_MAILBOX_PASSWORD'
        ]);

        const use2fa = provider.getBindingStep('WAIT_USE_2FA');
        expect(use2fa.choices).toEqual([
            { value: 'yes', label: '已开启 2FA' },
            { value: 'no', label: '未开启 2FA' }
        ]);
        expect(provider.getBindingStep('WAIT_OTP_SECRET_KEY').optional).toBe(true);
        expect(provider.getBindingStep('WAIT_MAILBOX_PASSWORD').optional).toBe(true);
        expect(provider.isSensitiveBindingStep('WAIT_2FA')).toBe(true);
        expect(provider.isFinalBindingStep('WAIT_MAILBOX_PASSWORD')).toBe(true);
        expect(provider.isFinalBindingStep('WAIT_2FA')).toBe(false);
    });

    test('should validate and persist all proton secrets through rclone obscure flow', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const result = await provider.validateConfig({
            username: 'alice',
            password: 'secret',
            two_factor: '123456',
            otp_secret_key: 'otp-secret',
            mailbox_password: 'mail-secret'
        });

        expect(result.success).toBe(true);
        expect(CloudTool.normalizePasswordForRclone).toHaveBeenCalledTimes(3);
        expect(CloudTool.validateConfig).toHaveBeenCalledWith('protondrive', {
            username: 'alice',
            password: 'obs_secret',
            password_format: 'rclone_obscured',
            two_factor: '123456',
            otp_secret_key: 'obs_otp-secret',
            otp_secret_key_format: 'rclone_obscured',
            mailbox_password: 'obs_mail-secret',
            mailbox_password_format: 'rclone_obscured'
        });
    });

    test('should generate official protondrive connection string fields', () => {
        const conn = provider.getConnectionString({
            username: 'alice',
            password: 'obs_secret',
            two_factor: '123456',
            otp_secret_key: 'obs_otp',
            mailbox_password: 'obs_mail'
        });

        expect(conn).toBe(':protondrive,username="alice",password="obs_secret",2fa="123456",otp_secret_key="obs_otp",mailbox_password="obs_mail":');
    });

    test('should support optional proton fields being omitted', () => {
        const conn = provider.getConnectionString({
            username: 'alice',
            password: 'obs_secret'
        });

        expect(conn).toBe(':protondrive,username="alice",password="obs_secret":');
    });

    test('should walk through 2fa flow with one-time code first', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const usernameResult = await provider.handleInput('WAIT_USERNAME', 'alice', {});
        expect(usernameResult).toMatchObject({ success: true, nextStep: 'WAIT_PASSWORD', data: { username: 'alice' } });

        const passwordResult = await provider.handleInput('WAIT_PASSWORD', 'secret', { data: usernameResult.data });
        expect(passwordResult).toMatchObject({ success: true, nextStep: 'WAIT_USE_2FA' });

        const use2faResult = await provider.handleInput('WAIT_USE_2FA', 'yes', { data: passwordResult.data });
        expect(use2faResult).toMatchObject({ success: true, nextStep: 'WAIT_2FA' });

        const codeResult = await provider.handleInput('WAIT_2FA', '123456', { data: use2faResult.data });
        expect(codeResult).toMatchObject({ success: true, nextStep: 'WAIT_OTP_SECRET_KEY' });

        const otpResult = await provider.handleInput('WAIT_OTP_SECRET_KEY', 'skip', { data: codeResult.data });
        expect(otpResult).toMatchObject({ success: true, nextStep: 'WAIT_MAILBOX_PASSWORD' });

        const finalResult = await provider.handleInput('WAIT_MAILBOX_PASSWORD', '-', { data: otpResult.data });
        expect(finalResult.success).toBe(true);
        expect(finalResult.data).toMatchObject({
            username: 'alice',
            password: 'secret',
            two_factor_enabled: true,
            two_factor: '123456',
            otp_secret_key: '',
            mailbox_password: ''
        });
    });

    test('should allow optional long-term otp secret after one-time code', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const usernameResult = await provider.handleInput('WAIT_USERNAME', 'alice', {});
        const passwordResult = await provider.handleInput('WAIT_PASSWORD', 'secret', { data: usernameResult.data });
        const use2faResult = await provider.handleInput('WAIT_USE_2FA', 'yes', { data: passwordResult.data });
        const codeResult = await provider.handleInput('WAIT_2FA', '654321', { data: use2faResult.data });
        const otpResult = await provider.handleInput('WAIT_OTP_SECRET_KEY', 'otp-secret', { data: codeResult.data });
        expect(otpResult).toMatchObject({ success: true, nextStep: 'WAIT_MAILBOX_PASSWORD' });

        const finalResult = await provider.handleInput('WAIT_MAILBOX_PASSWORD', 'mail-secret', { data: otpResult.data });
        expect(finalResult.success).toBe(true);
        expect(finalResult.data).toMatchObject({
            username: 'alice',
            password: 'secret',
            two_factor_enabled: true,
            two_factor: '654321',
            otp_secret_key: 'otp-secret',
            mailbox_password: 'mail-secret'
        });
    });

    test('should skip 2fa steps when user says no to 2fa', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const usernameResult = await provider.handleInput('WAIT_USERNAME', 'alice', {});
        const passwordResult = await provider.handleInput('WAIT_PASSWORD', 'secret', { data: usernameResult.data });
        const use2faResult = await provider.handleInput('WAIT_USE_2FA', 'no', { data: passwordResult.data });
        expect(use2faResult).toMatchObject({ success: true, nextStep: 'WAIT_MAILBOX_PASSWORD' });

        const finalResult = await provider.handleInput('WAIT_MAILBOX_PASSWORD', '跳过', { data: use2faResult.data });
        expect(finalResult.success).toBe(true);
        expect(finalResult.data).toMatchObject({
            username: 'alice',
            password: 'secret',
            two_factor_enabled: false,
            two_factor: '',
            otp_secret_key: '',
            mailbox_password: ''
        });
    });

    test('should reject invalid one-time 2fa codes', async () => {
        const result = await provider.handleInput('WAIT_2FA', '12ab', {
            data: {
                username: 'alice',
                password: 'secret',
                two_factor_enabled: true
            }
        });
        expect(result.success).toBe(false);
        expect(result.message).toContain('6 位');
    });

    test('should return proton-specific 2FA failure message', () => {
        expect(provider.getErrorMessage('2FA')).toContain('2FA');
        expect(provider.getErrorMessage('2FA')).not.toContain('暂不支持');
    });
    test('should obscure plain credentials during binding-time runtime prep', async () => {
        const runtime = await provider.prepareConfigForRuntime({
            username: 'alice',
            password: 'plain-pass',
            two_factor: '123456',
            otp_secret_key: 'otp-plain',
            mailbox_password: 'mail-plain'
        });

        expect(runtime).toMatchObject({
            username: 'alice',
            password: 'obs_plain-pass',
            password_format: 'rclone_obscured',
            two_factor: '123456',
            otp_secret_key: 'obs_otp-plain',
            otp_secret_key_format: 'rclone_obscured',
            mailbox_password: 'obs_mail-plain',
            mailbox_password_format: 'rclone_obscured'
        });

        const { CloudTool } = await import('../../../src/services/rclone.js');
        expect(CloudTool.normalizePasswordForRclone).toHaveBeenCalledWith('plain-pass', { format: 'plain' });
        expect(CloudTool.normalizePasswordForRclone).toHaveBeenCalledWith('otp-plain', { format: 'plain' });
        expect(CloudTool.normalizePasswordForRclone).toHaveBeenCalledWith('mail-plain', { format: 'plain' });
    });

    test('should not re-obscure already persisted rclone_obscured secrets', async () => {
        const runtime = await provider.prepareConfigForRuntime({
            username: 'alice',
            password: 'obs_stored',
            password_format: 'rclone_obscured',
            otp_secret_key: 'obs_otp',
            otp_secret_key_format: 'rclone_obscured',
            mailbox_password: 'obs_mail',
            mailbox_password_format: 'rclone_obscured'
        });

        expect(runtime.password).toBe('obs_stored');
        expect(runtime.otp_secret_key).toBe('obs_otp');
        expect(runtime.mailbox_password).toBe('obs_mail');

        const { CloudTool } = await import('../../../src/services/rclone.js');
        expect(CloudTool.normalizePasswordForRclone).toHaveBeenCalledWith('obs_stored', { format: 'rclone_obscured' });
    });

});
