import { config } from "../config/index.js";

/**
 * --- D1 数据库服务层 ---
 * 职责：通过 Cloudflare REST API 远程执行 SQL 指令
 */
class D1Service {
    constructor() {
        this.accountId = process.env.CF_ACCOUNT_ID;
        this.databaseId = process.env.CF_D1_DATABASE_ID;
        this.token = process.env.CF_D1_TOKEN;
        this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    }

    /**
     * 核心请求器：发送 SQL 到 Cloudflare
     */
    async _execute(sql, params = []) {
        const response = await fetch(this.apiUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                sql: sql,
                params: params,
            }),
        });

        const result = await response.json();
        if (!result.success) {
            throw new Error(`D1 Error: ${result.errors[0]?.message || "Unknown error"}`);
        }
        return result.result[0];
    }

    /**
     * 通用查询：返回多行数据 (用于搜索或列表)
     */
    async fetchAll(sql, params = []) {
        const result = await this._execute(sql, params);
        return result.results || [];
    }

    /**
     * 单行查询：返回第一行数据 (用于获取单个设置或任务)
     */
    async fetchOne(sql, params = []) {
        const results = await this.fetchAll(sql, params);
        return results[0] || null;
    }

    /**
     * 执行操作：用于 INSERT, UPDATE, DELETE
     */
    async run(sql, params = []) {
        return await this._execute(sql, params);
    }

    /**
     * 批量执行：用于同步大批量文件索引 (性能优化关键)
     */
    async batch(statements) {
        // statements 格式为 [{ sql: string, params: [] }, ...]
        const response = await fetch(`${this.apiUrl.replace('/query', '/batch')}`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(statements),
        });

        const result = await response.json();
        if (!result.success) throw new Error("D1 Batch Error");
        return result.result;
    }
}

export const d1 = new D1Service();