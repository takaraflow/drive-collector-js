import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        withModule: () => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() })
    }
}));

vi.mock('../../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: {
        updateConfigData: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock('../../../src/services/rclone.js', () => ({
    CloudTool: {
        validateConfig: vi.fn(),
        validateConfigWithWritableSession: vi.fn(),
        normalizePasswordForRclone: vi.fn((value, options = {}) => {
            if (options.format === 'rclone_obscured') return value;
            return `obs_${value}`;
        })
    }
}));

import { ProtonDriveProvider } from '../../../src/services/drives/ProtonDriveProvider.js';
import { DriveRepository } from '../../../src/repositories/DriveRepository.js';

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
        expect(provider.getBindingStep('WAIT_2FA').sensitive).toBe(true);
        expect(provider.getBindingStep('WAIT_OTP_SECRET_KEY').optional).toBe(true);
        expect(provider.getBindingStep('WAIT_MAILBOX_PASSWORD').optional).toBe(true);
    });

    test('should prepare storage with obscured secrets and omit one-time 2fa code', async () => {
        const stored = await provider.prepareConfigForStorage({
            username: 'alice',
            password: 'secret',
            two_factor_enabled: true,
            two_factor: '123456',
            otp_secret_key: 'otp-secret',
            mailbox_password: 'mail-secret',
            client_uid: 'uid-1',
            client_access_token: 'access-1',
            client_refresh_token: 'refresh-1',
            client_salted_key_pass: 'salt-1'
        });

        expect(stored).toMatchObject({
            username: 'alice',
            password: 'obs_secret',
            password_format: 'rclone_obscured',
            two_factor_enabled: true,
            otp_secret_key: 'obs_otp-secret',
            otp_secret_key_format: 'rclone_obscured',
            mailbox_password: 'obs_mail-secret',
            mailbox_password_format: 'rclone_obscured',
            client_uid: 'uid-1',
            client_access_token: 'access-1',
            client_refresh_token: 'refresh-1',
            client_salted_key_pass: 'salt-1',
            session_bootstrap_ok: true
        });
        expect(stored).not.toHaveProperty('two_factor');
    });

    test('should prefer session tokens over 2fa in connection string', () => {
        const conn = provider.getConnectionString({
            username: 'alice',
            password: 'obs_secret',
            two_factor: '123456',
            otp_secret_key: 'obs_otp',
            mailbox_password: 'obs_mail',
            client_uid: 'uid-1',
            client_access_token: 'access-1',
            client_refresh_token: 'refresh-1',
            client_salted_key_pass: 'salt-1'
        });

        expect(conn).toContain('client_uid="uid-1"');
        expect(conn).toContain('client_access_token="access-1"');
        expect(conn).toContain('client_refresh_token="refresh-1"');
        expect(conn).toContain('client_salted_key_pass="salt-1"');
        expect(conn).not.toContain('2fa=');
        expect(conn).not.toContain('otp_secret_key=');
        expect(conn).toContain('mailbox_password="obs_mail"');
    });

    test('should fall back to otp secret or 2fa when session is missing', () => {
        const withOtp = provider.getConnectionString({
            username: 'alice',
            password: 'obs_secret',
            two_factor: '123456',
            otp_secret_key: 'obs_otp'
        });
        expect(withOtp).toContain('otp_secret_key="obs_otp"');
        expect(withOtp).not.toContain('2fa=');

        const withCode = provider.getConnectionString({
            username: 'alice',
            password: 'obs_secret',
            two_factor: '123456'
        });
        expect(withCode).toContain('2fa="123456"');

        const persistedStaleCode = provider.getConnectionString({
            username: 'alice',
            password: 'obs_secret',
            password_format: 'rclone_obscured',
            two_factor: '123456'
        });
        expect(persistedStaleCode).not.toContain('2fa=');
    });

    test('should walk through 2fa flow with one-time code first and capture session', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfigWithWritableSession.mockResolvedValue({
            success: true,
            remoteConfig: {
                client_uid: 'uid-1',
                client_access_token: 'access-1',
                client_refresh_token: 'refresh-1',
                client_salted_key_pass: 'salt-1'
            }
        });

        const usernameResult = await provider.handleInput('WAIT_USERNAME', 'alice', {});
        const passwordResult = await provider.handleInput('WAIT_PASSWORD', 'secret', { data: usernameResult.data });
        const use2faResult = await provider.handleInput('WAIT_USE_2FA', 'yes', { data: passwordResult.data });
        expect(use2faResult).toMatchObject({ success: true, nextStep: 'WAIT_2FA' });

        const codeResult = await provider.handleInput('WAIT_2FA', '123456', { data: use2faResult.data });
        expect(codeResult).toMatchObject({ success: true, nextStep: 'WAIT_OTP_SECRET_KEY' });

        const otpResult = await provider.handleInput('WAIT_OTP_SECRET_KEY', '跳过', { data: codeResult.data });
        expect(otpResult).toMatchObject({ success: true, nextStep: 'WAIT_MAILBOX_PASSWORD' });

        const finalResult = await provider.handleInput('WAIT_MAILBOX_PASSWORD', '跳过', { data: otpResult.data });
        expect(finalResult.success).toBe(true);
        expect(finalResult.data).toMatchObject({
            username: 'alice',
            password: 'secret',
            two_factor_enabled: true,
            two_factor: '123456',
            otp_secret_key: '',
            mailbox_password: '',
            client_uid: 'uid-1',
            client_access_token: 'access-1',
            client_refresh_token: 'refresh-1',
            client_salted_key_pass: 'salt-1'
        });

        const stored = await provider.prepareConfigForStorage(finalResult.data);
        expect(stored.client_uid).toBe('uid-1');
        expect(stored).not.toHaveProperty('two_factor');
    });

    test('should accept optional otp secret and mailbox password', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfigWithWritableSession.mockResolvedValue({
            success: true,
            remoteConfig: {
                client_uid: 'uid-2',
                client_access_token: 'access-2',
                client_refresh_token: 'refresh-2',
                client_salted_key_pass: 'salt-2'
            }
        });

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
            mailbox_password: 'mail-secret',
            client_uid: 'uid-2'
        });
    });

    test('should skip 2fa steps when user says no to 2fa', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfigWithWritableSession.mockResolvedValue({
            success: true,
            remoteConfig: {
                client_uid: 'uid-3',
                client_access_token: 'access-3',
                client_refresh_token: 'refresh-3',
                client_salted_key_pass: 'salt-3'
            }
        });

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
            mailbox_password: '',
            client_uid: 'uid-3'
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
        expect(provider.getErrorMessage('2FA')).toContain('会话');
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

    test('should strip one-time 2fa when reusable session is already present', async () => {
        const runtime = await provider.prepareConfigForRuntime({
            username: 'alice',
            password: 'obs_stored',
            password_format: 'rclone_obscured',
            two_factor: '999999',
            client_uid: 'uid-1',
            client_access_token: 'access-1',
            client_refresh_token: 'refresh-1',
            client_salted_key_pass: 'salt-1'
        });

        expect(runtime.two_factor).toBe('');
        expect(runtime.client_uid).toBe('uid-1');
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

    test('should persist runtime-bootstrapped session when drive context is available', async () => {
        const { CloudTool } = await import('../../../src/services/rclone.js');
        CloudTool.validateConfigWithWritableSession.mockResolvedValue({
            success: true,
            remoteConfig: {
                client_uid: 'uid-9',
                client_access_token: 'access-9',
                client_refresh_token: 'refresh-9',
                client_salted_key_pass: 'salt-9'
            }
        });

        const next = await provider.ensureRuntimeSession({
            username: 'alice',
            password: 'obs_secret',
            password_format: 'rclone_obscured',
            otp_secret_key: 'obs_otp',
            otp_secret_key_format: 'rclone_obscured'
        }, {
            userId: 'u1',
            activeDrive: { id: 'd1' },
            cloudTool: CloudTool
        });

        expect(next.client_uid).toBe('uid-9');
        expect(next.two_factor).toBe('');
        expect(DriveRepository.updateConfigData).toHaveBeenCalledWith(
            'u1',
            'd1',
            expect.objectContaining({
                client_uid: 'uid-9',
                session_bootstrap_ok: true
            })
        );
    });

    test('writable conf entries should prefer session and avoid stale 2fa', () => {
        const withSession = provider.getWritableRcloneConfigEntries({
            username: 'alice',
            password: 'obs_secret',
            two_factor: '123456',
            client_uid: 'uid-1',
            client_access_token: 'access-1',
            client_refresh_token: 'refresh-1',
            client_salted_key_pass: 'salt-1'
        });
        expect(withSession).toMatchObject({
            username: 'alice',
            password: 'obs_secret',
            client_uid: 'uid-1'
        });
        expect(withSession).not.toHaveProperty('2fa');

        const withCode = provider.getWritableRcloneConfigEntries({
            username: 'alice',
            password: 'obs_secret',
            two_factor: '123456'
        });
        expect(withCode['2fa']).toBe('123456');
    });
});
