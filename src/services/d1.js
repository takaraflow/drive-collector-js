import { logger } from "./logger/index.js";
import {
    D1_ACCOUNT_ID_ENV_KEYS,
    D1_DATABASE_ID_ENV_KEYS,
    D1_TOKEN_ENV_KEYS,
    firstEnvValue
} from "../config/env-aliases.js";

const log = logger.withModule ? logger.withModule('D1') : logger;

function summarizeSqlParams(params = []) {
    return params.map((param) => {
        if (param === null) return { type: 'null' };
        if (param === undefined) return { type: 'undefined' };
        if (Buffer.isBuffer(param)) return { type: 'buffer', bytes: param.length };
        if (Array.isArray(param)) return { type: 'array', length: param.length };
        if (typeof param === 'string') return { type: 'string', length: param.length };
        if (typeof param === 'object') return { type: 'object', keys: Object.keys(param).length };
        return { type: typeof param };
    });
}

function summarizeSql(sql = '') {
    const operation = String(sql).trim().split(/\s+/)[0]?.toUpperCase() || 'UNKNOWN';
    return { operation, length: String(sql).length };
}

const D1_RETRY_DELAY_MS = 2000;
const D1_RETRYABLE_CLIENT_ERROR_CODES = new Set([7500, 7429]);

function normalizeD1ErrorCode(code) {
    const numeric = Number(code);
    return Number.isFinite(numeric) ? numeric : null;
}

