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
        try {
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

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const result = await response.json();
            if (!result.success) {
                throw new Error(`D1 Error: ${result.errors[0]?.message || "Unknown error"}`);
            }
            return result.result[0];
        } catch (error) {
            if (error.name === 'TypeError' && error.message.includes('fetch')) {
                throw new Error('D1 Error: Network connection lost');
            }
            throw error;
        }
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
     * 注：由于 D1 REST API 的 /batch 端点支持情况不明，改为并发执行
     */
    async batch(statements) {
        // statements 格式为 [{ sql: string, params: [] }, ...]
        // 使用 Promise.allSettled 并发执行所有语句，防止单点故障阻塞整个批次
        const results = await Promise.allSettled(statements.map(stmt => 
            this._execute(stmt.sql, stmt.params)
        ));

        // 格式化返回结果：[{ success: true, result: ... }, { success: false, error: ... }]
        return results.map(r => 
            r.status === 'fulfilled' 
                ? { success: true, result: r.value } 
                : { success: false, error: r.reason }
        );
    }
}

export const d1 = new D1Service();