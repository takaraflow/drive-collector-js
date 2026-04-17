import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all external dependencies
vi.mock('../../../src/config/index.js', () => ({ config: { testConfig: true } }));
vi.mock('../../../src/services/telegram.js', () => ({ client: {} }));
vi.mock('../../../src/services/rclone.js', () => ({ CloudTool: class {} }));
vi.mock('../../../src/services/oss.js', () => ({ ossService: {} }));
vi.mock('../../../src/ui/templates.js', () => ({ UIHelper: {} }));
vi.mock('../../../src/utils/common.js', () => ({
    getMediaInfo: vi.fn(),
    updateStatus: vi.fn(),
    escapeHTML: vi.fn(),
    safeEdit: vi.fn()
}));
vi.mock('../../../src/utils/limiter.js', () => ({
    runBotTask: vi.fn(),
    runMtprotoTask: vi.fn(),
    runBotTaskWithRetry: vi.fn(),
    runMtprotoTaskWithRetry: vi.fn(),
    runMtprotoFileTaskWithRetry: vi.fn(),
    PRIORITY: {}
}));
vi.mock('../../../src/modules/AuthGuard.js', () => ({ AuthGuard: class {} }));
vi.mock('../../../src/repositories/TaskRepository.js', () => ({ TaskRepository: class {} }));
vi.mock('../../../src/services/d1.js', () => ({ d1: {} }));
vi.mock('../../../src/services/CacheService.js', () => ({ cache: {} }));
vi.mock('../../../src/services/InstanceCoordinator.js', () => ({ instanceCoordinator: {} }));
vi.mock('../../../src/services/QueueService.js', () => ({ queueService: {} }));
vi.mock('../../../src/services/logger/index.js', () => ({ logger: {} }));
vi.mock('../../../src/locales/zh-CN.js', () => ({ STRINGS: {}, format: vi.fn() }));
vi.mock('../../../src/services/StreamTransferService.js', () => ({ streamTransferService: {} }));

// Import the module under test
import { DependencyContainer, dependencyContainer } from '../../../src/services/DependencyContainer.js';
import { config } from '../../../src/config/index.js';

describe('DependencyContainer', () => {
    let container;

    beforeEach(() => {
        container = new DependencyContainer();
    });

    describe('constructor', () => {
        it('should initialize with default dependencies', () => {
            const deps = container.getAll();

            // Check that known dependencies are set
            expect(deps.client).toBeDefined();
            expect(deps.CloudTool).toBeDefined();
            expect(deps.ossService).toBeDefined();
            expect(deps.UIHelper).toBeDefined();
            expect(deps.getMediaInfo).toBeDefined();
            expect(deps.updateStatus).toBeDefined();
            expect(deps.escapeHTML).toBeDefined();
            expect(deps.safeEdit).toBeDefined();
            expect(deps.runBotTask).toBeDefined();
            expect(deps.runMtprotoTask).toBeDefined();
            expect(deps.runBotTaskWithRetry).toBeDefined();
            expect(deps.runMtprotoTaskWithRetry).toBeDefined();
            expect(deps.runMtprotoFileTaskWithRetry).toBeDefined();
            expect(deps.PRIORITY).toBeDefined();
            expect(deps.AuthGuard).toBeDefined();
            expect(deps.TaskRepository).toBeDefined();
            expect(deps.d1).toBeDefined();
            expect(deps.cache).toBeDefined();
            expect(deps.instanceCoordinator).toBeDefined();
            expect(deps.queueService).toBeDefined();
            expect(deps.logger).toBeDefined();
            expect(deps.STRINGS).toBeDefined();
            expect(deps.format).toBeDefined();
            expect(deps.streamTransferService).toBeDefined();
        });

        it('should correctly access the config via getter', () => {
            const deps = container.getAll();
            expect(deps.config).toEqual({ testConfig: true });
        });
    });

    describe('get', () => {
        it('should retrieve a specific dependency', () => {
            const clientDep = container.get('client');
            expect(clientDep).toBeDefined();
        });

        it('should return undefined for a non-existent dependency', () => {
            expect(container.get('nonExistentDep')).toBeUndefined();
        });
    });

    describe('register', () => {
        it('should register a new dependency', () => {
            const newDep = { myService: true };
            container.register('customService', newDep);

            expect(container.get('customService')).toBe(newDep);
            expect(container.getAll().customService).toBe(newDep);
        });

        it('should overwrite an existing dependency', () => {
            const mockClient = { isMock: true };
            container.register('client', mockClient);

            expect(container.get('client')).toBe(mockClient);
        });
    });

    describe('getAll', () => {
        it('should return all registered dependencies', () => {
            const deps = container.getAll();
            expect(typeof deps).toBe('object');
            expect(deps).toHaveProperty('client');
            expect(deps).toHaveProperty('config');
        });
    });

    describe('global instance', () => {
        it('should export a singleton instance', () => {
            expect(dependencyContainer).toBeInstanceOf(DependencyContainer);
            expect(dependencyContainer.get('client')).toBeDefined();
        });
    });
});
