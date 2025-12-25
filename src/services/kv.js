import { config } from "../config/index.js";

/**
 * --- KV 存储服务层 ---
 * 支持 Cloudflare KV 和 Upstash Redis REST API
 * 具有自动故障转移功能
 */
class KVService {
    constructor() {
        // 初始化配置
        this.accountId = process.env.CF_ACCOUNT_ID;
        this.namespaceId = process.env.CF_KV_NAMESPACE_ID;
        this.token = process.env.CF_KV_TOKEN || process.env.CF_D1_TOKEN;
        this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`;

        // Upstash备用配置
        this.upstashUrl = process.env.UPSTASH_REDIS_REST_URL;
        this.upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
        this.hasUpstash = !!(this.upstashUrl && this.upstashToken);

        // 故障转移状态
        this.currentProvider = 'cloudflare'; // 'cloudflare' | 'upstash'
        this.failureCount = 0;
        this.lastFailureTime = 0;
        this.failoverEnabled = this.hasUpstash; // 只有配置了Upstash才启用故障转移

        // 如果环境变量强制指定使用Upstash
        if (process.env.KV_PROVIDER === 'upstash') {
            if (!this.hasUpstash) {
                throw new Error('Upstash配置不完整，请设置 UPSTASH_REDIS_REST_URL 和 UPSTASH_REDIS_REST_TOKEN');
            }
            this.currentProvider = 'upstash';
            console.log('🔄 KV服务：强制使用 Upstash Redis');
        } else {
            console.log(`🔄 KV服务：使用 Cloudflare KV${this.failoverEnabled ? ' (支持智能故障转移到 Upstash)' : ''}`);
        }

        // 设置便利属性
        this.useUpstash = this.currentProvider === 'upstash';
    }

    /**
     * 检查是否应该触发故障转移
     */
    _shouldFailover(error) {
        if (!this.failoverEnabled || this.currentProvider === 'upstash') {
            return false;
        }

        // 检查是否是额度限制错误或网络错误
        const isQuotaError = error.message.includes('free usage limit') ||
                            error.message.includes('quota exceeded') ||
                            error.message.includes('rate limit') ||
                            error.message.includes('fetch failed') ||
                            error.message.includes('network') ||
                            error.message.includes('timeout') ||
                            error.message.includes('network timeout');

        if (isQuotaError) {
            this.failureCount++;
            this.lastFailureTime = Date.now();

            // 连续3次额度/网络错误，触发故障转移
            if (this.failureCount >= 3) {
                console.warn(`⚠️ ${this.getCurrentProvider()} 连续失败 ${this.failureCount} 次，触发自动故障转移到 Upstash`);
                return true;
            }
        }

        return false;
    }

    /**
     * 执行故障转移
     */
    _failover() {
        if (this.currentProvider === 'cloudflare' && this.hasUpstash) {
            console.log('🔄 正在切换到 Upstash Redis...');
            this.currentProvider = 'upstash';
            this.failureCount = 0; // 重置失败计数

            // 设置故障转移时间戳，用于定期尝试恢复
            this.failoverTime = Date.now();

            // 启动定期恢复检查
            this._startRecoveryCheck();

            console.log('✅ 已切换到 Upstash Redis');
            return true;
        }
        return false;
    }

    /**
     * 启动定期恢复检查
     */
    _startRecoveryCheck() {
        if (this.recoveryTimer) {
            clearInterval(this.recoveryTimer);
        }

        // 每30分钟检查一次是否可以恢复到主要提供商
        this.recoveryTimer = setInterval(async () => {
            if (this.currentProvider === 'upstash') {
                try {
                    // 尝试用主要提供商执行一个简单的操作
                    await this._cloudflare_get('__health_check__');
                    console.log('🔄 Cloudflare KV 已恢复，切换回主要提供商...');
                    this.currentProvider = 'cloudflare';
                    this.failureCount = 0;

                    // 清理恢复检查定时器
                    if (this.recoveryTimer) {
                        clearInterval(this.recoveryTimer);
                        this.recoveryTimer = null;
                    }

                    console.log('✅ 已恢复到 Cloudflare KV');
                } catch (error) {
                    // 恢复失败，继续使用Upstash
                    console.log('ℹ️ Cloudflare KV 仍不可用，继续使用 Upstash');
                }
            }
        }, 30 * 60 * 1000); // 30分钟
    }

    /**
     * 获取当前使用的提供商名称
     */
    getCurrentProvider() {
        return this.currentProvider === 'upstash' ? 'Upstash Redis' : 'Cloudflare KV';
    }

    /**
     * 检查是否处于故障转移模式
     * @returns {boolean} true 表示当前使用的提供商与配置的默认提供商不一致
     */
    get isFailoverMode() {
        // 如果配置了强制使用 Upstash，则当前必须是 Upstash 才不算 failover
        if (process.env.KV_PROVIDER === 'upstash') {
            return this.currentProvider !== 'upstash';
        }
        // 默认是 Cloudflare，如果当前是 Upstash，则处于 failover 模式
        return this.currentProvider === 'upstash';
    }

    /**
     * 通用执行方法，支持自动故障转移
     */
    async _executeWithFailover(operation, ...args) {
        try {
            if (this.currentProvider === 'upstash') {
                return await this[`_upstash_${operation}`](...args);
            } else {
                return await this[`_cloudflare_${operation}`](...args);
            }
        } catch (error) {
            if (this._shouldFailover(error)) {
                if (this._failover()) {
                    // 故障转移成功，重试操作
                    console.log(`🔄 使用新提供商重试 ${operation} 操作...`);
                    try {
                        return await this[`_upstash_${operation}`](...args);
                    } catch (retryError) {
                        console.error(`❌ 故障转移后操作仍失败:`, retryError.message);
                        throw retryError;
                    }
                }
            }
            throw error;
        }
    }

    /**
     * Cloudflare KV set 实现
     */
    async _cloudflare_set(key, value, expirationTtl = null) {
        const url = new URL(`${this.apiUrl}/values/${key}`);
        if (expirationTtl) {
            url.searchParams.set("expiration_ttl", expirationTtl);
        }

        const response = await fetch(url.toString(), {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
            },
            body: typeof value === "string" ? value : JSON.stringify(value),
        });

        const result = await response.json();
        if (!result.success) {
            throw new Error(`KV Set Error: ${result.errors[0]?.message || "Unknown error"}`);
        }
        return true;
    }

    /**
     * Upstash set 实现
     */
    async _upstash_set(key, value, expirationTtl = null) {
        const valueStr = typeof value === "string" ? value : JSON.stringify(value);
        let url = `${this.upstashUrl}/set/${encodeURIComponent(key)}/${encodeURIComponent(valueStr)}`;

        if (expirationTtl) {
            url += `?ex=${expirationTtl}`;
        }

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.upstashToken}`,
            },
        });

        const result = await response.json();
        if (result.error) {
            throw new Error(`Upstash Set Error: ${result.error}`);
        }
        return result.result === "OK";
    }

    /**
     * 写入键值对
     * @param {string} key
     * @param {any} value - 会被 JSON.stringify
     * @param {number} expirationTtl - 过期时间（秒），最小 60 秒
     */
    async set(key, value, expirationTtl = null) {
        return await this._executeWithFailover('set', key, value, expirationTtl);
    }

    /**
     * Cloudflare KV get 实现
     */
    async _cloudflare_get(key, type = "json") {
        const response = await fetch(`${this.apiUrl}/values/${key}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${this.token}`,
            },
        });

        if (response.status === 404) return null;
        if (!response.ok) {
            const result = await response.json();
            throw new Error(`KV Get Error: ${result.errors[0]?.message || "Unknown error"}`);
        }

        if (type === "json") {
            return await response.json();
        }
        return await response.text();
    }

    /**
     * Upstash get 实现
     */
    async _upstash_get(key, type = "json") {
        const response = await fetch(`${this.upstashUrl}/get/${encodeURIComponent(key)}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${this.upstashToken}`,
            },
        });

        const result = await response.json();
        if (result.error) {
            throw new Error(`Upstash Get Error: ${result.error}`);
        }

        const value = result.result;
        if (value === null) return null;

        if (type === "json") {
            try {
                return JSON.parse(value);
            } catch (e) {
                return value; // 如果不是有效的JSON，返回字符串
            }
        }
        return value;
    }

    /**
     * 读取键值
     * @param {string} key
     * @param {string} type - 'text' | 'json'
     */
    async get(key, type = "json") {
        return await this._executeWithFailover('get', key, type);
    }

    /**
     * Cloudflare KV delete 实现
     */
    async _cloudflare_delete(key) {
        const response = await fetch(`${this.apiUrl}/values/${key}`, {
            method: "DELETE",
            headers: {
                "Authorization": `Bearer ${this.token}`,
            },
        });

        const result = await response.json();
        if (!result.success && response.status !== 404) {
            throw new Error(`KV Delete Error: ${result.errors[0]?.message || "Unknown error"}`);
        }
        return true;
    }

    /**
     * Upstash delete 实现
     */
    async _upstash_delete(key) {
        const response = await fetch(`${this.upstashUrl}/del/${encodeURIComponent(key)}`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.upstashToken}`,
            },
        });

        const result = await response.json();
        if (result.error) {
            throw new Error(`Upstash Delete Error: ${result.error}`);
        }
        return result.result > 0; // 返回删除的数量
    }

    /**
     * 删除键
     * @param {string} key
     */
    async delete(key) {
        return await this._executeWithFailover('delete', key);
    }

    /**
     * Cloudflare KV bulkSet 实现
     */
    async _cloudflare_bulkSet(pairs) {
        const response = await fetch(`${this.apiUrl}/bulk`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(pairs.map(p => ({
                key: p.key,
                value: typeof p.value === "string" ? p.value : JSON.stringify(p.value)
            }))),
        });

        const result = await response.json();
        if (!result.success) {
            throw new Error(`KV Bulk Set Error: ${result.errors[0]?.message || "Unknown error"}`);
        }
        return true;
    }

    /**
     * Upstash bulkSet 实现
     */
    async _upstash_bulkSet(pairs) {
        // Upstash没有原生批量操作，使用循环调用set
        for (const pair of pairs) {
            await this._upstash_set(pair.key, pair.value);
        }
        return true;
    }

    /**
     * 批量写入
     * @param {Array<{key: string, value: string}>} pairs
     */
    async bulkSet(pairs) {
        return await this._executeWithFailover('bulkSet', pairs);
    }
}

export const kv = new KVService();