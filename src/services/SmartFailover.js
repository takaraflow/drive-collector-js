/**
 * SmartFailover - 智能故障转移服务
 * 解决故障转移配置错误问题
 * 
 * 功能特性：
 * 1. 健康检查与监控
 * 2. 智能故障检测
 * 3. 自动故障转移
 * 4. 负载均衡
 * 5. 恢复机制
 */

import { logger } from "./logger/index.js";

const log = logger.withModule ? logger.withModule('SmartFailover') : logger;

class SmartFailover {
    /**
     * @param {Object} options - 配置选项
     */
    constructor(options = {}) {
        this.logger = options.logger || log;
        
        // 故障转移配置
        this.healthCheckInterval = options.healthCheckInterval || 5000; // 5秒
        this.failureThreshold = options.failureThreshold || 3; // 失败阈值
        this.recoveryTimeout = options.recoveryTimeout || 30000; // 30秒恢复超时
        this.maxRetries = options.maxRetries || 3; // 最大重试次数
        this.timeout = options.timeout || 10000; // 10秒请求超时
        
        // 服务实例管理
        this.instances = new Map(); // instanceId -> instance
        this.activeInstance = null; // 当前活跃实例
        this.backupInstances = []; // 备份实例列表
        
        // 状态追踪
        this.healthStatus = new Map(); // instanceId -> health status
        this.failureCount = new Map(); // instanceId -> failure count
        this.lastCheck = new Map(); // instanceId -> last check time
        
        // 回调函数
        this.healthCheckCallbacks = [];
        this.failoverCallbacks = [];
        this.recoveryCallbacks = [];
        
        // 统计
        this.stats = {
            totalHealthChecks: 0,
            totalFailovers: 0,
            totalRecoveries: 0,
            totalFailures: 0,
            avgResponseTime: 0
        };
        
        // 定时器
        this.healthCheckTimer = null;
        this._startHealthChecks();
        
        // 负载均衡策略
        this.loadBalancingStrategy = options.loadBalancingStrategy || 'round-robin'; // 'round-robin', 'least-connections', 'weighted'
        this.roundRobinIndex = 0;
    }

    /**
     * 注册服务实例
     */
    registerInstance(instanceId, config = {}) {
        const {
            host,
            port,
            priority = 1, // 优先级，数字越小优先级越高
            weight = 1, // 权重（用于加权负载均衡）
            metadata = {}
        } = config;

        if (!host || !port) {
            return {
                success: false,
                reason: 'invalid_config',
                message: 'Host and port are required'
            };
        }

        const instance = {
            id: instanceId,
            host,
            port,
            priority,
            weight,
            metadata,
            status: 'healthy', // healthy, unhealthy, down, recovering
            lastResponse: null,
            responseTime: 0,
            connectionCount: 0
        };

        this.instances.set(instanceId, instance);
        this.healthStatus.set(instanceId, 'healthy');
        this.failureCount.set(instanceId, 0);

        // 按优先级排序备份实例
        this._updateBackupInstances();

        this.logger.info(`Registered instance: ${instanceId} (${host}:${port})`);

        return {
            success: true,
            instanceId,
            instance
        };
    }

    /**
     * 更新实例配置
     */
    updateInstance(instanceId, updates) {
        const instance = this.instances.get(instanceId);
        if (!instance) {
            return {
                success: false,
                reason: 'not_found',
                message: `Instance ${instanceId} not found`
            };
        }

        Object.assign(instance, updates);
        this._updateBackupInstances();

        return {
            success: true,
            instanceId,
            instance
        };
    }

    /**
     * 移除实例
     */
    removeInstance(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) {
            return {
                success: false,
                reason: 'not_found',
                message: `Instance ${instanceId} not found`
            };
        }

        this.instances.delete(instanceId);
        this.healthStatus.delete(instanceId);
        this.failureCount.delete(instanceId);
        this.lastCheck.delete(instanceId);

        // 如果移除的是活跃实例，触发故障转移
        if (this.activeInstance === instanceId) {
            this.activeInstance = null;
            this._triggerFailover('instance_removed');
        }

        this._updateBackupInstances();

