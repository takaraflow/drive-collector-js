import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const providerInstances = vi.hoisted(() => []);

vi.mock('../../src/services/secrets/InfisicalSecretsProvider.js', () => ({
    default: class MockInfisicalSecretsProvider {
        constructor(config) {
            this.config = config;
            this.listeners = new Map();
            providerInstances.push(this);
        }

        async fetchSecrets() {
            return {
                API_ID: '123456',
                API_HASH: 'hash',
                BOT_TOKEN: 'initial-token'
            };
        }

        on(event, callback) {
            this.listeners.set(event, callback);
        }

        startPolling() {}

        simulateConfigChange(changes) {
            return this.listeners.get('configChanged')?.(changes);
        }
    }
}));

vi.mock('../../src/services/telegram.js', () => ({
    reconnectBot: vi.fn(),
    getTelegramStatus: vi.fn().mockResolvedValue({ connected: true })
}));

vi.mock('../../src/services/CacheService.js', () => ({
    cache: {
        ping: vi.fn().mockResolvedValue(true),
        destroy: vi.fn(),
        initialize: vi.fn()
    }
}));

vi.mock('../../src/services/QueueService.js', () => ({
    queueService: {
        getCircuitBreakerStatus: vi.fn().mockResolvedValue({ state: 'closed' }),
        destroy: vi.fn(),
        initialize: vi.fn()
    }
}));

vi.mock('../../src/services/logger/index.js', () => ({
    logger: {
        reload: vi.fn(),
        configure: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    }
}));

vi.mock('../../src/services/oss.js', () => ({ oss: { configure: vi.fn() } }));
vi.mock('../../src/services/d1.js', () => ({ d1: { reconnect: vi.fn() } }));
vi.mock('../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        stop: vi.fn(),
        start: vi.fn()
    }
}));

describe('config hot update redaction', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.resetModules();
        providerInstances.length = 0;
        process.env = {
            ...originalEnv,
            NODE_ENV: 'dev',
            DOTENV_OVERRIDE: 'false',
            INFISICAL_TOKEN: 'infisical-token',
            INFISICAL_PROJECT_ID: 'project-id',
            INFISICAL_POLLING_ENABLED: 'true',
            INFISICAL_POLLING_INTERVAL: '1000',
            SKIP_INFISICAL_RUNTIME: 'false'
        };

        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        process.env = { ...originalEnv };
        vi.restoreAllMocks();
    });

    test('should redact sensitive old and new values in hot update logs', async () => {
        const { initConfig } = await import('../../src/config/index.js');
        await initConfig();

        await providerInstances[0].simulateConfigChange([
            { key: 'BOT_TOKEN', oldValue: 'old-bot-token', newValue: 'new-bot-token' },
            { key: 'INSTANCE_SECRET', oldValue: 'old-instance-secret', newValue: 'new-instance-secret' },
            { key: 'PUBLIC_SETTING', oldValue: 'old-public', newValue: 'new-public' }
        ]);

        const output = console.log.mock.calls.flat().join('\n');
        expect(output).toContain('BOT_TOKEN');
        expect(output).toContain('INSTANCE_SECRET');
        expect(output).toContain('[REDACTED] → [REDACTED]');
        expect(output).toContain('old-public → new-public');
        expect(output).not.toContain('old-bot-token');
        expect(output).not.toContain('new-bot-token');
        expect(output).not.toContain('old-instance-secret');
        expect(output).not.toContain('new-instance-secret');
    });
});
