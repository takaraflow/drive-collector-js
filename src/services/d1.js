import { config } from "../config/index.js";
import { logger } from "./logger.js";

/**
 * --- D1 数据库服务层 ---
 * 职责：通过 Cloudflare REST API 远程执行 SQL 指令
 */
class D1Service {
    constructor() {
        // 支持新旧变量名
        this.accountId = process.env.CF_D1_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
        this.databaseId = process.env.CF_D1_DATABASE_ID;
        this.token = process.env.CF_D1_TOKEN || process.env.CF_KV_TOKEN;

        // 验证必要的配置
        if (!this.accountId || !this.databaseId || !this.token) {
            logger.warn("⚠️ D1配置缺失: 请检查 CF_D1_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_D1_TOKEN");
        }

        this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    }

    /**
     * 核心请求器：发送 SQL 到 Cloudflare
     */
    async _execute(sql, params = []) {
        // 如果配置缺失，直接报错，避免发送无效请求
        if (!this.accountId || !this.databaseId) {
            throw new Error("D1 Error: Missing configuration (Account ID or Database ID)");
        }

        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                const requestBody = {
                    sql: sql,
                    params: params,
                };

                const response = await fetch(this.apiUrl, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${this.token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(requestBody),
                });

                if (!response.ok) {
                    // 解析错误响应体，获取具体错误信息
                    let errorDetails = { code: null, message: response.statusText };
                    let errorBody = "";
                    
                    try {
                        errorBody = await response.text();
                        const errorJson = JSON.parse(errorBody);
                        if (errorJson.success === false && errorJson.errors?.[0]) {
                            errorDetails.code = errorJson.errors[0].code;
                            errorDetails.message = errorJson.errors[0].message;
                        }
                    } catch (parseErr) {
                        // 如果解析 JSON 失败，保留原始 body 文本（如果非空）作为补充信息
                        if (errorBody) errorDetails.extra = errorBody;
                    }

                    // 记录详细日志（脱敏处理）
                    const safeSql = sql.replace(/[\n\r]/g, ' ').slice(0, 200) + (sql.length > 200 ? '...' : '');
                    const paramTypes = params.map(p => {
                        if (p === null) return 'null';
                        if (p === undefined) return 'undefined';
                        return typeof p === 'object' ? (p.constructor?.name || 'Object') : typeof p;
                    });
                    
                    logger.error(`🚨 D1 HTTP ${response.status}: ${errorDetails.message} (code:${errorDetails.code || 'N/A'})`);
                    logger.error(`   SQL: ${safeSql}`);
                    logger.error(`   Params types: [${paramTypes.join(', ')}]`);
                    if (errorDetails.extra) logger.error(`   Raw Body: ${errorDetails.extra}`);

                    // 检查是否是 "Network connection lost" (Code 7500) 或服务器错误
                    const isServerError = response.status >= 500;
                    const isNetworkLost = (errorDetails.code === 7500) || 
                                          (errorDetails.message && errorDetails.message.includes('Network connection lost')) ||
                                          (errorBody && errorBody.includes('Network connection lost'));
                    
                    if ((isServerError || isNetworkLost) && attempts < maxAttempts - 1) {
                        attempts++;
                        const delay = attempts * 2000; // 线性退避: 2s, 4s
                        logger.warn(`⚠️ D1 请求失败 (${response.status})，${isNetworkLost ? '检测到连接丢失，' : ''}正在重试 (${attempts}/${maxAttempts})...`);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                    
                    // 抛出包含详细信息的错误
                    throw new Error(`D1 HTTP ${response.status} [${errorDetails.code || 'N/A'}]: ${errorDetails.message}`);
                }

                const result = await response.json();
                if (!result.success) {
                    throw new Error(`D1 SQL Error [${result.errors[0]?.code || 'N/A'}]: ${result.errors[0]?.message || "Unknown error"}`);
                }
                // 兼容标准 Cloudflare D1 格式和扁平化 Mock 格式
                return result.result ? result.result[0] : result;

            } catch (error) {
                // 处理 fetch 网络错误 (DNS, Timeout 等)
                if ((error.name === 'TypeError' && error.message.includes('fetch')) || 
                    error.message.includes('network') || 
                    error.message.includes('timeout')) {
                    
                    if (attempts < maxAttempts - 1) {
                        attempts++;
                        logger.warn(`⚠️ D1 网络请求异常: ${error.message}，正在重试 (${attempts}/${maxAttempts})...`);
                        await new Promise(r => setTimeout(r, 2000));
                        continue;
                    }
                    throw new Error('D1 Error: Network connection lost (Max retries exceeded)');
                }
                throw error;
            }
        }
    }

    /**
     * 健康检查：简单的 SELECT 1 查询，用于验证连接
     */
    async healthCheck() {
        return await this.fetchOne('SELECT 1 as health');
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
        const result = await this._execute(sql, params);
        // 统一返回处理：如果结果包含 results 数组，返回第一个结果，否则返回整个结果对象
        return result.results ? result.results[0] : result;
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