        return {
            success: true,
            instanceId
        };
    }

    /**
     * 获取当前可用实例
     */
    getCurrentInstance() {
        if (this.activeInstance) {
            const instance = this.instances.get(this.activeInstance);
            if (instance && instance.status === 'healthy') {
                return instance;
            }
        }

        // 尝试选择新的活跃实例
        const newInstance = this._selectInstance();
        if (newInstance) {
            this.activeInstance = newInstance.id;
            return newInstance;
        }

        return null;
    }

    /**
     * 执行请求（带故障转移）
     */
    async executeRequest(requestFn, options = {}) {
        const {
            instanceId = null,
            retryCount = 0,
            bypassFailover = false
        } = options;

        const startTime = Date.now();

        // 选择目标实例
        let targetInstance;
        if (instanceId) {
            targetInstance = this.instances.get(instanceId);
            if (!targetInstance) {
                return {
                    success: false,
                    reason: 'instance_not_found',
                    message: `Instance ${instanceId} not found`
                };
            }
        } else {
            targetInstance = this.getCurrentInstance();
            if (!targetInstance) {
                return {
                    success: false,
                    reason: 'no_healthy_instances',
                    message: 'No healthy instances available'
                };
            }
        }

        // 增加连接数
        targetInstance.connectionCount++;

        try {
            // 执行请求，带超时
            const result = await this._executeWithTimeout(
                requestFn(targetInstance),
                this.timeout
            );

            const duration = Date.now() - startTime;
            targetInstance.lastResponse = Date.now();
            targetInstance.responseTime = duration;
            targetInstance.connectionCount--;

            // 更新统计
            this._updateResponseTime(duration);
            this.stats.totalHealthChecks++;

            // 重置失败计数
            this.failureCount.set(targetInstance.id, 0);
            this.healthStatus.set(targetInstance.id, 'healthy');

            // 触发恢复回调
            if (targetInstance.status !== 'healthy') {
                targetInstance.status = 'healthy';
                this._triggerRecovery(targetInstance.id);
            }

            return {
                success: true,
                instanceId: targetInstance.id,
                result,
                duration
            };

        } catch (error) {
            targetInstance.connectionCount--;
            this.stats.totalFailures++;

            // 记录失败
            this._recordFailure(targetInstance.id, error.message);

            this.logger.error(`Request failed on ${targetInstance.id}:`, error.message);

            if (bypassFailover || retryCount >= this.maxRetries) {
                return {
                    success: false,
                    instanceId: targetInstance.id,
                    error: error.message,
                    retries: retryCount
                };
            }

            // 触发故障转移
            await this._triggerFailover('request_failed', error);

            // 重试
            return this.executeRequest(requestFn, {
                ...options,
                retryCount: retryCount + 1
            });
        }
    }

    /**
     * 批量执行请求
     */
    async executeBatch(requestFns, options = {}) {
        const { parallel = true } = options;

        const results = [];

        if (parallel) {
            // 并行执行
            const promises = requestFns.map((fn, index) => 
                this.executeRequest(fn, { ...options, requestId: index })
                    .then(result => ({ index, result }))
                    .catch(error => ({ index, error }))
            );

            const allResults = await Promise.allSettled(promises);
            
            allResults.forEach((item, index) => {
                if (item.status === 'fulfilled') {
                    results.push(item.value);
                } else {
                    results.push({
                        index,
                        error: item.reason?.message || 'Unknown error'
                    });
                }
            });
        } else {
            // 串行执行
            for (let i = 0; i < requestFns.length; i++) {
                const result = await this.executeRequest(requestFns[i], {
                    ...options,
                    requestId: i
                });
                results.push({ index: i, result });
            }
        }

        return results;
    }

    /**
     * 手动触发故障转移
     */
    async triggerManualFailover(reason = 'manual') {
        return await this._triggerFailover(reason);
    }

    /**
     * 健康检查
     */
    async performHealthCheck(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) {
            return {
                success: false,
                reason: 'not_found',
                message: `Instance ${instanceId} not found`
            };
        }

        const startTime = Date.now();

        try {
            // 执行健康检查回调
            const isHealthy = await this._runHealthCheckCallbacks(instance);

            const duration = Date.now() - startTime;
            instance.lastCheck = Date.now();
            instance.responseTime = duration;

            if (isHealthy) {
                // 健康
                this.healthStatus.set(instanceId, 'healthy');
                this.failureCount.set(instanceId, 0);

                if (instance.status !== 'healthy') {
                    instance.status = 'healthy';
                    this._triggerRecovery(instanceId);
                }

                this.stats.totalHealthChecks++;

                return {
                    success: true,
                    instanceId,
                    healthy: true,
                    duration
                };
            } else {
                // 不健康
                this._recordFailure(instanceId, 'Health check failed');
                instance.status = 'unhealthy';

                return {
                    success: false,
                    instanceId,
                    healthy: false,
                    duration,
                    reason: 'health_check_failed'
                };
            }

        } catch (error) {
            const duration = Date.now() - startTime;
            this._recordFailure(instanceId, error.message);
            instance.status = 'down';

            return {
                success: false,
                instanceId,
                healthy: false,
                duration,
                reason: 'error',
                error: error.message
            };
        }
    }

    /**
     * 启动健康检查
     */
    _startHealthChecks() {
        if (this.healthCheckTimer) return;

        this.healthCheckTimer = setInterval(async () => {
            // 检查所有实例
            const checkPromises = Array.from(this.instances.keys()).map(instanceId => 
                this.performHealthCheck(instanceId)
            );

            await Promise.allSettled(checkPromises);

            // 检查是否需要故障转移
            if (this.activeInstance) {
                const activeInstance = this.instances.get(this.activeInstance);
                if (!activeInstance || activeInstance.status !== 'healthy') {
                    await this._triggerFailover('active_instance_unhealthy');
                }
            }

        }, this.healthCheckInterval);
    }

    /**
     * 触发故障转移
     */
    async _triggerFailover(reason, error = null) {
        if (this.isFailingOver) {
            return { success: false, reason: 'already_failing_over' };
        }

        this.isFailingOver = true;
        const oldInstance = this.activeInstance;

        this.logger.info(`Triggering failover (reason: ${reason}, old: ${oldInstance})`);

        try {
            // 选择新实例
            const newInstance = this._selectInstance();

            if (!newInstance) {
                this.logger.error('No healthy instances available for failover');
                this.isFailingOver = false;
                return {
                    success: false,
                    reason: 'no_healthy_instances'
                };
            }

            // 更新活跃实例
            this.activeInstance = newInstance.id;

            // 记录故障转移
            this.stats.totalFailovers++;

            // 触发回调
            this._triggerFailoverCallbacks({
                oldInstance,
                newInstance: newInstance.id,
                reason,
                error: error?.message,
                timestamp: Date.now()
            });

            this.logger.info(`Failover completed: ${oldInstance} -> ${newInstance.id}`);

            this.isFailingOver = false;

            return {
                success: true,
                oldInstance,
                newInstance: newInstance.id
            };

        } catch (error) {
            this.isFailingOver = false;
            this.logger.error('Failover failed:', error.message);
            return {
                success: false,
                reason: 'failover_error',
                error: error.message
            };
        }
    }

    /**
     * 选择实例
     */
    _selectInstance() {
        const healthyInstances = Array.from(this.instances.values())
            .filter(i => i.status === 'healthy');

        if (healthyInstances.length === 0) {
            return null;
        }

        switch (this.loadBalancingStrategy) {
            case 'round-robin':
                return this._selectRoundRobin(healthyInstances);

            case 'least-connections':
                return this._selectLeastConnections(healthyInstances);

            case 'weighted':
                return this._selectWeighted(healthyInstances);

            default:
                return healthyInstances[0];
        }
    }

    /**
     * 轮询选择
     */
    _selectRoundRobin(instances) {
        if (instances.length === 0) return null;
        
        this.roundRobinIndex = (this.roundRobinIndex + 1) % instances.length;
        return instances[this.roundRobinIndex];
    }

    /**
     * 最少连接选择
     */
    _selectLeastConnections(instances) {
        return instances.reduce((min, current) => 
            current.connectionCount < min.connectionCount ? current : min
        );
    }

    /**
     * 加权选择
     */
    _selectWeighted(instances) {
        const totalWeight = instances.reduce((sum, i) => sum + i.weight, 0);
        let random = Math.random() * totalWeight;

        for (const instance of instances) {
            random -= instance.weight;
            if (random <= 0) {
                return instance;
            }
        }

        return instances[instances.length - 1];
    }

    /**
     * 记录失败
     */
    _recordFailure(instanceId, error) {
        const count = (this.failureCount.get(instanceId) || 0) + 1;
        this.failureCount.set(instanceId, count);

        this.logger.warn(`Instance ${instanceId} failure #${count}: ${error}`);

        if (count >= this.failureThreshold) {
            const instance = this.instances.get(instanceId);
            if (instance) {
                instance.status = 'down';
                this.healthStatus.set(instanceId, 'down');
                this.logger.error(`Instance ${instanceId} marked as DOWN`);
            }
        }
    }

    /**
     * 更新备份实例列表
     */
    _updateBackupInstances() {
        this.backupInstances = Array.from(this.instances.values())
            .filter(i => i.id !== this.activeInstance)
            .sort((a, b) => a.priority - b.priority);
    }

    /**
     * 执行超时包装
     */
    async _executeWithTimeout(promise, timeout) {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Request timeout after ${timeout}ms`)), timeout);
        });

        return Promise.race([promise, timeoutPromise]);
    }

    /**
     * 运行健康检查回调
     */
    async _runHealthCheckCallbacks(instance) {
        for (const callback of this.healthCheckCallbacks) {
            try {
                const result = await callback(instance);
                if (result === false) return false;
            } catch (error) {
                this.logger.error(`Health check callback error:`, error.message);
                return false;
            }
        }
        return true;
    }

    /**
     * 触发故障转移回调
     */
    _triggerFailoverCallbacks(data) {
        this.failoverCallbacks.forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                this.logger.error(`Failover callback error:`, error.message);
            }
        });
    }

    /**
     * 触发恢复回调
     */
    _triggerRecovery(instanceId) {
        this.stats.totalRecoveries++;
        this.logger.info(`Instance ${instanceId} recovered`);

        this.recoveryCallbacks.forEach(callback => {
            try {
                callback({ instanceId, timestamp: Date.now() });
            } catch (error) {
                this.logger.error(`Recovery callback error:`, error.message);
            }
        });
    }

    /**
     * 更新响应时间统计
     */
    _updateResponseTime(duration) {
        const currentAvg = this.stats.avgResponseTime;
        const count = this.stats.totalHealthChecks;

        if (count === 1) {
            this.stats.avgResponseTime = duration;
        } else {
            this.stats.avgResponseTime = 
                ((currentAvg * (count - 1)) + duration) / count;
        }
    }

    /**
     * 注册健康检查回调
     */
    onHealthCheck(callback) {
        this.healthCheckCallbacks.push(callback);
        return () => {
            const index = this.healthCheckCallbacks.indexOf(callback);
            if (index > -1) {
                this.healthCheckCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * 注册故障转移回调
     */
    onFailover(callback) {
        this.failoverCallbacks.push(callback);
        return () => {
            const index = this.failoverCallbacks.indexOf(callback);
            if (index > -1) {
                this.failoverCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * 注册恢复回调
     */
    onRecovery(callback) {
        this.recoveryCallbacks.push(callback);
        return () => {
            const index = this.recoveryCallbacks.indexOf(callback);
            if (index > -1) {
                this.recoveryCallbacks.splice(index, 1);
            }
        };
    }

    /**
     * 获取实例状态
     */
    getInstanceStatus(instanceId) {
        const instance = this.instances.get(instanceId);
        if (!instance) {
            return { exists: false };
        }

        return {
            exists: true,
            id: instance.id,
            host: instance.host,
            port: instance.port,
            status: instance.status,
            priority: instance.priority,
            weight: instance.weight,
            connectionCount: instance.connectionCount,
            responseTime: instance.responseTime,
            lastCheck: instance.lastCheck,
            isActive: this.activeInstance === instanceId
        };
    }

    /**
     * 获取系统状态
     */
    getSystemStatus() {
        const instances = Array.from(this.instances.values()).map(i => ({
            id: i.id,
            status: i.status,
            priority: i.priority,
            weight: i.weight,
            connectionCount: i.connectionCount,
            responseTime: i.responseTime,
            isActive: this.activeInstance === i.id
        }));

        return {
            activeInstance: this.activeInstance,
            instances,
            backupCount: this.backupInstances.length,
            stats: this.stats,
            isFailingOver: this.isFailingOver || false
        };
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            ...this.stats,
            activeInstance: this.activeInstance,
            totalInstances: this.instances.size,
            healthyInstances: Array.from(this.instances.values()).filter(i => i.status === 'healthy').length,
            unhealthyInstances: Array.from(this.instances.values()).filter(i => i.status === 'unhealthy').length,
            downInstances: Array.from(this.instances.values()).filter(i => i.status === 'down').length
        };
    }

    /**
     * 停止服务
     */
    stop() {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
        this.healthCheckCallbacks = [];
        this.failoverCallbacks = [];
        this.recoveryCallbacks = [];
    }
}

export { SmartFailover };