function isRetryableD1ClientError(status, errorCode) {
    if (status === 429) return true;
    return status === 400 && D1_RETRYABLE_CLIENT_ERROR_CODES.has(errorCode);
}

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

        this.accountId = firstEnvValue(process.env, D1_ACCOUNT_ID_ENV_KEYS);
        this.databaseId = firstEnvValue(process.env, D1_DATABASE_ID_ENV_KEYS);
        this.token = firstEnvValue(process.env, D1_TOKEN_ENV_KEYS);

        if (!this.accountId || !this.databaseId || !this.token) {
            log.warn("⚠️ D1配置不完整: 请检查 CLOUDFLARE_D1_* (或兼容别名 CF_D1_*/CLOUDFLARE_ACCOUNT_ID/CF_ACCOUNT_ID)");
        } else {
            this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
            this.isInitialized = true;
            log.info("D1 service initialized", {
                accountConfigured: true,
                databaseConfigured: true,
                endpoint: 'cloudflare-d1-query'
            });
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

    async _doFetchPayload(payload, attempts, maxAttempts, context = {}) {
        // 📊 诊断日志：请求开始
        log.debug("D1 request attempt", {
            attempt: attempts + 1,
            maxAttempts,
            endpoint: 'cloudflare-d1-query'
        });
        if (context.statements) {
            log.debug("D1 batch statement summary", {
                statementCount: context.statements.length,
                statements: context.statements.map(statement => ({
                    sql: summarizeSql(statement.sql),
                    params: summarizeSqlParams(statement.params || [])
                }))
            });
        } else {
            const sql = context.sql || '';
            const params = context.params || [];
            log.debug("D1 statement summary", {
                sql: summarizeSql(sql),
                params: summarizeSqlParams(params)
            });
        }

        return await fetch(this.apiUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
    }

    async _doFetch(sql, params, attempts, maxAttempts) {
        return this._doFetchPayload({ sql, params }, attempts, maxAttempts, { sql, params });
    }

    async _handleHttpError(response, attempts, maxAttempts, duration) {
        // 对于 401 错误，记录更详细的上下文但不泄露完整 token
        if (response.status === 401) {
            log.error(`🚨 D1 Authentication Failed. Token: ${this.token ? 'present' : 'missing'}`);
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

        const normalizedErrorCode = normalizeD1ErrorCode(errorCode);
        const isRetryableClientError = isRetryableD1ClientError(response.status, normalizedErrorCode);
        const isRetryableHttpError = response.status >= 500 || isRetryableClientError;
        const willRetry = isRetryableHttpError && attempts < maxAttempts - 1;
        const logFailure = willRetry ? log.warn.bind(log) : log.error.bind(log);

        // 📊 诊断日志：详细错误信息
        logFailure(`${willRetry ? '⚠️' : '🚨'} D1 HTTP ${response.status} - ${response.statusText}${errorDetails}`);
        logFailure(`${willRetry ? '⚠️' : '🚨'} D1 Error Details - Code: ${errorCode}, Message: ${errorMessage}`);
        logFailure(`${willRetry ? '⚠️' : '🚨'} D1 Request Context - Attempt: ${attempts + 1}/${maxAttempts}, Duration: ${duration}ms`);
        logFailure("D1 config status", {
            accountConfigured: Boolean(this.accountId),
            databaseConfigured: Boolean(this.databaseId),
            endpoint: 'cloudflare-d1-query'
        });

        // Client errors (4xx) should not retry unless Cloudflare marks them as transient.
        if (response.status >= 400 && response.status < 500 && !isRetryableClientError) {
            throw new Error(`D1 HTTP ${response.status}${errorDetails}`);
        }

        // Retry bounded transient errors surfaced by D1/DO infrastructure.
        if (willRetry) {
            await new Promise(resolve => setTimeout(resolve, D1_RETRY_DELAY_MS));
            return true; // Signal retry
        }

        // Max retries exceeded
        if (isRetryableClientError) {
            this._handleTransientFailure();
            throw new Error(`D1 transient error persisted after retries: HTTP ${response.status}${errorDetails}`);
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
            const willRetry = attempts < maxAttempts - 1;
            const logFailure = willRetry ? log.warn.bind(log) : log.error.bind(log);
            logFailure(`${willRetry ? '⚠️' : '🚨'} D1 Network Error: ${error.message}`);
            logFailure(`${willRetry ? '⚠️' : '🚨'} D1 Network Error Context - Attempt: ${attempts + 1}/${maxAttempts}, Duration: ${errorDuration}ms`);
            logFailure(`${willRetry ? '⚠️' : '🚨'} D1 Network Error Details - Error Type: ${error.name}, Stack: ${error.stack?.split('\n')[1]?.trim() || 'N/A'}`);

            if (willRetry) {
                log.warn(`⏳ D1 Retrying in ${D1_RETRY_DELAY_MS}ms... (Attempt ${attempts + 1}/${maxAttempts})`);
                await new Promise(resolve => setTimeout(resolve, D1_RETRY_DELAY_MS));
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

    async _executePayload(payload, context = {}, maxAttempts = 3) {
        await this._validateConfig();

        let attempts = 0;
        const startTime = Date.now();

        while (attempts < maxAttempts) {
            try {
                const response = await this._doFetchPayload(payload, attempts, maxAttempts, context);
                const duration = Date.now() - startTime;

                log.debug("D1 response", {
                    attempt: attempts + 1,
                    status: response.status,
                    durationMs: duration
                });

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

    async _execute(sql, params = []) {
        return this._executePayload({ sql, params }, { sql, params }, 3);
    }

    async raw(sql, params = []) {
        await this._validateConfig();
        const rawUrl = this.apiUrl.replace(/\/query$/, "/raw");
        const response = await fetch(rawUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ sql, params }),
        });

        if (!response.ok) {
            await this._handleHttpError(response, 0, 1, 0);
        }

        return await this._parseResponse(response);
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

    async healthCheck() {
        const row = await this.fetchOne("SELECT 1 as ok");
        return row?.ok === 1 || row?.ok === true;
    }

    async run(sql, params = []) {
        const result = await this._execute(sql, params);
        return this._parseMutationResult(result);
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

    _parseMutationResult(result) {
        if (result?.result && result.result[0]) {
            if (result.result[0].results && result.result[0].results[0]) {
                return result.result[0].results[0];
            }
            return result.result[0];
        }
        return result;
    }

    /**
     * 批量执行 SQL 语句。
     * Cloudflare D1 /query accepts batch statements through the documented
     * object envelope `{ batch: [...] }`. Keep that wire format centralized here
     * so repositories only deal with ordered statement results.
     * @param {Array<{sql: string, params: Array}>} statements
     */
    async batch(statements) {
        if (!statements || statements.length === 0) return [];

        const payload = statements.map(statement => ({
            sql: statement.sql,
            params: statement.params || []
        }));

        const responsePayload = await this._executePayload({ batch: payload }, { statements: payload }, 3);
        const results = responsePayload.result || [];
        return results.map((result, index) => {
            const errors = result.error
                ? [result.error]
                : result.errors || [];
            return {
                success: result.success !== false && errors.length === 0,
                result,
                meta: result.meta,
                changes: result.meta?.changes,
                error: errors[0] ? new Error(errors[0].message || String(errors[0])) : undefined,
                index
            };
        });
    }
}

export const d1 = new D1Service();
