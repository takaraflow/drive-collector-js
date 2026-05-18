import fs from 'fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const listSecretsMock = vi.hoisted(() => vi.fn());
const accessTokenMock = vi.hoisted(() => vi.fn());
const universalLoginMock = vi.hoisted(() => vi.fn());

vi.mock('@infisical/sdk', () => ({
    InfisicalSDK: vi.fn(function InfisicalSDK() {
        this.auth = () => ({
            accessToken: accessTokenMock,
            universalAuth: {
                login: universalLoginMock
            }
        });
        this.secrets = () => ({
            listSecrets: listSecretsMock
        });
    })
}));

const ENV_KEYS = [
    'NODE_ENV',
    'NEW_RELIC_LICENSE_KEY',
    'APP_VERSION',
    'GIT_SHA',
    'INFISICAL_TOKEN',
    'INFISICAL_PROJECT_ID',
    'SKIP_INFISICAL_RUNTIME'
];

describe('runtime-env early hydration', () => {
    const originalEnv = {};

    beforeEach(() => {
        vi.resetModules();
        listSecretsMock.mockReset();
        accessTokenMock.mockReset();
        universalLoginMock.mockReset();
        listSecretsMock.mockResolvedValue({ secrets: [] });
        ENV_KEYS.forEach(key => {
            originalEnv[key] = process.env[key];
            delete process.env[key];
        });
        process.env.NODE_ENV = 'test';
    });

    afterEach(() => {
        vi.restoreAllMocks();
        ENV_KEYS.forEach(key => {
            if (originalEnv[key] === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = originalEnv[key];
            }
        });
    });

    test('should not read Infisical when required and hydration keys are already present', async () => {
        process.env.NEW_RELIC_LICENSE_KEY = 'license';
        process.env.APP_VERSION = '4.33.1';

        const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
        const { hydrateEarlyRuntimeEnv } = await import('../../../src/bootstrap/runtime-env.js');

        await expect(hydrateEarlyRuntimeEnv({
            requiredKeys: ['NEW_RELIC_LICENSE_KEY'],
            hydrateKeys: [['APP_VERSION']]
        })).resolves.toEqual({ infisicalLoaded: false });

        expect(existsSpy).toHaveBeenCalled();
        expect(listSecretsMock).not.toHaveBeenCalled();
    });

    test('should attempt cloud hydration when identity key groups are missing', async () => {
        process.env.NEW_RELIC_LICENSE_KEY = 'license';
        process.env.INFISICAL_TOKEN = 'token';
        process.env.INFISICAL_PROJECT_ID = 'project';
        process.env.NODE_ENV = 'prod';
        listSecretsMock.mockResolvedValue({
            secrets: [
                { secretKey: 'APP_VERSION', secretValue: '4.33.1' }
            ]
        });

        const { hydrateEarlyRuntimeEnv } = await import('../../../src/bootstrap/runtime-env.js');

        await expect(hydrateEarlyRuntimeEnv({
            requiredKeys: ['NEW_RELIC_LICENSE_KEY'],
            hydrateKeys: [['APP_VERSION'], ['GIT_SHA']]
        })).resolves.toEqual({ infisicalLoaded: true });

        expect(accessTokenMock).toHaveBeenCalledWith('token');
        expect(listSecretsMock).toHaveBeenCalledWith(expect.objectContaining({
            environment: 'prod',
            projectId: 'project'
        }));
        expect(process.env.APP_VERSION).toBe('4.33.1');
    });
});
