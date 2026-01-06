import { logger } from "./logger.js";

const log = logger.withModule ? logger.withModule('D1') : logger;

/**
 * --- D1 数据库服务层 ---
 */
class D1Service {
    constructor() {
        this.isInitialized = false;
        this.accountId = null;
        this.databaseId = null;
        this.token = null;
        this.apiUrl = null;
    }

    async initialize() {
        if (this.isInitialized) return;

        this.accountId = process.env.CF_D1_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
        this.databaseId = process.env.CF_D1_DATABASE_ID;
        this.token = process.env.CF_D1_TOKEN;

        if (!this.accountId || !this.databaseId || !this.token) {
            log.warn("⚠️ D1配置不完整: 请检查 CF_D1_ACCOUNT_ID, CF_D1_DATABASE_ID, CF_D1_TOKEN");
        } else {
            this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
            this.isInitialized = true;
            log.info(`Service initialized: ${this.databaseId}`);
        }
    }

    async _execute(sql, params = []) {
        if (!this.isInitialized) await this.initialize();
        if (!this.accountId || !this.databaseId) {
            throw new Error("D1 Error: Missing configuration");
        }

        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            try {
                const response = await fetch(this.apiUrl, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${this.token}`,
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ sql, params }),
                });

                if (!response.ok) {
                    let errorDetails = "";
                    let errorCode = "N/A";
                    let errorMessage = "";
                    
                    try {
                        const errorText = await response.text();
                        // Try to parse as JSON first
                        try {
                            const errorJson = JSON.parse(errorText);
                            const error = errorJson.errors?.[0];
                            if (error) {
                                errorCode = error.code || 'N/A';
                                errorMessage = error.message || '';
                                errorDetails = ` [${errorCode}]: ${errorMessage}`;
                            }
                        } catch (jsonError) {
                            // If not JSON, use status text
                            errorMessage = response.statusText || errorText;
                            errorDetails = ` [${errorCode}]: ${errorMessage}`;
                        }
                    } catch (e) {
                        // ignore body parse error
                        errorDetails = ` [${errorCode}]: ${response.statusText}`;
                    }

                    // Check for D1 network error code 7500
                    const isD1NetworkError = response.status === 400 && errorCode === 7500;
                    
                    // Log detailed error info
                    log.error(`🚨 D1 HTTP ${response.status} - ${response.statusText}${errorDetails}`);

                    // Client errors (4xx) should not retry, except 400 with 7500
                    if (response.status >= 400 && response.status < 500 && !isD1NetworkError) {
                        throw new Error(`D1 HTTP ${response.status}${errorDetails}`);
                    }

                    // For server errors (5xx) or 400 with 7500, continue to retry
                    if (attempts < maxAttempts - 1) {
                        attempts++;
                        // Use setTimeout for compatibility with fake timers
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        continue;
                    }

                    // Max retries exceeded
                    if (isD1NetworkError) {
                        throw new Error("D1 Error: Network connection lost (Max retries exceeded)");
                    }
                    throw new Error(`D1 HTTP ${response.status}${errorDetails}`);
                }

                const result = await response.json();
                if (!result.success) {
                    const error = result.errors?.[0];
                    const errorCode = error?.code || 'N/A';
                    const errorMessage = error?.message || '';
                    
                    log.error(`🚨 D1 SQL Error [${errorCode}]: ${errorMessage}`);
                    throw new Error(`D1 SQL Error [${errorCode}]: ${errorMessage}`);
                }
                return result;
            } catch (error) {
                // Network errors (TypeError: Failed to fetch)
                if (error instanceof TypeError) {
                    log.error(`🚨 D1 Network Error: ${error.message}`);
                    
                    if (attempts < maxAttempts - 1) {
                        attempts++;
                        await new Promise(resolve => setTimeout(resolve, 2000));
                        continue;
                    }
                    
                    throw new Error("D1 Error: Network connection lost (Max retries exceeded)");
                }
                
                // Re-throw other errors (like client errors already handled above)
                throw error;
            }
        }
    }

    async fetchAll(sql, params = []) {
        const result = await this._execute(sql, params);
        // Return results array from result.result[0].results
        return result.result && result.result[0] ? result.result[0].results || [] : [];
    }

    async fetchOne(sql, params = []) {
        const results = await this.fetchAll(sql, params);
        return results[0] || null;
    }

    async run(sql, params = []) {
        const result = await this._execute(sql, params);
        // Return the first item from result.result[0].results[0] or result.result[0] or the whole result
        if (result.result && result.result[0]) {
            if (result.result[0].results && result.result[0].results[0]) {
                return result.result[0].results[0];
            }
            return result.result[0];
        }
        return result;
    }

    /**
     * 重置服务状态 (主要用于测试)
     */
    _reset() {
        this.isInitialized = false;
        this.accountId = null;
        this.databaseId = null;
        this.token = null;
        this.apiUrl = null;
    }

    /**
     * 批量执行 SQL 语句 (并发执行并返回所有结果)
     * @param {Array<{sql: string, params: Array}>} statements
     */
    async batch(statements) {
        if (!statements || statements.length === 0) return [];
        
        // 采用并行执行模式，返回 Promise.allSettled 的包装结果以兼容测试
        return await Promise.all(statements.map(s =>
            this._execute(s.sql, s.params)
                .then(result => ({ success: true, result }))
                .catch(error => ({ success: false, error }))
        ));
    }
}

export const d1 = new D1Service();