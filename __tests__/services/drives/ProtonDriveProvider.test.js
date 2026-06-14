import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        withModule: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })
    }
}));

vi.mock('../../../src/services/rclone.js', () => ({
    CloudTool: {
        validateConfig: vi.fn(),
        normalizePasswordForRclone: vi.fn((value) => `obs_${value}`)
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

    test('should provide full rclone protondrive binding steps', () => {
        const steps = provider.getBindingSteps();
        expect(steps.map(step => step.step)).toEqual([
            'WAIT_USERNAME',
            'WAIT_PASSWORD',
            'WAIT_USE_2FA',
            'WAIT_OTP_SECRET_KEY',
            'WAIT_MAILBOX_PASSWORD'
        ]);
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

    test('should walk through 2fa flow with otp secret key (preferred path)', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const usernameResult = await provider.handleInput('WAIT_USERNAME', 'alice', {});
        expect(usernameResult).toMatchObject({ success: true, nextStep: 'WAIT_PASSWORD', data: { username: 'alice' } });

        const passwordResult = await provider.handleInput('WAIT_PASSWORD', 'secret', { data: usernameResult.data });
        expect(passwordResult).toMatchObject({ success: true, nextStep: 'WAIT_USE_2FA' });

        const use2faResult = await provider.handleInput('WAIT_USE_2FA', 'yes', { data: passwordResult.data });
        expect(use2faResult).toMatchObject({ success: true, nextStep: 'WAIT_OTP_SECRET_KEY' });

        const otpResult = await provider.handleInput('WAIT_OTP_SECRET_KEY', 'otp-secret', { data: use2faResult.data });
        expect(otpResult).toMatchObject({ success: true, nextStep: 'WAIT_MAILBOX_PASSWORD' });

        const finalResult = await provider.handleInput('WAIT_MAILBOX_PASSWORD', 'mail-secret', { data: otpResult.data });
        expect(finalResult.success).toBe(true);
        expect(finalResult.data).toMatchObject({
            username: 'alice',
            password: 'secret',
            two_factor_enabled: true,
            two_factor: '',
            otp_secret_key: 'otp-secret',
            mailbox_password: 'mail-secret'
        });
    });

    test('should walk through 2fa flow with manual code when otp secret key is empty', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const usernameResult = await provider.handleInput('WAIT_USERNAME', 'alice', {});
        const passwordResult = await provider.handleInput('WAIT_PASSWORD', 'secret', { data: usernameResult.data });
        const use2faResult = await provider.handleInput('WAIT_USE_2FA', 'yes', { data: passwordResult.data });
        expect(use2faResult).toMatchObject({ success: true, nextStep: 'WAIT_OTP_SECRET_KEY' });

        const otpResult = await provider.handleInput('WAIT_OTP_SECRET_KEY', '', { data: use2faResult.data });
        expect(otpResult).toMatchObject({ success: true, nextStep: 'WAIT_2FA' });

        const codeResult = await provider.handleInput('WAIT_2FA', '123456', { data: otpResult.data });
        expect(codeResult).toMatchObject({ success: true, nextStep: 'WAIT_MAILBOX_PASSWORD' });

        const finalResult = await provider.handleInput('WAIT_MAILBOX_PASSWORD', '', { data: codeResult.data });
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

    test('should skip 2fa steps when user says no to 2fa', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfig.mockResolvedValue({ success: true });

        const usernameResult = await provider.handleInput('WAIT_USERNAME', 'alice', {});
        const passwordResult = await provider.handleInput('WAIT_PASSWORD', 'secret', { data: usernameResult.data });
        const use2faResult = await provider.handleInput('WAIT_USE_2FA', 'no', { data: passwordResult.data });
        expect(use2faResult).toMatchObject({ success: true, nextStep: 'WAIT_MAILBOX_PASSWORD' });

        const finalResult = await provider.handleInput('WAIT_MAILBOX_PASSWORD', '', { data: use2faResult.data });
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
});
