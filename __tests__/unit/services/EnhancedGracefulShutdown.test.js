import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import enhancedGracefulShutdown, { registerEnhancedHook, registerResource } from '../../../src/services/EnhancedGracefulShutdown.js';
import { logger } from '../../../src/services/logger/index.js';

// Mock logger
vi.mock('../../../src/services/logger/index.js', () => ({
    logger: {
        withModule: vi.fn().mockReturnValue({
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn()
        }),
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn()
    }
}));

describe('EnhancedGracefulShutdown', () => {
    let originalExit;
    let originalOn;

    beforeEach(() => {
        // Reset singleton state
        enhancedGracefulShutdown.shutdownHooks = [];
        enhancedGracefulShutdown.isShuttingDown = false;
        enhancedGracefulShutdown.cleanupState = {
            started: false,
            completed: false,
            failed: false,
            startTime: null,
            endTime: null,
            hookResults: [],
            resourceStates: new Map()
        };
        enhancedGracefulShutdown.dependencyGraph = new Map();

        // Mock process functions to prevent tests from exiting
        originalExit = process.exit;
        originalOn = process.on;
        process.exit = vi.fn();
        process.on = vi.fn();
    });

    afterEach(() => {
        process.exit = originalExit;
        process.on = originalOn;
        vi.clearAllMocks();
    });

    it('should register a hook correctly', () => {
        const cleanupFn = vi.fn().mockResolvedValue();
        const hookId = enhancedGracefulShutdown.register(cleanupFn, {
            name: 'testHook',
            priority: 10,
            resourceType: 'database'
        });

        expect(hookId).toBeDefined();
        expect(enhancedGracefulShutdown.shutdownHooks.length).toBe(1);
        expect(enhancedGracefulShutdown.shutdownHooks[0].name).toBe('testHook');
        expect(enhancedGracefulShutdown.shutdownHooks[0].priority).toBe(10);
    });

    it('should register a resource correctly', () => {
        const getStateFn = vi.fn().mockResolvedValue({ status: 'active' });
        enhancedGracefulShutdown.registerResource('db1', 'database', getStateFn);

        expect(enhancedGracefulShutdown.cleanupState.resourceStates.has('db1')).toBe(true);
        const tracker = enhancedGracefulShutdown.cleanupState.resourceStates.get('db1');
        expect(tracker.type).toBe('database');
        expect(tracker.getStateFn).toBe(getStateFn);
    });

    it('should execute cleanup hooks successfully', async () => {
        const cleanupFn = vi.fn().mockResolvedValue();
        enhancedGracefulShutdown.register(cleanupFn, {
            name: 'testHook'
        });

        await enhancedGracefulShutdown.executeCleanupHooks();

        expect(cleanupFn).toHaveBeenCalledTimes(1);
        expect(enhancedGracefulShutdown.cleanupState.hookResults.length).toBe(1);
        expect(enhancedGracefulShutdown.cleanupState.hookResults[0].name).toBe('testHook');
        expect(enhancedGracefulShutdown.cleanupState.hookResults[0].state).toBe('completed');
    });

    it('should skip hook execution when already failed', async () => {
        const cleanupFn = vi.fn().mockResolvedValue();
        enhancedGracefulShutdown.register(cleanupFn, {
            name: 'testHook'
        });

        // Force state to failed
        enhancedGracefulShutdown.cleanupState.failed = true;

        await enhancedGracefulShutdown.executeCleanupHooks();

        expect(cleanupFn).not.toHaveBeenCalled();
    });

    it('should handle failing hooks', async () => {
        const error = new Error('Hook failed');
        const cleanupFn = vi.fn().mockRejectedValue(error);

        enhancedGracefulShutdown.register(cleanupFn, {
            name: 'failHook'
        });

        await enhancedGracefulShutdown.executeCleanupHooks();

        expect(cleanupFn).toHaveBeenCalledTimes(1);
        expect(enhancedGracefulShutdown.cleanupState.hookResults.length).toBe(1);
        expect(enhancedGracefulShutdown.cleanupState.hookResults[0].state).toBe('failed');
        expect(enhancedGracefulShutdown.cleanupState.hookResults[0].error).toBe(error.message);
    });
});
