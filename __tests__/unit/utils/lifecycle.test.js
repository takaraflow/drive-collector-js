import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setHttpServer, getHttpServer, registerShutdownHooks, buildWebhookServer } from '../../../src/utils/lifecycle.js';
import { gracefulShutdown } from '../../../src/services/GracefulShutdown.js';

vi.mock('../../../src/services/GracefulShutdown.js', () => ({
    gracefulShutdown: {
        register: vi.fn(),
        registerTaskCounter: vi.fn(),
    }
}));

vi.mock('../../../src/services/InstanceCoordinator.js', () => ({
    instanceCoordinator: {
        registerActiveTaskCounter: vi.fn(),
        stop: vi.fn(),
    }
}));

vi.mock('../../../src/services/CacheService.js', () => ({
    cache: {
        destroy: vi.fn(),
    }
}));

vi.mock('../../../src/services/telegram.js', () => ({
    stopWatchdog: vi.fn(),
    client: { connected: true, disconnect: vi.fn() },
}));

vi.mock('../../../src/repositories/TaskRepository.js', () => ({
    TaskRepository: {
        flushUpdates: vi.fn(),
    }
}));

vi.mock('../../../src/processor/TaskManager.js', () => ({
    TaskManager: {
        getProcessingCount: vi.fn(() => 1),
        getWaitingCount: vi.fn(() => 2),
    }
}));

vi.mock('../../../src/services/logger/index.js', () => ({
    flushLogBuffer: vi.fn(),
    logger: {
        withModule: vi.fn().mockReturnValue({
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn()
        })
    }
}));

vi.mock('../../../src/services/MediaGroupBuffer.js', () => ({
    default: {
        persist: vi.fn(),
        stopCleanup: vi.fn(),
    }
}));

vi.mock('../../../src/services/DistributedLock.js', () => ({
    distributedLock: {
        shutdown: vi.fn(),
    }
}));

vi.mock('../../../src/services/TunnelService.js', () => ({
    tunnelService: {
        stop: vi.fn(),
    }
}));

// Mocks for buildWebhookServer
vi.mock('http2', () => ({
    default: {
        createServer: vi.fn((opts, handler) => ({
            listen: vi.fn((port, cb) => cb()),
            close: vi.fn(cb => cb())
        })),
        createSecureServer: vi.fn((opts, handler) => ({
            listen: vi.fn((port, cb) => cb()),
            close: vi.fn(cb => cb())
        }))
    },
    createServer: vi.fn((opts, handler) => ({
        listen: vi.fn((port, cb) => cb()),
        close: vi.fn(cb => cb())
    })),
    createSecureServer: vi.fn((opts, handler) => ({
        listen: vi.fn((port, cb) => cb()),
        close: vi.fn(cb => cb())
    }))
}));

vi.mock('http', () => ({
    default: {
        createServer: vi.fn((handler) => ({
            listen: vi.fn((port, cb) => cb()),
            close: vi.fn(cb => cb())
        }))
    },
    createServer: vi.fn((handler) => ({
        listen: vi.fn((port, cb) => cb()),
        close: vi.fn(cb => cb())
    }))
}));

vi.mock('fs', () => ({
    readFileSync: vi.fn((path) => `mock content of ${path}`)
}));


