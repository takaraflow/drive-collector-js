import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SmartFailover } from '../../../src/services/SmartFailover.js';

describe('SmartFailover', () => {
    let failover;
    let mockLogger;

    beforeEach(() => {
        vi.useFakeTimers();
        mockLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
        };
        failover = new SmartFailover({
            logger: mockLogger,
            healthCheckInterval: 1000,
            failureThreshold: 3,
            timeout: 5000
        });
    });

    afterEach(() => {
        failover.stop();
        vi.useRealTimers();
    });

    describe('Initialization', () => {
        it('should initialize with default options', () => {
            const sf = new SmartFailover();
            expect(sf.healthCheckInterval).toBe(5000);
            expect(sf.failureThreshold).toBe(3);
            expect(sf.loadBalancingStrategy).toBe('round-robin');
            sf.stop();
        });

        it('should initialize with custom options', () => {
            expect(failover.healthCheckInterval).toBe(1000);
            expect(failover.failureThreshold).toBe(3);
            expect(failover.timeout).toBe(5000);
        });
    });

    describe('Instance Management', () => {
        it('should register a valid instance', () => {
            const result = failover.registerInstance('inst1', { host: 'localhost', port: 8080 });
            expect(result.success).toBe(true);
            expect(failover.instances.size).toBe(1);
            expect(failover.instances.get('inst1').status).toBe('healthy');
        });

        it('should fail to register an instance without host or port', () => {
            const result = failover.registerInstance('inst1', { host: 'localhost' });
            expect(result.success).toBe(false);
            expect(result.reason).toBe('invalid_config');
            expect(failover.instances.size).toBe(0);
        });

        it('should update an existing instance', () => {
            failover.registerInstance('inst1', { host: 'localhost', port: 8080 });
            const result = failover.updateInstance('inst1', { weight: 5 });
            expect(result.success).toBe(true);
            expect(failover.instances.get('inst1').weight).toBe(5);
        });

        it('should fail to update a non-existent instance', () => {
            const result = failover.updateInstance('inst1', { weight: 5 });
            expect(result.success).toBe(false);
            expect(result.reason).toBe('not_found');
        });

        it('should remove an instance', () => {
            failover.registerInstance('inst1', { host: 'localhost', port: 8080 });
            const result = failover.removeInstance('inst1');
            expect(result.success).toBe(true);
            expect(failover.instances.size).toBe(0);
        });

        it('should fail to remove a non-existent instance', () => {
            const result = failover.removeInstance('inst1');
            expect(result.success).toBe(false);
            expect(result.reason).toBe('not_found');
        });

        it('should trigger failover when active instance is removed', async () => {
            failover.registerInstance('inst1', { host: 'localhost', port: 8080 });
            failover.registerInstance('inst2', { host: 'localhost', port: 8081 });
            failover.activeInstance = 'inst1';

            const spy = vi.spyOn(failover, '_triggerFailover');
            failover.removeInstance('inst1');

            expect(failover.activeInstance).toBe('inst2'); // failover immediately picks inst2
            expect(spy).toHaveBeenCalledWith('instance_removed');
        });
    });

    describe('Load Balancing & getCurrentInstance', () => {
        beforeEach(() => {
            failover.registerInstance('inst1', { host: 'localhost', port: 8080, weight: 1 });
            failover.registerInstance('inst2', { host: 'localhost', port: 8081, weight: 3 });
            failover.registerInstance('inst3', { host: 'localhost', port: 8082, weight: 1 });
        });

        it('should return active instance if it is healthy', () => {
            failover.activeInstance = 'inst1';
            const instance = failover.getCurrentInstance();
            expect(instance.id).toBe('inst1');
        });

        it('should select new instance if active instance is null', () => {
            const instance = failover.getCurrentInstance();
            expect(instance).not.toBeNull();
            expect(failover.activeInstance).toBe(instance.id);
        });

        it('should use round-robin strategy', () => {
            failover.loadBalancingStrategy = 'round-robin';
            failover.activeInstance = null; // force selection

            const first = failover._selectInstance();
            const second = failover._selectInstance();
            const third = failover._selectInstance();

            expect(first.id).toBe('inst2'); // starts with index 1 (0 + 1 % 3)
            expect(second.id).toBe('inst3');
            expect(third.id).toBe('inst1');
        });

        it('should use least-connections strategy', () => {
            failover.loadBalancingStrategy = 'least-connections';
            failover.instances.get('inst1').connectionCount = 5;
            failover.instances.get('inst2').connectionCount = 1;
            failover.instances.get('inst3').connectionCount = 10;

            const instance = failover._selectInstance();
            expect(instance.id).toBe('inst2');
        });

        it('should use weighted strategy', () => {
            failover.loadBalancingStrategy = 'weighted';

            // with weights 1, 3, 1, inst2 has 60% chance
            // mock math random to always pick inst2 (return 0.5)
            const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);

            const instance = failover._selectInstance();
            expect(instance.id).toBe('inst2');

            randomSpy.mockRestore();
        });

        it('should return null if no instances are healthy', () => {
            failover.instances.get('inst1').status = 'down';
            failover.instances.get('inst2').status = 'unhealthy';
            failover.instances.get('inst3').status = 'down';

            expect(failover._selectInstance()).toBeNull();
        });
    });

    describe('Execute Request', () => {
        beforeEach(() => {
            failover.registerInstance('inst1', { host: 'localhost', port: 8080 });
            failover.registerInstance('inst2', { host: 'localhost', port: 8081 });
            failover.activeInstance = 'inst1';
        });

        it('should execute request successfully', async () => {
            const mockRequest = vi.fn().mockResolvedValue('success data');
            const result = await failover.executeRequest(mockRequest);

            expect(result.success).toBe(true);
            expect(result.result).toBe('success data');
            expect(result.instanceId).toBe('inst1');
            expect(failover.instances.get('inst1').connectionCount).toBe(0); // incremented then decremented
            expect(failover.stats.totalHealthChecks).toBe(1);
        });

        it('should timeout request', async () => {
            // Mock a long running request
            const mockRequest = vi.fn().mockImplementation(() => {
                return new Promise(resolve => setTimeout(() => resolve('data'), 6000));
            });

            // Start request
            const reqPromise = failover.executeRequest(mockRequest, { bypassFailover: true }); // bypass so it doesn't try to trigger failover and hang

            // Advance time past timeout
            await vi.advanceTimersByTimeAsync(5000);

            const result = await reqPromise;

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/Request timeout/);
            expect(failover.stats.totalFailures).toBe(1);
        });

        it('should fail over when request fails', async () => {
            const mockRequest = vi.fn()
                .mockRejectedValueOnce(new Error('Network error'))
                .mockResolvedValueOnce('success on inst2');

            // Set up a mock instance selection to guarantee it picks inst2
            vi.spyOn(failover, '_selectInstance').mockReturnValue(failover.instances.get('inst2'));

            const result = await failover.executeRequest(mockRequest);

            expect(result.success).toBe(true);
            expect(result.result).toBe('success on inst2');
            expect(result.instanceId).toBe('inst2');
            expect(failover.activeInstance).toBe('inst2'); // failover happened
            expect(failover.stats.totalFailovers).toBe(1);
        });

        it('should stop retrying after maxRetries', async () => {
            const mockRequest = vi.fn().mockRejectedValue(new Error('Persistent error'));

            const result = await failover.executeRequest(mockRequest, { retryCount: 3 });

            expect(result.success).toBe(false);
            expect(result.error).toBe('Persistent error');
            expect(result.retries).toBe(3);
        });

        it('should fail if no healthy instances available', async () => {
            failover.activeInstance = null;
            failover.instances.get('inst1').status = 'down';
            failover.instances.get('inst2').status = 'down';

            const mockRequest = vi.fn();
            const result = await failover.executeRequest(mockRequest);

            expect(result.success).toBe(false);
            expect(result.reason).toBe('no_healthy_instances');
        });
    });
    describe('Batch Execution', () => {
        beforeEach(() => {
            failover.registerInstance('inst1', { host: 'localhost', port: 8080 });
            failover.activeInstance = 'inst1';
        });

        it('should execute batch parallel', async () => {
            const fns = [
                vi.fn().mockResolvedValue('res1'),
                vi.fn().mockResolvedValue('res2')
            ];

            const results = await failover.executeBatch(fns, { parallel: true });
            expect(results).toHaveLength(2);
            expect(results[0].result.result).toBe('res1');
            expect(results[1].result.result).toBe('res2');
        });

        it('should execute batch sequential', async () => {
            const fns = [
                vi.fn().mockResolvedValue('res1'),
                vi.fn().mockResolvedValue('res2')
            ];

            const results = await failover.executeBatch(fns, { parallel: false });
            expect(results).toHaveLength(2);
            expect(results[0].result.result).toBe('res1');
            expect(results[1].result.result).toBe('res2');
        });

        it('should handle errors in parallel batch', async () => {
             const fns = [
                vi.fn().mockResolvedValue('res1'),
                vi.fn().mockRejectedValue(new Error('batch error'))
            ];

            // disable retries for the test to avoid failover loop timeout
            const results = await failover.executeBatch(fns, { bypassFailover: true });
            expect(results).toHaveLength(2);
            expect(results[0].result.result).toBe('res1');
            expect(results[1].result.error).toBe('batch error');
        });
    });

    describe('Health Checks & Failure Threshold', () => {
        beforeEach(() => {
            failover.registerInstance('inst1', { host: 'localhost', port: 8080 });
            failover.registerInstance('inst2', { host: 'localhost', port: 8081 });
            failover.activeInstance = 'inst1';
        });

        it('should mark instance down after failure threshold is reached', () => {
            failover._recordFailure('inst1', 'test error');
            expect(failover.instances.get('inst1').status).toBe('healthy'); // threshold 3

            failover._recordFailure('inst1', 'test error');
            failover._recordFailure('inst1', 'test error');

            expect(failover.instances.get('inst1').status).toBe('down');
            expect(failover.healthStatus.get('inst1')).toBe('down');
        });

        it('should perform health check interval automatically', async () => {
            // Since we use fake timers, health check should be scheduled
            const performSpy = vi.spyOn(failover, 'performHealthCheck').mockResolvedValue({ success: true });

            await vi.advanceTimersByTimeAsync(1100); // interval is 1000

            expect(performSpy).toHaveBeenCalledWith('inst1');
            expect(performSpy).toHaveBeenCalledWith('inst2');
        });
    });

    describe('Callbacks', () => {
        it('should trigger failover callbacks', () => {
            const callback = vi.fn();
            failover.onFailover(callback);

            failover._triggerFailoverCallbacks({ oldInstance: 'inst1', newInstance: 'inst2' });

            expect(callback).toHaveBeenCalledWith({ oldInstance: 'inst1', newInstance: 'inst2' });
        });

        it('should trigger recovery callbacks', () => {
            const callback = vi.fn();
            failover.onRecovery(callback);

            failover._triggerRecovery('inst1');

            expect(callback).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'inst1' }));
            expect(failover.stats.totalRecoveries).toBe(1);
        });

        it('should trigger health check callbacks and respect false return', async () => {
            failover.registerInstance('inst1', { host: 'localhost', port: 8080 });

            const callback = vi.fn().mockResolvedValue(false);
            failover.onHealthCheck(callback);

            const result = await failover._runHealthCheckCallbacks(failover.instances.get('inst1'));

            expect(callback).toHaveBeenCalled();
            expect(result).toBe(false);
        });
    });

    describe('Status and Shutdown', () => {
        it('should return system status', () => {
            failover.registerInstance('inst1', { host: 'localhost', port: 8080 });
            failover.activeInstance = 'inst1';

            const status = failover.getSystemStatus();
            expect(status.activeInstance).toBe('inst1');
            expect(status.instances).toHaveLength(1);
            expect(status.stats).toBeDefined();
        });

        it('should stop health checks and clean up callbacks on stop()', () => {
            failover.onFailover(vi.fn());
            failover.stop();

            expect(failover.healthCheckTimer).toBeNull();
            expect(failover.failoverCallbacks).toHaveLength(0);
        });
    });
});
