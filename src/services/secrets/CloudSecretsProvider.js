import BaseSecretsProvider from './BaseSecretsProvider.js';

/**
 * 通用云配置提供者基类
 * 提供轮询、变更检测等通用功能
 */
export default class CloudSecretsProvider extends BaseSecretsProvider {
    constructor(options = {}) {
        super();
        this.options = options;
        this.currentSecrets = {};
        this.lastVersion = null;
    }

    /**
     * 获取配置（需子类实现）
     * @returns {Promise<Object>} 配置对象
     */
    async fetchSecrets() {
        throw new Error('fetchSecrets must be implemented by subclass');
    }

    /**
     * 启动轮询
     * @param {number} interval - 轮询间隔(ms)
     */
    startPolling(interval = 60000) {
        if (this.isPolling) {
            return;
        }

        this.isPolling = true;
        this.pollInterval = setInterval(async () => {
            if (!this.isPolling) return;

            try {
                const newSecrets = await this.fetchSecrets();
                this.detectChanges(newSecrets);
            } catch (error) {
                this.onError(error);
            }
        }, interval);
    }

    /**
     * 检测配置变更
     * @param {Object} newSecrets - 新配置
     */
    detectChanges(newSecrets) {
        const changes = [];
        
        // 检测新增和修改的配置
        for (const [key, newValue] of Object.entries(newSecrets)) {
            const oldValue = this.currentSecrets[key];
            if (oldValue !== newValue) {
                changes.push({ key, oldValue, newValue });
            }
        }

        // 检测删除的配置
        for (const [key, oldValue] of Object.entries(this.currentSecrets)) {
            if (!(key in newSecrets)) {
                changes.push({ key, oldValue, newValue: undefined });
            }
        }

        if (changes.length > 0) {
            this.currentSecrets = { ...newSecrets };
            this.onConfigChange(changes);
        }
    }

    /**
     * 验证API响应（通用逻辑）
     * @param {Object} response - API响应
     */
    validateResponse(response) {
        if (!response || typeof response !== 'object') {
            throw new Error('Invalid secrets response: expected object');
        }
        return true;
    }

    /**
     * 解析配置（通用逻辑）
     * @param {Object} response - API响应
     * @returns {Object} 解析后的配置
     */
    parseSecrets(response) {
        // 将API响应转换为键值对
        const secrets = {};
        
        if (response.secrets) {
            response.secrets.forEach(s => {
                secrets[s.secretKey] = s.secretValue;
            });
        }
        
        return secrets;
    }

    /**
     * 获取当前配置版本（用于变更检测）
     * @returns {string} 配置版本哈希
     */
    async getSecretVersion() {
        const secrets = await this.fetchSecrets();
        return this.hashSecrets(secrets);
    }

    /**
     * 计算配置哈希
     * @param {Object} secrets - 配置对象
     * @returns {string} 哈希值
     */
    hashSecrets(secrets) {
        const crypto = require('crypto');
        const str = JSON.stringify(secrets);
        return crypto.createHash('sha256').update(str).digest('hex');
    }

    /**
     * 获取当前配置快照
     * @returns {Object} 当前配置
     */
    getCurrentSecrets() {
        return { ...this.currentSecrets };
    }
}