describe('lifecycle utilities', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setHttpServer(null);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('setHttpServer / getHttpServer / closeHttpServer', () => {
        it('should set and get the HTTP server', () => {
            const mockServer = { id: 'mock-server' };
            setHttpServer(mockServer);
            expect(getHttpServer()).toBe(mockServer);
        });

        it('should return null initially', () => {
            expect(getHttpServer()).toBeNull();
        });

        it('should resolve closeHttpServer if httpServer is not set', async () => {
            await registerShutdownHooks();
            const hooks = gracefulShutdown.register.mock.calls;
            const httpServerHook = hooks.find(call => call[2] === 'http-server');
            expect(httpServerHook).toBeDefined();

            await expect(httpServerHook[0]()).resolves.toBeUndefined();
        });

        it('should call server.close when hook is executed', async () => {
            const mockServer = {
                close: vi.fn(cb => cb())
            };
            setHttpServer(mockServer);

            await registerShutdownHooks();
            const hooks = gracefulShutdown.register.mock.calls;
            const httpServerHook = hooks.find(call => call[2] === 'http-server');

            // To ensure the callback is executed properly and promise resolved
            const promise = httpServerHook[0]();
            expect(mockServer.close).toHaveBeenCalled();
        });
    });

    describe('registerShutdownHooks', () => {
        it('should register all expected shutdown hooks with correct priorities', async () => {
            await registerShutdownHooks();

            expect(gracefulShutdown.register).toHaveBeenCalled();
            expect(gracefulShutdown.registerTaskCounter).toHaveBeenCalled();

            const expectedHooks = [
                ['logger-flush-before', 5],
                ['http-server', 10],
                ['instance-coordinator', 20],
                ['telegram-client', 30],
                ['media-group-buffer-persist', 35],
                ['task-repository', 40],
                ['distributed-lock', 45],
                ['media-group-buffer-cleanup', 48],
                ['cache-service', 50],
                ['tunnel-service', 55],
                ['logger-flush-after', 60]
            ];

            for (const [name, priority] of expectedHooks) {
                const hook = gracefulShutdown.register.mock.calls.find(call => call[2] === name);
                expect(hook).toBeDefined();
                expect(hook[1]).toBe(priority);
            }
        });

        it('should correctly evaluate the task counter', async () => {
            await registerShutdownHooks();
            expect(gracefulShutdown.registerTaskCounter).toHaveBeenCalled();

            const counterFn = gracefulShutdown.registerTaskCounter.mock.calls[0][0];
            const count = counterFn();

            // TaskManager mock returns 1 for processing and 2 for waiting
            expect(count).toBe(3);
        });

        it('should correctly evaluate the instance coordinator counter', async () => {
            await registerShutdownHooks();

            // instanceCoordinator mock was called
            const { instanceCoordinator } = await import('../../../src/services/InstanceCoordinator.js');
            expect(instanceCoordinator.registerActiveTaskCounter).toHaveBeenCalled();

            const counterFn = instanceCoordinator.registerActiveTaskCounter.mock.calls[0][0];
            const count = counterFn();

            // TaskManager mock returns 1 for processing and 2 for waiting
            expect(count).toBe(3);
        });

        it('should execute individual hooks successfully', async () => {
            await registerShutdownHooks();
            const hooks = gracefulShutdown.register.mock.calls;

            const instanceCoordinatorHook = hooks.find(call => call[2] === 'instance-coordinator');
            await instanceCoordinatorHook[0]();

            const telegramClientHook = hooks.find(call => call[2] === 'telegram-client');
            await telegramClientHook[0]();

            const mediaGroupBufferPersistHook = hooks.find(call => call[2] === 'media-group-buffer-persist');
            await mediaGroupBufferPersistHook[0]();

            const taskRepositoryHook = hooks.find(call => call[2] === 'task-repository');
            await taskRepositoryHook[0]();

            const distributedLockHook = hooks.find(call => call[2] === 'distributed-lock');
            await distributedLockHook[0]();

            const mediaGroupBufferCleanupHook = hooks.find(call => call[2] === 'media-group-buffer-cleanup');
            await mediaGroupBufferCleanupHook[0]();

            const cacheServiceHook = hooks.find(call => call[2] === 'cache-service');
            await cacheServiceHook[0]();

            const tunnelServiceHook = hooks.find(call => call[2] === 'tunnel-service');
            await tunnelServiceHook[0]();
        });

        it('should execute logger flush hooks successfully', async () => {
            vi.useFakeTimers();
            await registerShutdownHooks();
            const hooks = gracefulShutdown.register.mock.calls;

            const loggerFlushBeforeHook = hooks.find(call => call[2] === 'logger-flush-before');
            await loggerFlushBeforeHook[0]();

            const loggerFlushAfterHook = hooks.find(call => call[2] === 'logger-flush-after');

            // Start the hook, then advance timers to resolve the internal delay
            const promise = loggerFlushAfterHook[0]();
            await vi.advanceTimersByTimeAsync(1000);
            await promise;
        });

        it('should handle mediaGroupBuffer persist error gracefully', async () => {
            // Need to mock mediaGroupBuffer to throw error just for this test
            const originalConsoleError = console.error;
            console.error = vi.fn();

            await registerShutdownHooks();
            const hooks = gracefulShutdown.register.mock.calls;
            const mediaGroupBufferPersistHook = hooks.find(call => call[2] === 'media-group-buffer-persist');

            const mediaGroupBufferModule = await import("../../../src/services/MediaGroupBuffer.js");
            mediaGroupBufferModule.default.persist.mockRejectedValueOnce(new Error('Persist failed'));

            await mediaGroupBufferPersistHook[0]();

            const { logger } = await import("../../../src/services/logger/index.js");
            expect(logger.withModule('Lifecycle').error).toHaveBeenCalledWith('❌ MediaGroupBuffer 持久化失败:', expect.any(Error));
            console.error = originalConsoleError;
        });

        it('should handle telegram client disconnect gracefully when client is not connected or null', async () => {
            const telegramModule = await import("../../../src/services/telegram.js");
            // First case: client is null
            telegramModule.client = null;

            await registerShutdownHooks();
            const hooks = gracefulShutdown.register.mock.calls;
            const telegramClientHook = hooks.find(call => call[2] === 'telegram-client');

            await telegramClientHook[0]();
            // Should not throw

            // Second case: client is not connected
            telegramModule.client = { connected: false, disconnect: vi.fn() };
            await telegramClientHook[0]();
            expect(telegramModule.client.disconnect).not.toHaveBeenCalled();

            // Restore
            telegramModule.client = { connected: true, disconnect: vi.fn() };
        });

        it('should handle distributedLock shutdown gracefully when null', async () => {
            const distributedLockModule = await import("../../../src/services/DistributedLock.js");
            const originalLock = distributedLockModule.distributedLock;
            distributedLockModule.distributedLock = null;

            await registerShutdownHooks();
            const hooks = gracefulShutdown.register.mock.calls;
            const lockHook = hooks.find(call => call[2] === 'distributed-lock');

            await lockHook[0]();
            // Should not throw

            // Restore
            distributedLockModule.distributedLock = originalLock;
        });

        it('should handle mediaGroupBuffer cleanup stop gracefully when missing', async () => {
            const mediaGroupBufferModule = await import("../../../src/services/MediaGroupBuffer.js");
            const originalBuffer = mediaGroupBufferModule.default;

            mediaGroupBufferModule.default = null;
            await registerShutdownHooks();
            let hooks = gracefulShutdown.register.mock.calls;
            let cleanupHook = hooks.find(call => call[2] === 'media-group-buffer-cleanup');
            await cleanupHook[0](); // Should not throw

            mediaGroupBufferModule.default = { stopCleanup: null };
            await registerShutdownHooks();
            hooks = gracefulShutdown.register.mock.calls;
            cleanupHook = hooks.find(call => call[2] === 'media-group-buffer-cleanup');
            await cleanupHook[0](); // Should not throw

            // Restore
            mediaGroupBufferModule.default = originalBuffer;
        });
    });

    describe('buildWebhookServer', () => {
        const mockLog = { info: vi.fn(), error: vi.fn() };
        const mockHandler = vi.fn();

        it('should build http server when http2 is not enabled', async () => {
            const config = { port: 8080 };
            const server = await buildWebhookServer(config, mockHandler, mockLog);

            expect(server).toBeDefined();
            expect(getHttpServer()).toBe(server);
            expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('8080'));
        });

        it('should build plain http2 server', async () => {
            const config = { port: 8080, http2: { enabled: true, plain: true } };
            const server = await buildWebhookServer(config, mockHandler, mockLog);

            expect(server).toBeDefined();
            expect(getHttpServer()).toBe(server);
        });

        it('should throw error when tls config is missing for secure http2', async () => {
            const config = { port: 8080, http2: { enabled: true, plain: false } };

            await expect(buildWebhookServer(config, mockHandler, mockLog))
                .rejects.toThrow('http2-tls-missing');

            expect(mockLog.error).toHaveBeenCalled();
        });

        it('should build secure http2 server when tls config is present', async () => {
            const config = {
                port: 8080,
                http2: {
                    enabled: true,
                    plain: false,
                    keyPath: 'key.pem',
                    certPath: 'cert.pem',
                    allowHttp1: true
                }
            };
            const server = await buildWebhookServer(config, mockHandler, mockLog);

            expect(server).toBeDefined();
            expect(getHttpServer()).toBe(server);
        });

        it('should build secure http2 server and allowHttp1 defaults to not false', async () => {
            const config = {
                port: 8080,
                http2: {
                    enabled: true,
                    plain: false,
                    keyPath: 'key.pem',
                    certPath: 'cert.pem',
                }
            };
            const server = await buildWebhookServer(config, mockHandler, mockLog);

            expect(server).toBeDefined();
            expect(getHttpServer()).toBe(server);
            // Verify createSecureServer arguments
            const http2 = await import('http2');
            expect(http2.createSecureServer).toHaveBeenCalledWith(
                expect.objectContaining({ allowHTTP1: true }),
                mockHandler
            );
        });
    });
});

        it('should handle instance coordinator without registerActiveTaskCounter function', async () => {
            const instanceCoordinatorModule = await import('../../../src/services/InstanceCoordinator.js');
            const originalFn = instanceCoordinatorModule.instanceCoordinator.registerActiveTaskCounter;

            // Remove the function
            delete instanceCoordinatorModule.instanceCoordinator.registerActiveTaskCounter;

            await registerShutdownHooks();

            // Should not throw
            expect(gracefulShutdown.register).toHaveBeenCalled();

            // Restore
            instanceCoordinatorModule.instanceCoordinator.registerActiveTaskCounter = originalFn;
        });
