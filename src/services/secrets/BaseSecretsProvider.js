import { EventEmitter } from 'events';

/**
 * 配置服务提供者抽象基类
 * 所有云配置提供者都应继承此类
 */
export default class BaseSecretsProvider extends EventEmitter {
    constructor() {
        super();
        this.pollInterval = null;
        this.isPolling = false;
    }

    /**
     * 获取配置（抽象方法）
     * @returns {Promise<Object>} 配置对象
     * @abstract
     */
    async fetchSecrets() {
        throw new Error('fetchSecrets must be implemented by subclass');
    }

    /**
     * 启动轮询（可选实现）
     * @param {number} interval - 轮询间隔(ms)
     * @abstract
     */
    startPolling(interval = 60000) {
        throw new Error('startPolling must be implemented by subclass');
    }

    /**
     * 停止轮询
     */
    stopPolling() {
        if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
            this.isPolling = false;
        }
    }

    /**
     * 触发配置变更事件
     * @param {Array} changes - 变更数组 [{key, oldValue, newValue}]
     */
    onConfigChange(changes) {
        this.emit('configChanged', changes);
    }

    /**
     * 触发错误事件
     * @param {Error} error - 错误对象
     */
    onError(error) {
        this.emit('error', error);
    }

    /**
     * 清理资源
     */
    cleanup() {
        this.stopPolling();
        this.removeAllListeners();
    }
}