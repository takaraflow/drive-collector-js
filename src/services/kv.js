import { config } from "../config/index.js";

/**
 * --- Cloudflare KV 存储服务层 ---
 * 职责：通过 Cloudflare REST API 操作 KV 命名空间
 */
class KVService {
    constructor() {
        this.accountId = process.env.CF_ACCOUNT_ID;
        this.namespaceId = process.env.CF_KV_NAMESPACE_ID;
        this.token = process.env.CF_KV_TOKEN || process.env.CF_D1_TOKEN; // 优先使用专门的 KV Token，否则复用 D1 Token
        this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`;
    }

    /**
     * 写入键值对
     * @param {string} key 
     * @param {any} value - 会被 JSON.stringify
     * @param {number} expirationTtl - 过期时间（秒），最小 60 秒
     */
    async set(key, value, expirationTtl = null) {
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
     * 读取键值
     * @param {string} key 
     * @param {string} type - 'text' | 'json'
     */
    async get(key, type = "json") {
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
     * 删除键
     * @param {string} key 
     */
    async delete(key) {
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
     * 批量写入
     * @param {Array<{key: string, value: string}>} pairs 
     */
    async bulkSet(pairs) {
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
}

export const kv = new KVService();