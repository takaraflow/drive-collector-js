import { logger } from "./logger/index.js";

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

        this.accountId = process.env.CLOUDFLARE_D1_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
        this.databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
        this.token = process.env.CLOUDFLARE_D1_TOKEN;

        if (!this.accountId || !this.databaseId || !this.token) {
            log.warn("⚠️ D1配置不完整: 请检查 CLOUDFLARE_D1_ACCOUNT_ID (或 CLOUDFLARE_ACCOUNT_ID), CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_D1_TOKEN");
        } else {
            this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
            this.isInitialized = true;
            log.info(`Service initialized: ${this.databaseId}`);
        }
    }

    async _validateConfig() {
        if (!this.isInitialized) await this.initialize();
        if (!this.accountId || !this.databaseId || !this.token) {
            throw new Error("D1 Error: Missing configuration (accountId/databaseId/token)");
        }
        if (!this.apiUrl) {
            throw new Error("D1 Error: API URL not initialized");
        }
    }

    async _doFetch(sql, params, attempts, maxAttempts) {
        // 📊 诊断日志：请求开始
        log.debug(`🔍 D1 Request [Attempt ${attempts + 1}/${maxAttempts}] - URL: ${this.apiUrl}`);
        log.debug(`🔍 D1 SQL: ${sql.substring(0, 100)}${sql.length > 100 ? '...' : ''}`);
        log.debug(`🔍 D1 Params: ${JSON.stringify(params)}`);

        return await fetch(this.apiUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ sql, params }),
        });
    }

    async _handleHttpError(response, attempts, maxAttempts, duration) {
        // 对于 401 错误，记录更详细的上下文但不泄露完整 token
        if (response.status === 401) {
            log.error(`🚨 D1 Authentication Failed. Token length: ${this.token?.length || 0}, Token preview: ${this.token?.substring(0, 5)}***`);
        }

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

        // 📊 诊断日志：详细错误信息
        log.error(`🚨 D1 HTTP ${response.status} - ${response.statusText}${errorDetails}`);
        log.error(`🚨 D1 Error Details - Code: ${errorCode}, Message: ${errorMessage}`);
        log.error(`🚨 D1 Request Context - Attempt: ${attempts + 1}/${maxAttempts}, Duration: ${duration}ms`);
        log.error(`🚨 D1 Config - AccountId: ${this.accountId}, DatabaseId: ${this.databaseId}`);

        // Client errors (4xx) should not retry, except 400 with 7500
        if (response.status >= 400 && response.status < 500 && !isD1NetworkError) {
            throw new Error(`D1 HTTP ${response.status}${errorDetails}`);
        }

        // For server errors (5xx) or 400 with 7500, continue to retry
        if (attempts < maxAttempts - 1) {
            // Wait inside the main loop instead, or do it here and return true
            await new Promise(resolve => setTimeout(resolve, 2000));
            return true; // Signal retry
        }

        // Max retries exceeded
        if (isD1NetworkError) {
            this._handleTransientFailure();
            throw new Error("D1 Error: Network connection lost (Max retries exceeded)");
        }
        this._handleTransientFailure();
        throw new Error(`D1 HTTP ${response.status}${errorDetails}`);
    }

    async _parseResponse(response) {
        const result = await response.json();
        if (!result.success) {
            const error = result.errors?.[0];
            const errorCode = error?.code || 'N/A';
            const errorMessage = error?.message || '';

            log.error(`🚨 D1 SQL Error [${errorCode}]: ${errorMessage}`);
            throw new Error(`D1 SQL Error [${errorCode}]: ${errorMessage}`);
        }
        return result;
    }

    async _handleRequestError(error, attempts, maxAttempts, errorDuration) {
        // Network errors (TypeError: Failed to fetch)
        if (error instanceof TypeError) {
            log.error(`🚨 D1 Network Error: ${error.message}`);
            log.error(`🚨 D1 Network Error Context - Attempt: ${attempts + 1}/${maxAttempts}, Duration: ${errorDuration}ms`);
            log.error(`🚨 D1 Network Error Details - Error Type: ${error.name}, Stack: ${error.stack?.split('\n')[1]?.trim() || 'N/A'}`);

            if (attempts < maxAttempts - 1) {
                log.warn(`⏳ D1 Retrying in 2s... (Attempt ${attempts + 1}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return true; // Signal retry
            }

            log.error(`💥 D1 Max retries exceeded after ${maxAttempts} attempts, total duration: ${errorDuration}ms`);
            this._handleTransientFailure();
            throw new Error("D1 Error: Network connection lost (Max retries exceeded)");
        }

        // 📊 诊断日志：其他错误
        log.error(`🚨 D1 Unexpected Error - Type: ${error.constructor.name}, Message: ${error.message}`);
        log.error(`🚨 D1 Error Context - Attempt: ${attempts + 1}/${maxAttempts}, Duration: ${errorDuration}ms`);

        // Re-throw other errors (like client errors already handled above)
        throw error;
    }

    async _execute(sql, params = []) {
        await this._validateConfig();

        let attempts = 0;
        const maxAttempts = 3;
        const startTime = Date.now();

        while (attempts < maxAttempts) {
            try {
                const response = await this._doFetch(sql, params, attempts, maxAttempts);
                const duration = Date.now() - startTime;

                log.debug(`🔍 D1 Response [Attempt ${attempts + 1}] - Status: ${response.status}, Duration: ${duration}ms`);

                if (!response.ok) {
                    const shouldRetry = await this._handleHttpError(response, attempts, maxAttempts, duration);
                    if (shouldRetry) {
                        attempts++;
                        continue;
                    }
                }

                return await this._parseResponse(response);
            } catch (error) {
                const errorDuration = Date.now() - startTime;
                const shouldRetry = await this._handleRequestError(error, attempts, maxAttempts, errorDuration);
                
                if (shouldRetry) {
                    attempts++;
                    continue;
                }
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

    _handleTransientFailure() {
        log.warn("⚠️ D1 transient failure detected; resetting HTTP state to recover automatically.");
        this._reset();
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
