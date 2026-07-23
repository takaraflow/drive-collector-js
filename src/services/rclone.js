import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import { getConfig } from "../config/index.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { STRINGS } from "../locales/zh-CN.js";
import { localCache } from "../utils/LocalCache.js";
import { cache } from "./CacheService.js";
import { logger } from "./logger/index.js";
import { DriveProviderFactory } from "./drives/index.js";
import { redactSensitiveText } from "../utils/serializer.js";
import { classifyRcloneError, isRetryableRcloneError, RCLONE_ERROR_CODES } from "../domain/rclone-error.js";
import { getRcloneErrorUserMessage } from "../utils/rcloneErrorMessage.js";
import {
    DRIVE_CONFIG_SCHEMA_VERSION,
    RCLONE_PASSWORD_FORMATS,
    normalizePasswordFormat,
    requiresRcloneObscuredPassword,
    isCanonicalRclonePasswordConfig,
    isVerifiedRclonePasswordConfig,
    markVerifiedRclonePasswordConfig
} from "../domain/drive-credentials.js";
const log = logger.withModule ? logger.withModule('RcloneService') : logger;

const buildRcloneEnv = () => ({
    ...process.env,
    LC_ALL: "C",
    LANG: "C"
});

const getRuntimeConfig = () => getConfig();

// 确定 rclone 二进制路径 (兼容 Zeabur 和 本地)
const rcloneBinary = fs.existsSync("/app/rclone/rclone") 
    ? "/app/rclone/rclone" 
    : "rclone";

const sanitizeRemoteFileName = (fileName) => {
    const baseName = path.basename(String(fileName || "").trim());
    return baseName || "unnamed.bin";
};

const DEFAULT_RCLONE_PROCESS_ATTEMPTS = 3;
const DEFAULT_RCLONE_RETRY_BASE_DELAY_MS = 1000;
const NON_RETRYABLE_RCLONE_ERROR_CODES = new Set([
    RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID,
    RCLONE_ERROR_CODES.DRIVE_CONFIG_INVALID,
    RCLONE_ERROR_CODES.DRIVE_QUOTA_EXCEEDED,
    RCLONE_ERROR_CODES.DRIVE_PERMISSION_DENIED
]);

export class CloudTool {
    static loading = false;

    static sanitizeRcloneOutput(value) {
        return redactSensitiveText(value);
    }

    static _buildRcloneError(ret, fallback) {
        return this.sanitizeRcloneOutput(ret?.stderr || ret?.error?.message || fallback || "rclone command failed");
    }

    static _isRetryableRcloneError(errorText) {
        return isRetryableRcloneError(errorText);
    }

    static classifyRcloneError(errorText, options = {}) {
        return classifyRcloneError(errorText, options);
    }

    static _buildFailureResult(finalError, options = {}) {
        const classification = this.classifyRcloneError(finalError, options);
        const retryable = options.retryable !== false && classification.retryable === true;
        const error = String(this.sanitizeRcloneOutput(finalError || "rclone command failed") || "rclone command failed").trim();
        return {
            success: false,
            error,
            retryable,
            errorCode: classification.code,
            userMessage: getRcloneErrorUserMessage(classification.code),
            userRetryable: classification.userRetryable
        };
    }

    static _buildFailureError(failureResult) {
        const error = new Error(failureResult?.error || "rclone command failed");
        error.errorCode = failureResult?.errorCode;
        error.userMessage = failureResult?.userMessage;
        error.retryable = failureResult?.retryable;
        error.userRetryable = failureResult?.userRetryable;
        error.error = failureResult?.error;
        return error;
    }

    static _isRemoteNotFoundError(stderr = "") {
        return /directory not found|object not found|error listing|Object \(typically, node or user\) not found/i.test(stderr);
    }

    static _classifyRcloneFailure(ret, options = {}) {
        return this.classifyRcloneError(
            this._buildRcloneError(ret, `rclone exited with code ${ret?.code}`),
            options
        );
    }

    static _isRemotePathNotFound(ret, options = {}) {
        return this._classifyRcloneFailure(ret, {
            ...options,
            remotePathScoped: true
        }).code === RCLONE_ERROR_CODES.DRIVE_REMOTE_NOT_FOUND;
    }

    static async _verifyRemoteRootAvailable(connectionString, timeout = 15000) {
        const ret = await this._runRclone(["lsjson", "--max-depth", "1", connectionString], timeout);
        if (ret.code === 0) {
            return { available: true };
        }

        const failure = this._buildFailureResult(
            this._buildRcloneError(ret, `rclone root probe exited with code ${ret.code}`),
            { operation: "lsjson", remotePathScoped: false }
        );
        return {
            available: false,
            failure
        };
    }

    static _getRcloneCredentialCandidateFactories(password, format) {
        const normalizedFormat = normalizePasswordFormat(format);
        const storedPassword = String(password || "");
        const asStored = (source) => ({
            source,
            create: async () => storedPassword
        });
        const asObscured = (source) => ({
            source,
            create: async () => this._obscureRequired(storedPassword)
        });

        if (normalizedFormat === RCLONE_PASSWORD_FORMATS.PLAIN) {
            return [asObscured("plain")];
        }

        if (normalizedFormat === RCLONE_PASSWORD_FORMATS.RCLONE_OBSCURED) {
            return [
                asStored("stored_rclone_obscured"),
                asObscured("stored_plain_repaired_from_misclassified_rclone_obscured")
            ];
        }

        if (normalizedFormat === RCLONE_PASSWORD_FORMATS.LEGACY_UNKNOWN || !normalizedFormat) {
            return [
                asStored("stored_legacy_unknown"),
                asObscured("legacy_plain")
            ];
        }

        return [asObscured("unknown_format_plain")];
    }

    static async _persistVerifiedRclonePasswordConfig(activeDrive, userId, driveConfig, pass, migrationSource) {
        if (!activeDrive?.id) return;

        const verifiedConfig = markVerifiedRclonePasswordConfig(driveConfig, pass, { migrationSource });
        try {
            await DriveRepository.updateConfigData(activeDrive.user_id || userId, activeDrive.id, verifiedConfig);
        } catch (error) {
            log.warn("Failed to persist verified drive password config", {
                userId,
                driveId: activeDrive.id,
                type: activeDrive.type,
                error: error.message
            });
        }
    }

    static async _resolveVerifiedRclonePasswordConfig(activeDrive, userId, driveConfig, runtimeConfig) {
        const candidateFactories = this._getRcloneCredentialCandidateFactories(
            driveConfig.pass,
            driveConfig.pass_format
        );
        const failures = [];
        const seenPasswords = new Set();

        for (const candidateFactory of candidateFactories) {
            let candidatePass;
            try {
                candidatePass = await candidateFactory.create();
            } catch (error) {
                failures.push(this._buildFailureResult(
                    this.sanitizeRcloneOutput(error.message),
                    { operation: "credential_migration", remotePathScoped: false }
                ));
                continue;
            }

            if (!candidatePass || seenPasswords.has(candidatePass)) {
                continue;
            }
            seenPasswords.add(candidatePass);

            const candidateConfig = {
                ...runtimeConfig,
                pass: candidatePass,
                pass_format: RCLONE_PASSWORD_FORMATS.RCLONE_OBSCURED,
                config_schema_version: DRIVE_CONFIG_SCHEMA_VERSION
            };
            const connectionString = this._getConnectionString(candidateConfig);
            const probe = await this._verifyRemoteRootAvailable(connectionString, 20000);

            if (probe.available) {
                await this._persistVerifiedRclonePasswordConfig(
                    activeDrive,
                    userId,
                    driveConfig,
                    candidatePass,
                    candidateFactory.source
                );

                if (candidateFactory.source !== "stored_rclone_obscured") {
                    log.info("Verified and repaired historical rclone drive credential", {
                        userId,
                        driveId: activeDrive.id,
                        type: activeDrive.type,
                        migrationSource: candidateFactory.source
                    });
                }

                return {
                    ...markVerifiedRclonePasswordConfig(driveConfig, candidatePass, {
                        migrationSource: candidateFactory.source
                    }),
                    type: activeDrive.type
                };
            }

            if (probe.failure?.retryable) {
                throw this._buildFailureError(probe.failure);
            }

            if (![
                RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID,
                RCLONE_ERROR_CODES.DRIVE_CONFIG_INVALID,
                RCLONE_ERROR_CODES.DRIVE_REMOTE_NOT_FOUND
            ].includes(probe.failure?.errorCode)) {
                throw this._buildFailureError(probe.failure);
            }

            failures.push(probe.failure);
        }

        const failure = failures.find(item => item?.errorCode === RCLONE_ERROR_CODES.DRIVE_AUTH_INVALID) ||
            failures.find(item => item?.errorCode === RCLONE_ERROR_CODES.DRIVE_CONFIG_INVALID) ||
            failures[0] ||
            this._buildFailureResult("Drive credential verification failed", {
                operation: "credential_migration",
                remotePathScoped: false
            });
        throw this._buildFailureError(failure);
    }

    static async _resolvePathScopedNotFound(ret, connectionString, {
        rootTimeout = 15000,
        missingResult = null
    } = {}) {
        if (!ret?.stderr || !this._isRemotePathNotFound(ret)) {
            return null;
        }

        const rootProbe = await this._verifyRemoteRootAvailable(connectionString, rootTimeout);
        if (!rootProbe.available) {
            throw this._buildFailureError(rootProbe.failure);
        }

        return missingResult;
    }

    static async _ensureUploadDirectory(connectionString, userUploadPath, options = {}) {
        const normalizedUploadPath = this._normalizePath(userUploadPath);
        if (!normalizedUploadPath || normalizedUploadPath === "/") {
            return { success: true };
        }

        const fullRemotePath = this._joinRemotePath(connectionString, normalizedUploadPath);
        const configArgs = Array.isArray(options.configArgs) ? options.configArgs : ['--config', '/dev/null'];
        // _runRclone forces --config /dev/null; for writable runtimes spawn with explicit configArgs.
        const ret = await new Promise((resolve) => {
            let completed = false;
            try {
                const proc = spawn(rcloneBinary, [...configArgs, 'mkdir', fullRemotePath], { env: buildRcloneEnv() });
                const timer = setTimeout(() => {
                    if (completed) return;
                    completed = true;
                    try { proc.kill('SIGKILL'); } catch {}
                    resolve({ code: -1, stdout: '', stderr: 'TIMEOUT', error: new Error('Node.js enforced timeout') });
                }, 15000);
                let stdout = '';
                let stderr = '';
                proc.stdout.on('data', (d) => { stdout += d.toString(); });
                proc.stderr.on('data', (d) => { stderr += d.toString(); });
                proc.on('close', (code) => {
                    if (completed) return;
                    completed = true;
                    clearTimeout(timer);
                    resolve({ code, stdout, stderr });
                });
                proc.on('error', (err) => {
                    if (completed) return;
                    completed = true;
                    clearTimeout(timer);
                    resolve({ code: -1, stdout, stderr, error: err });
                });
            } catch (error) {
                resolve({ code: -1, stdout: '', stderr: error.message, error });
            }
        });
        if (ret.code === 0) {
            return { success: true };
        }

        try {
            await this._resolvePathScopedNotFound(ret, connectionString);
        } catch (error) {
            return {
                success: false,
                error: error.error || error.message,
                retryable: error.retryable === true,
                errorCode: error.errorCode || RCLONE_ERROR_CODES.UNKNOWN,
                userMessage: error.userMessage,
                userRetryable: error.userRetryable !== false
            };
        }

        return this._buildFailureResult(
            this._buildRcloneError(ret, `rclone mkdir exited with code ${ret.code}`),
            { operation: "mkdir", remotePathScoped: true }
        );
    }

    static async _retryDelay(attempt, signal) {
        if (signal?.aborted) return false;
        const delayMs = DEFAULT_RCLONE_RETRY_BASE_DELAY_MS * Math.max(1, attempt);
        if (!signal) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
            return true;
        }

        return await new Promise(resolve => {
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', abortHandler);
                resolve(true);
            }, delayMs);
            const abortHandler = () => {
                clearTimeout(timer);
                resolve(false);
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        });
    }

    static sanitizeRemoteFileName(fileName) {
        return sanitizeRemoteFileName(fileName);
    }

    static async _getUserConfig(userId) {
        if (!userId) throw new Error(STRINGS.drive.user_id_required);

        const activeDrive = await DriveRepository.getDefaultDrive(userId);

        if (!activeDrive) {
            throw new Error(STRINGS.drive.no_drive_found);
        }
        
        const driveConfig = JSON.parse(activeDrive.config_data);
        
        // 3. 使用 Provider 处理密码混淆
        const provider = DriveProviderFactory.getProvider(activeDrive.type);
        
        // Clone config and inject type
        let config = { ...driveConfig, type: activeDrive.type };

        // Allow provider to process password if present
        if (config.pass) {
            if (requiresRcloneObscuredPassword(activeDrive.type)) {
                if (isVerifiedRclonePasswordConfig(driveConfig)) {
                    config.pass = driveConfig.pass;
                    config.pass_format = RCLONE_PASSWORD_FORMATS.RCLONE_OBSCURED;
                    config.config_schema_version = DRIVE_CONFIG_SCHEMA_VERSION;
                } else {
                    return await this._resolveVerifiedRclonePasswordConfig(activeDrive, userId, driveConfig, config);
                }
            } else {
                const wasCanonical = isCanonicalRclonePasswordConfig(driveConfig);
                config.pass = await provider.processPassword(config.pass, config);
                if (wasCanonical) {
                    config.pass_format = RCLONE_PASSWORD_FORMATS.RCLONE_OBSCURED;
                    config.config_schema_version = DRIVE_CONFIG_SCHEMA_VERSION;
                }
            }
        }

        if (typeof provider.prepareConfigForRuntime === "function") {
            config = await provider.prepareConfigForRuntime(config);
        }

        if (typeof provider.ensureRuntimeSession === "function") {
            config = await provider.ensureRuntimeSession(config, {
                activeDrive,
                userId,
                cloudTool: this
            });
        }
        
        // 4. 返回清洗后的配置对象
        return config;
    }

    static _joinRemotePath(connectionString, ...segments) {
        const base = String(connectionString || "");
        const cleaned = segments
            .filter(segment => segment !== undefined && segment !== null)
            .map(segment => String(segment))
            .filter(segment => segment.length > 0)
            .map(segment => segment.replace(/^\/+/, '').replace(/\/+$/, ''))
            .filter(segment => segment.length > 0);

        if (cleaned.length === 0) {
            return base;
        }

        const suffix = cleaned.join('/');
        return `${base}${base.endsWith(':') || base.endsWith('/') ? '' : '/'}${suffix}`;
    }

    /**
     * 【重构】统一的 rclone 进程执行助手
     * 处理 spawn、超时保护、错误缓冲和日志
     * @private
     */
    static async _runRclone(args, timeout = 30000) {
        return new Promise((resolve, reject) => {
            let completed = false;
            try {
                const fullArgs = ["--config", "/dev/null", ...args];
                const proc = spawn(rcloneBinary, fullArgs, { env: buildRcloneEnv() });

                const timer = setTimeout(() => {
                    if (!completed) {
                        completed = true;
                        try { proc.kill('SIGKILL'); } catch (e) { }
                        resolve({ code: -1, stdout: "", stderr: "TIMEOUT", error: new Error("Node.js enforced timeout") });
                    }
                }, timeout);

                let stdout = "";
                let stderr = "";

                proc.stdout.on("data", (data) => stdout += data.toString());
                proc.stderr.on("data", (data) => stderr += data.toString());

                proc.on("close", (code) => {
                    if (completed) return;
                    completed = true;
                    clearTimeout(timer);
                    resolve({ code, stdout, stderr });
                });

                proc.on("error", (err) => {
                    if (completed) return;
                    completed = true;
                    clearTimeout(timer);
                    resolve({ code: -1, stdout, stderr, error: err });
                });
            } catch (e) {
                if (!completed) {
                    completed = true;
                    resolve({ code: -1, stdout: "", stderr: e.message, error: e });
                }
            }
        });
    }

    /**
     * 【重要修复】调用 rclone obscure 对密码进行混淆
     * 异步非阻塞版，杜绝 Shell 注入
     */
    static async _obscure(password) {
        if (!password) return "";
        try {
            return await this._obscureRequired(password);
        } catch (e) {
            log.error("Password obscure error:", e);
            return password;
        }
    }

    static async _obscureRequired(password) {
        if (!password) return "";
        const ret = await this._runRclone(["obscure", "--", password], 5000);
        if (ret.code !== 0) {
            throw new Error(this.sanitizeRcloneOutput(ret.stderr || ret.error?.message || "rclone obscure failed"));
        }
        const obscured = ret.stdout?.trim();
        if (!obscured) {
            throw new Error("rclone obscure returned an empty password");
        }
        return obscured;
    }

    static async _reveal(password) {
        if (!password) return null;
        try {
            const ret = await this._runRclone(["reveal", "--", password], 5000);
            if (ret.code !== 0) return null;
            const revealed = ret.stdout?.trim();
            return revealed || null;
        } catch {
            return null;
        }
    }

    static async normalizePasswordForRclone(password, options = {}) {
        if (!password) return "";
        const format = normalizePasswordFormat(options.format);
        if (format === RCLONE_PASSWORD_FORMATS.RCLONE_OBSCURED) {
            return password;
        }
        if (format === RCLONE_PASSWORD_FORMATS.PLAIN) {
            return await this._obscureRequired(password);
        }
        if (format === RCLONE_PASSWORD_FORMATS.LEGACY_UNKNOWN || !format) {
            if (typeof this._reveal === "function") {
                const revealed = await this._reveal(password);
                if (revealed) {
                    return password;
                }
            }
            return await this._obscureRequired(password);
        }
        return await this._obscureRequired(password);
    }

    /**
     * 辅助方法：构造安全的连接字符串
     */
    static _getConnectionString(conf) {
        try {
            const provider = DriveProviderFactory.getProvider(conf.type);
            return provider.getConnectionString(conf);
        } catch (e) {
            log.error(`Failed to get connection string for type ${conf.type}:`, e);
            throw e;
        }
    }

    /**
     * Escape a value for rclone conf file format.
     * @private
     */
    static _escapeRcloneConfValue(value) {
        return String(value ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
    }

    /**
     * Build a temporary rclone remote conf body for providers that need writable session state.
     * @private
     */
    static _buildTemporaryRcloneConf(remoteName, conf = {}) {
        const provider = DriveProviderFactory.getProvider(conf.type);
        const backend = typeof provider.getRcloneBackendType === 'function'
            ? provider.getRcloneBackendType()
            : conf.type;
        const lines = [`[${remoteName}]`, `type = ${backend}`];

        if (typeof provider.getWritableRcloneConfigEntries === 'function') {
            const entries = provider.getWritableRcloneConfigEntries(conf) || {};
            for (const [key, value] of Object.entries(entries)) {
                if (value === undefined || value === null || value === '') continue;
                lines.push(`${key} = ${this._escapeRcloneConfValue(value)}`);
            }
        }

        return `${lines.join('\n')}\n`;
    }

    /**
     * Parse simple rclone conf dump/file content into a key/value map for one remote.
     * @private
     */
    static _parseRcloneConfSection(confText, remoteName) {
        const lines = String(confText || '').split(/\r?\n/);
        let inSection = false;
        const values = {};
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#') || line.startsWith(';')) continue;
            const sectionMatch = line.match(/^\[([^\]]+)\]$/);
            if (sectionMatch) {
                inSection = sectionMatch[1] === remoteName;
                continue;
            }
            if (!inSection) continue;
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            const key = line.slice(0, eq).trim();
            // Keep raw value after first '='; tokens may contain '='.
            let value = line.slice(eq + 1).trim();
            if (
                (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
                (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
            ) {
                value = value.slice(1, -1);
            }
            values[key] = value;
        }
        return values;
    }

    /**
     * Run an rclone command against a temporary named remote config, then return
     * any config keys the backend wrote back (e.g. Proton session tokens).
     */
    static async runWithWritableRcloneConfig(conf, commandArgs = [], options = {}) {
        const timeout = Number.isFinite(options.timeout) ? options.timeout : 30000;
        const remoteName = options.remoteName || 'tmpdrive';
        const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rclone-conf-'));
        const configPath = path.join(tempDir, 'rclone.conf');

        try {
            const body = this._buildTemporaryRcloneConf(remoteName, conf);
            await fsp.writeFile(configPath, body, { encoding: 'utf8', mode: 0o600 });

            const args = ['--config', configPath, ...commandArgs.map((arg) => (
                arg === '__REMOTE__' ? `${remoteName}:` : String(arg).replaceAll('__REMOTE__', `${remoteName}:`)
            ))];

            // Bypass _runRclone because it forces --config /dev/null.
            const ret = await new Promise((resolve) => {
                let completed = false;
                try {
                    const proc = spawn(rcloneBinary, args, { env: buildRcloneEnv() });
                    const timer = setTimeout(() => {
                        if (completed) return;
                        completed = true;
                        try { proc.kill('SIGKILL'); } catch {}
                        resolve({ code: -1, stdout: '', stderr: 'TIMEOUT', error: new Error('Node.js enforced timeout') });
                    }, timeout);

                    let stdout = '';
                    let stderr = '';
                    proc.stdout.on('data', (data) => { stdout += data.toString(); });
                    proc.stderr.on('data', (data) => { stderr += data.toString(); });
                    proc.on('close', (code) => {
                        if (completed) return;
                        completed = true;
                        clearTimeout(timer);
                        resolve({ code, stdout, stderr });
                    });
                    proc.on('error', (err) => {
                        if (completed) return;
                        completed = true;
                        clearTimeout(timer);
                        resolve({ code: -1, stdout, stderr, error: err });
                    });
                } catch (error) {
                    resolve({ code: -1, stdout: '', stderr: error.message, error });
                }
            });

            const confText = await fsp.readFile(configPath, 'utf8').catch(() => '');
            const remoteConfig = this._parseRcloneConfSection(confText, remoteName);
            return {
                ...ret,
                remoteName,
                remoteConfig
            };
        } finally {
            await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    /**
     * Validate config. Providers that need durable session bootstrap can opt into writable conf.
     */
    static async validateConfigWithWritableSession(type, configData, checkCommand = 'about') {
        const conf = { ...configData, type };
        const provider = DriveProviderFactory.getProvider(type);
        const finalCheckCommand = checkCommand === 'about'
            ? provider.getValidationCommand()
            : checkCommand;

        const commandArgs = finalCheckCommand === 'about' || finalCheckCommand === 'version'
            ? [finalCheckCommand, '__REMOTE__', '--timeout', '15s']
            : [finalCheckCommand, '__REMOTE__', '--max-depth', '1', '--timeout', '15s'];

        const ret = await this.runWithWritableRcloneConfig(
            conf,
            commandArgs,
            { timeout: 25000 }
        );

        if (ret.code === 0) {
            return {
                success: true,
                remoteConfig: ret.remoteConfig || {}
            };
        }

        const errorLog = this.sanitizeRcloneOutput(ret.stderr || ret.error?.message || '');
        if (/Multi-factor authentication|\b2FA\b|auth\/v4\/2fa|Code=8002/i.test(errorLog)) {
            return { success: false, reason: '2FA', details: errorLog, remoteConfig: ret.remoteConfig || {} };
        }
        return { success: false, reason: 'ERROR', details: errorLog, remoteConfig: ret.remoteConfig || {} };
    }

    /**
     * Open a per-user rclone remote runtime.
     * Session-capable providers (e.g. Proton Drive) get a temporary writable conf so refreshed
     * tokens can be harvested after the command completes.
     * @private
     */
    static async _openUserRemoteRuntime(userId, conf = null) {
        const resolvedConf = conf || await this._getUserConfig(userId);
        const provider = DriveProviderFactory.getProvider(resolvedConf.type);
        const usesWritableConf = typeof provider.getWritableRcloneConfigEntries === 'function';

        if (!usesWritableConf) {
            const connectionString = this._getConnectionString(resolvedConf);
            return {
                conf: resolvedConf,
                provider,
                connectionString,
                configArgs: ['--config', '/dev/null'],
                remoteName: null,
                configPath: null,
                tempDir: null,
                async finalize() {
                    return resolvedConf;
                },
                async dispose() {}
            };
        }

        const remoteName = `u${String(userId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'anon'}`;
        const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rclone-user-'));
        const configPath = path.join(tempDir, 'rclone.conf');
        const body = this._buildTemporaryRcloneConf(remoteName, resolvedConf);
        await fsp.writeFile(configPath, body, { encoding: 'utf8', mode: 0o600 });

        let finalized = false;
        const runtime = {
            conf: resolvedConf,
            provider,
            connectionString: `${remoteName}:`,
            configArgs: ['--config', configPath],
            remoteName,
            configPath,
            tempDir,
            async finalize() {
                if (finalized) return runtime.conf;
                finalized = true;
                try {
                    const confText = await fsp.readFile(configPath, 'utf8').catch(() => '');
                    const remoteConfig = CloudTool._parseRcloneConfSection(confText, remoteName);
                    if (typeof provider.mergeRuntimeSessionFromRemoteConfig === 'function') {
                        const merged = await provider.mergeRuntimeSessionFromRemoteConfig(resolvedConf, remoteConfig, {
                            userId,
                            cloudTool: CloudTool
                        });
                        if (merged) runtime.conf = merged;
                    }
                } catch (error) {
                    log.warn('Failed to finalize writable rclone runtime session', {
                        userId,
                        type: resolvedConf.type,
                        error: error.message
                    });
                }
                return runtime.conf;
            },
            async dispose() {
                await runtime.finalize();
                await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
            }
        };
        return runtime;
    }

    /**
     * 获取用户的上传路径
     * 优先级：用户自定义路径 > 系统默认路径
     * @param {string} userId - 用户ID
     * @returns {Promise<string>} 上传路径（不带开头斜杠，带结尾斜杠）
     */
    static async _getUploadPath(userId) {
        try {
            // 尝试从D1数据库获取用户自定义路径
            const userPath = await this._getUserUploadPathFromD1(userId);
            
            if (userPath) {
                // 验证路径格式并标准化
                const normalizedPath = this._normalizePath(userPath);
                if (normalizedPath) {
                    return normalizedPath;
                }
            }
            
            // 兜底：使用系统默认路径
            return this._normalizePath(getRuntimeConfig().remoteFolder);
        } catch (error) {
            log.error(`Failed to get upload path for user ${userId}:`, error);
            // 出错时使用默认路径
            return this._normalizePath(getRuntimeConfig().remoteFolder);
        }
    }

    /**
     * 从D1数据库获取用户上传路径
     * @param {string} userId - 用户ID
     * @returns {Promise<string|null>} 用户自定义路径或null
     */
    static async _getUserUploadPathFromD1(userId) {
        try {
            const activeDrive = await DriveRepository.getDefaultDrive(userId);
            
            if (activeDrive && activeDrive.remote_folder) {
                return activeDrive.remote_folder;
            }
            
            return null;
        } catch (error) {
            log.error(`Failed to query upload path from D1 for user ${userId}:`, error);
            return null;
        }
    }

    /**
     * 路径标准化处理
     * @param {string} path - 原始路径
     * @returns {string} 标准化后的路径（不带开头斜杠，带结尾斜杠）
     */
    static _normalizePath(path) {
        if (!path) return "/";
        
        // 移除开头的斜杠（rclone 路径不需要开头斜杠）
        let normalized = path.replace(/^\/+/, '');
        
        // 如果为空了，返回根目录
        if (!normalized) return "/";
        
        // 确保以斜杠结尾
        if (!normalized.endsWith('/')) {
            normalized += '/';
        }
        
        return normalized;
    }

    /**
     * 验证路径格式
     * @param {string} path - 待验证的路径
     * @returns {boolean} 是否有效
     */
    static _validatePath(inputPath) {
        if (!inputPath || typeof inputPath !== 'string') return false;
        
        let path = inputPath.trim();
        
        // 必须以 / 开头
        if (!path.startsWith('/')) return false;
        
        // 不能包含特殊字符（除了 /, -, _, ., 空格）
        if (!/^[\/a-zA-Z0-9\s_\-\.]+$/.test(path)) return false;
        
        // 不能包含连续的斜杠
        if (path.includes('//')) return false;
        
        // 不能以 / 结尾（因为我们会自动添加）
        if (path.endsWith('/')) return false;
        
        // 路径长度限制
        if (path.length > 255) return false;
        
        // 防御路径遍历攻击 - 拒绝 .. 
        const normalizedPath = path.normalize('NFC');
        if (normalizedPath.includes('..')) return false;
        
        // 拒绝 . 路径分隔符 (如 /share/./secret 或 /share/.)
        // 但允许文件名中包含 . (如 file.txt, .env)
        if (path.includes('/.') || path.endsWith('.')) return false;
        
        // 检查 URL 编码的 .. (%2e%2e, %2e., .%2e)
        const lowerPath = path.toLowerCase();
        if (lowerPath.includes('%2e%2e') || 
            lowerPath.includes('%2e.') || 
            lowerPath.includes('.%2e')) {
            return false;
        }
        
        // 使用 path.normalize 规范化后验证路径仍然有效
        // 这可以捕获如 /foo/./bar 之类的情况
        const resolvedPath = path.normalize('NFC');
        if (!resolvedPath.startsWith('/')) return false;
        if (resolvedPath.includes('..')) return false;
        
        return true;
    }

    /**
     * 【重构】验证配置是否有效 (异步非阻塞版)
     */
    static async validateConfig(type, configData, checkCommand = "about") {
        return new Promise((resolve) => {
            let completed = false;
            try {
                const conf = { ...configData, type };
                const connectionString = this._getConnectionString(conf);

                const provider = DriveProviderFactory.getProvider(type);
                const finalCheckCommand = (checkCommand === "about")
                    ? provider.getValidationCommand()
                    : checkCommand;

                const args = ["--config", "/dev/null", finalCheckCommand, connectionString, "--max-depth", "1", "--timeout", "15s"];

                const proc = spawn(rcloneBinary, args, { env: buildRcloneEnv() });

                // 增加强杀超时保护 (20s，略长于 rclone 内部超时)
                const timer = setTimeout(() => {
                    if (!completed) {
                        completed = true;
                        try { proc.kill('SIGKILL'); } catch(e) {}
                        resolve({ success: false, reason: "TIMEOUT", details: "Node.js enforced timeout" });
                    }
                }, 20000);

                let errorLog = "";
                proc.stderr.on("data", (data) => {
                    errorLog += data.toString();
                });

                proc.on("close", (code) => {
                    if (completed) return;
                    completed = true;
                    clearTimeout(timer);

                    if (code === 0) {
                        resolve({ success: true });
                    } else {
                        if (errorLog.includes("Multi-factor authentication") || errorLog.includes("2FA")) {
                            resolve({ success: false, reason: "2FA" });
                        } else {
                            log.error("Validation failed. Type:", type);
                            resolve({ success: false, reason: "ERROR", details: this.sanitizeRcloneOutput(errorLog) });
                        }
                    }
                });

                proc.on("error", (err) => {
                    if (completed) return;
                    completed = true;
                    clearTimeout(timer);
                    resolve({ success: false, reason: "ERROR", details: this.sanitizeRcloneOutput(err.message) });
                });

            } catch (e) {
                if (!completed) {
                    completed = true;
                    resolve({ success: false, reason: "ERROR", details: this.sanitizeRcloneOutput(e.message) });
                }
            }
        });
    }

    /**
     * 批量上传文件 (优化版)
     * @param {Array} tasks - 任务对象数组
     * @param {Function} onProgress - 进度回调 (taskId, progressInfo)
     */
    static async uploadBatch(tasks, onProgress) {
        if (!tasks || tasks.length === 0) return { success: true };

        let lastResult = { success: false, error: "rclone upload was not attempted" };
        for (let attempt = 1; attempt <= DEFAULT_RCLONE_PROCESS_ATTEMPTS; attempt++) {
            lastResult = await this._spawnUploadBatchOnce(tasks, onProgress);
            if (lastResult.success || lastResult.error === "CANCELLED") {
                return lastResult;
            }
            if (!lastResult.retryable || attempt >= DEFAULT_RCLONE_PROCESS_ATTEMPTS) {
                return lastResult;
            }

            log.warn("Retrying rclone upload after retryable process failure", {
                attempt,
                maxAttempts: DEFAULT_RCLONE_PROCESS_ATTEMPTS,
                taskIds: tasks.map(task => task.id).filter(Boolean),
                error: lastResult.error
            });
            await this._retryDelay(attempt);
        }

        return lastResult;
    }


    static _appendRcloneError(errorLogRef, value) {
        const text = this.sanitizeRcloneOutput(String(value || "").trim());
        if (!text) return;
        errorLogRef.content += `${text}\n`;
    }

    static _formatRcloneJsonError(logEntry) {
        if (!logEntry || typeof logEntry !== "object") return "";

        const level = String(logEntry.level || "").toLowerCase();
        const msg = String(logEntry.msg || logEntry.message || "").trim();
        const error = String(logEntry.error || "").trim();
        const object = String(logEntry.object || "").trim();
        const source = String(logEntry.source || "").trim();
        const hasErrorLevel = ["error", "fatal", "critical"].includes(level);
        const hasErrorMessage = /(^|\b)(error|failed|failure|critical|fatal|couldn'?t)(\b|:)/i.test(`${msg} ${error}`);

        if (!hasErrorLevel && !hasErrorMessage) return "";

        const parts = [];
        if (level) parts.push(level.toUpperCase());
        if (object) parts.push(object);
        if (msg) parts.push(msg);
        if (error && error !== msg) parts.push(error);
        if (source) parts.push(`source=${source}`);
        return parts.join(" | ");
    }

    static _processRcloneLog(line, tasks, onProgress, errorLogRef) {
        try {
            const logEntry = JSON.parse(line);
            const formattedError = this._formatRcloneJsonError(logEntry);
            if (formattedError) {
                this._appendRcloneError(errorLogRef, formattedError);
            }
            // 解析 rclone JSON 日志中的进度信息
            if (logEntry.msg === "Status update" || (logEntry.stats && String(logEntry.msg || "").includes("progress"))) {
                const stats = logEntry.stats || {};
                if (onProgress && stats.transferring) {
                    // 匹配每个正在传输的文件到对应的任务
                    stats.transferring.forEach(transfer => {
                        // 注意：这里建议加个容错，防止 localPath 为空
                        const task = tasks.find(t => t.localPath && t.localPath.endsWith(transfer.name));
                        if (task) {
                            onProgress(task.id, {
                                percentage: transfer.percentage,
                                speed: transfer.speed,
                                eta: transfer.eta,
                                bytes: transfer.bytes,
                                size: transfer.size
                            });
                        }
                    });
                }
            }
        } catch (e) {
            // 解析失败的行通常是 Rclone 的普通文本错误日志，收集起来
            this._appendRcloneError(errorLogRef, line);
        }
    }

    static _setupUploadProcessHandlers(proc, tasks, safeResolve, onProgress, fileList) {
        this._attachUploadProcessHandlers(proc, tasks, safeResolve, onProgress, fileList, {
            retryable: false,
            operation: "uploadBatch",
            remotePathScoped: true
        });
    }

    static _attachUploadProcessHandlers(proc, tasks, safeResolve, onProgress, fileList, options = {}) {
        let cancelled = false;
        const isAnyTaskCancelled = () => tasks.some(t => t?.isCancelled);
        const markCancelledAndKill = () => {
            if (cancelled) return;
            cancelled = true;
            try {
                if (typeof proc.kill === 'function') proc.kill("SIGTERM");
            } catch (e) {
                log.warn("Failed to kill rclone process", { error: e.message });
            }
        };

        // 处理“先取消后启动上传”的竞态：如果任务已被取消，立即终止进程
        if (isAnyTaskCancelled()) {
            markCancelledAndKill();
        }

        // 【修复 1】添加缓冲区变量，处理流数据分片
        let stderrBuffer = "";
        let errorLogRef = { content: "" };

        proc.stderr.on("data", (data) => {
            if (!cancelled && isAnyTaskCancelled()) {
                markCancelledAndKill();
                return;
            }
            // 拼接到缓冲区
            stderrBuffer += data.toString();

            // 按换行符分割
            const lines = stderrBuffer.split('\n');

            // 【关键】取出最后一个可能不完整的片段，放回缓冲区等待下一次数据
            stderrBuffer = lines.pop();

            for (const line of lines) {
                if (!line.trim()) continue;
                this._processRcloneLog(line, tasks, onProgress, errorLogRef);
            }
        });

        proc.on("close", (code) => {
            if (stderrBuffer.trim()) {
                this._processRcloneLog(stderrBuffer, tasks, onProgress, errorLogRef);
                stderrBuffer = "";
            }
            if (cancelled || isAnyTaskCancelled()) {
                return safeResolve({ success: false, error: "CANCELLED" });
            }
            if (code === 0) {
                // Even with exit code 0, check for errors in the log
                const hasErrors = /(^|\b)(ERROR|CRITICAL|FATAL|Failed|failed|error|fatal)(\b|:)/.test(errorLogRef.content || "");
                if (hasErrors) {
                    const sanitizedTail = this.sanitizeRcloneOutput(errorLogRef.content.slice(-500));
                    const failureResult = this._buildFailureResult(`Upload completed but with errors: ${this.sanitizeRcloneOutput(errorLogRef.content.slice(-200).trim())}`, options);
                    log.error(`Rclone Batch completed with exit code 0 but contains errors`, {
                        error: new Error(sanitizedTail),
                        rcloneExitCode: code,
                        errorCode: failureResult.errorCode,
                        retryable: failureResult.retryable
                    });
                    safeResolve(failureResult);
                } else {
                    safeResolve({ success: true });
                }
            } else {
                const finalError = this.sanitizeRcloneOutput(errorLogRef.content.slice(-500) || `Rclone exited with code ${code}`);
                const failureResult = this._buildFailureResult(finalError, options);
                log.error(`Rclone Batch Error`, {
                    error: new Error(finalError.trim()),
                    rcloneExitCode: code,
                    retryable: failureResult.retryable,
                    errorCode: failureResult.errorCode
                });
                safeResolve(failureResult);
            }
        });

        proc.on("error", (err) => {
            const finalError = this.sanitizeRcloneOutput(err.message);
            safeResolve(this._buildFailureResult(finalError, options));
        });

        // 写入文件列表到 stdin 并关闭
        proc.stdin.write(fileList);
        proc.stdin.end();
    }

    static async _spawnUploadBatchOnce(tasks, onProgress) {
        return new Promise(async (resolve) => {
            let isResolved = false;
            const safeResolve = (value) => {
                if (isResolved) return;
                isResolved = true;
                resolve(value);
            };

            try {
                const firstTask = tasks[0];
                if (tasks.some(t => t?.isCancelled)) {
                    safeResolve({ success: false, error: "CANCELLED" });
                    return;
                }
                const conf = await this._getUserConfig(firstTask.userId);
                const connectionString = this._getConnectionString(conf);
                const userUploadPath = await this._getUploadPath(firstTask.userId);
                const remotePath = this._joinRemotePath(connectionString, userUploadPath);
                const ensureDirectoryResult = await this._ensureUploadDirectory(connectionString, userUploadPath);
                if (!ensureDirectoryResult.success) {
                    safeResolve(ensureDirectoryResult);
                    return;
                }
                const commonSourceDir = path.resolve(getRuntimeConfig().downloadDir || "/tmp/downloads");
                const fileList = tasks
                    .filter(t => t.localPath)
                    .map(t => path.relative(commonSourceDir, path.resolve(t.localPath)))
                    .join('\n');

                const args = [
                    "--config", "/dev/null",
                    "copy", commonSourceDir, remotePath,
                    "--files-from-raw", "-",
                    "--progress",
                    "--use-json-log",
                    "--transfers", "4",
                    "--checkers", "8",
                    "--retries", "3",
                    "--low-level-retries", "10",
                    "--stats", "1s",
                    "--buffer-size", "32M"
                ];

                const proc = spawn(rcloneBinary, args, { env: buildRcloneEnv() });
                tasks.forEach(t => t.proc = proc);
                this._attachUploadProcessHandlers(proc, tasks, safeResolve, onProgress, fileList, {
                    retryable: true,
                    operation: "uploadBatch",
                    remotePathScoped: true
                });
            } catch (e) {
                const finalError = this.sanitizeRcloneOutput(e.message);
                safeResolve(this._buildFailureResult(finalError, { operation: "uploadBatch", remotePathScoped: true }));
            }
        });
    }

    /**
     * 上传单个文件 (内部转调 uploadBatch)
     */
    static async uploadFile(localPath, task, onProgress) {
        task.localPath = localPath;
        return this.uploadBatch([task], (taskId, progress) => {
            if (onProgress) onProgress(progress);
        });
    }

    /**
     * 创建 rcat 流式上传进程
     * @param {string} fileName - 目标文件名
     * @param {string} userId - 用户ID
     * @returns {Object} 包含 stdin 流和进程对象的对象
     */
    static async createRcatStream(fileName, userId, options = {}) {
        const conf = await this._getUserConfig(userId);
        const runtime = await this._openUserRemoteRuntime(userId, conf);
        const userUploadPath = await this._getUploadPath(userId);
        const safeFileName = this.sanitizeRemoteFileName(fileName);
        const fullRemotePath = this._joinRemotePath(runtime.connectionString, userUploadPath, safeFileName);
        const size = Number(options.size);

        try {
            const ensureDirectoryResult = await this._ensureUploadDirectory(
                runtime.connectionString,
                userUploadPath,
                { configArgs: runtime.configArgs }
            );
            if (!ensureDirectoryResult.success) {
                await runtime.dispose();
                throw this._buildFailureError(ensureDirectoryResult);
            }

            const args = [
                ...runtime.configArgs,
                "rcat", fullRemotePath,
                "--progress",
                "--use-json-log",
                "--buffer-size", "32M"
            ];
            if (Number.isFinite(size) && size >= 0) {
                args.push("--size", String(size));
            }

            const proc = spawn(rcloneBinary, args, { env: buildRcloneEnv() });
            let disposed = false;
            const disposeRuntime = async () => {
                if (disposed) return;
                disposed = true;
                await runtime.dispose();
            };
            proc.on('close', () => {
                disposeRuntime().catch(() => {});
            });
            proc.on('error', () => {
                disposeRuntime().catch(() => {});
            });

            return {
                stdin: proc.stdin,
                proc: proc,
                fileName: safeFileName,
                remotePath: this.sanitizeRcloneOutput(fullRemotePath),
                dispose: disposeRuntime
            };
        } catch (error) {
            await runtime.dispose().catch(() => {});
            throw error;
        }
    }

    /**
     * Upload one local file to the user's upload folder under a controlled remote file name.
     * Unlike uploadBatch, this does not preserve the local directory layout.
     */
    static async uploadLocalFileToRemote(localPath, fileName, userId, onProgress, options = {}) {
        if (!localPath) return { success: false, error: "Missing localPath" };
        if (!userId) return { success: false, error: "Missing userId" };

        try {
            if (options.signal?.aborted) {
                return { success: false, error: "Upload cancelled" };
            }

            let lastResult = null;
            for (let attempt = 1; attempt <= DEFAULT_RCLONE_PROCESS_ATTEMPTS; attempt++) {
                lastResult = await this._spawnUploadLocalFileToRemoteOnce(localPath, fileName, userId, onProgress, options);
                if (lastResult.success || lastResult.error === "Upload cancelled") {
                    return lastResult;
                }
                if (!lastResult.retryable || attempt >= DEFAULT_RCLONE_PROCESS_ATTEMPTS) {
                    return lastResult;
                }

                log.warn("Retrying rclone copyto after retryable process failure", {
                    attempt,
                    maxAttempts: DEFAULT_RCLONE_PROCESS_ATTEMPTS,
                    userId,
                    fileName: this.sanitizeRemoteFileName(fileName),
                    error: lastResult.error
                });

                const delayCompleted = await this._retryDelay(attempt, options.signal);
                if (!delayCompleted || options.signal?.aborted) {
                    return { success: false, error: "Upload cancelled" };
                }
            }

            return lastResult || { success: false, error: "rclone upload was not attempted" };
        } catch (error) {
            return this._buildFailureResult(
                this.sanitizeRcloneOutput(error.message),
                { operation: "copyto", remotePathScoped: true }
            );
        }
    }

    static async _spawnUploadLocalFileToRemoteOnce(localPath, fileName, userId, onProgress, options = {}) {
        return new Promise(async (resolve) => {
            let resolved = false;
            let proc = null;
            let abortHandler = null;
            const removeAbortHandler = () => {
                if (abortHandler && options.signal?.removeEventListener) {
                    options.signal.removeEventListener('abort', abortHandler);
                }
                abortHandler = null;
            };
            const safeResolve = (value) => {
                if (resolved) return;
                resolved = true;
                removeAbortHandler();
                resolve(value);
            };

            try {
                if (options.signal?.aborted) {
                    safeResolve({ success: false, error: "Upload cancelled" });
                    return;
                }
                if (options.signal?.addEventListener) {
                    abortHandler = () => {
                        try { proc?.kill('SIGTERM'); } catch {}
                        safeResolve({ success: false, error: "Upload cancelled" });
                    };
                    options.signal.addEventListener('abort', abortHandler, { once: true });
                }

                const conf = await this._getUserConfig(userId);
                if (resolved || options.signal?.aborted) return;
                const connectionString = this._getConnectionString(conf);
                const userUploadPath = await this._getUploadPath(userId);
                if (resolved || options.signal?.aborted) return;
                const safeFileName = this.sanitizeRemoteFileName(fileName);
                const fullRemotePath = this._joinRemotePath(connectionString, userUploadPath, safeFileName);
                if (resolved || options.signal?.aborted) return;

                const ensureDirectoryResult = await this._ensureUploadDirectory(connectionString, userUploadPath);
                if (!ensureDirectoryResult.success) {
                    safeResolve(ensureDirectoryResult);
                    return;
                }
                if (resolved || options.signal?.aborted) return;

                const args = [
                    "--config", "/dev/null",
                    "copyto", localPath, fullRemotePath,
                    "--progress",
                    "--use-json-log",
                    "--retries", "3",
                    "--low-level-retries", "10",
                    "--stats", "1s",
                    "--buffer-size", "32M"
                ];

                proc = spawn(rcloneBinary, args, { env: buildRcloneEnv() });
                const task = { id: "stream-upload", userId, localPath };
                const errorLogRef = { content: "" };
                let stderrBuffer = "";

                proc.stderr.on("data", (data) => {
                    stderrBuffer += data.toString();
                    const lines = stderrBuffer.split('\n');
                    stderrBuffer = lines.pop();

                    for (const line of lines) {
                        if (!line.trim()) continue;
                        this._processRcloneLog(line, [task], (_taskId, progress) => {
                            if (onProgress) onProgress(progress);
                        }, errorLogRef);
                    }
                });

                proc.on("close", (code) => {
                    if (stderrBuffer.trim()) {
                        this._processRcloneLog(stderrBuffer, [task], (_taskId, progress) => {
                            if (onProgress) onProgress(progress);
                        }, errorLogRef);
                    }

                    const hasErrors = /(^|\b)(ERROR|Failed|failed|error)(\b|:)/.test(errorLogRef.content || "");
                    if (code === 0 && !hasErrors) {
                        safeResolve({ success: true, fileName: safeFileName });
                        return;
                    }

                    const finalError = this.sanitizeRcloneOutput(errorLogRef.content.slice(-500).trim() || `rclone copyto exited with code ${code}`);
                    safeResolve(this._buildFailureResult(finalError, { operation: "copyto", remotePathScoped: true }));
                });

                proc.on("error", (error) => {
                    const finalError = this.sanitizeRcloneOutput(error.message);
                    safeResolve(this._buildFailureResult(finalError, { operation: "copyto", remotePathScoped: true }));
                });
            } catch (error) {
                const finalError = this.sanitizeRcloneOutput(error.message);
                safeResolve(this._buildFailureResult(finalError, { operation: "copyto", remotePathScoped: true }));
            }
        });
    }

    /**
     * Delete one remote file from the user's upload folder.
     * Used by stream forwarding to remove partial rcat outputs after an aborted live stream.
     */
    static async deleteRemoteFile(fileName, userId) {
        if (!userId) return { success: false, error: "Missing userId" };

        const conf = await this._getUserConfig(userId);
        const runtime = await this._openUserRemoteRuntime(userId, conf);
        try {
            const userUploadPath = await this._getUploadPath(userId);
            const safeFileName = this.sanitizeRemoteFileName(fileName);
            const fullRemotePath = this._joinRemotePath(runtime.connectionString, userUploadPath, safeFileName);

            const driveType = conf?.type;
            const isMegaHardDelete = driveType === "mega";
            const runDelete = async (args, timeout = 15000) => new Promise((resolve) => {
                let completed = false;
                try {
                    const proc = spawn(rcloneBinary, [...runtime.configArgs, ...args], { env: buildRcloneEnv() });
                    const timer = setTimeout(() => {
                        if (completed) return;
                        completed = true;
                        try { proc.kill('SIGKILL'); } catch {}
                        resolve({ code: -1, stdout: '', stderr: 'TIMEOUT', error: new Error('Node.js enforced timeout') });
                    }, timeout);
                    let stdout = '';
                    let stderr = '';
                    proc.stdout.on('data', (d) => { stdout += d.toString(); });
                    proc.stderr.on('data', (d) => { stderr += d.toString(); });
                    proc.on('close', (code) => {
                        if (completed) return;
                        completed = true;
                        clearTimeout(timer);
                        resolve({ code, stdout, stderr });
                    });
                    proc.on('error', (err) => {
                        if (completed) return;
                        completed = true;
                        clearTimeout(timer);
                        resolve({ code: -1, stdout, stderr, error: err });
                    });
                } catch (error) {
                    resolve({ code: -1, stdout: '', stderr: error.message, error });
                }
            });

            const deleteArgs = isMegaHardDelete
                ? ["deletefile", "--mega-hard-delete", fullRemotePath]
                : ["deletefile", fullRemotePath];

            const ret = await runDelete(deleteArgs, 15000);
            const notFound = ret.stderr && (
                this._isRemotePathNotFound(ret, { operation: "deletefile" }) ||
                ret.stderr.includes("not found") ||
                ret.stderr.includes("error listing")
            );

            if (ret.code === 0 || notFound) {
                return { success: true };
            }

            if (isMegaHardDelete) {
                log.warn("rclone deletefile with --mega-hard-delete failed, falling back to trash delete", {
                    userId,
                    fileName: safeFileName,
                    exitCode: ret.code
                });
                const fallbackRet = await runDelete(["deletefile", fullRemotePath], 15000);
                const fallbackNotFound = fallbackRet.stderr && (
                    this._isRemotePathNotFound(fallbackRet, { operation: "deletefile" }) ||
                    fallbackRet.stderr.includes("not found") ||
                    fallbackRet.stderr.includes("error listing")
                );
                if (fallbackRet.code === 0 || fallbackNotFound) {
                    return { success: true };
                }
                return this._buildFailureResult(
                    this._buildRcloneError(fallbackRet, `rclone deletefile fallback exited with code ${fallbackRet.code}`),
                    { operation: "deletefile", remotePathScoped: true }
                );
            }

            return this._buildFailureResult(
                this._buildRcloneError(ret, `rclone deletefile exited with code ${ret.code}`),
                { operation: "deletefile", remotePathScoped: true }
            );
        } finally {
            await runtime.dispose();
        }
    }

    static async moveRemoteFile(sourceFileName, targetFileName, userId) {
        if (!userId) return { success: false, error: "Missing userId" };
        if (!sourceFileName) return { success: false, error: "Missing sourceFileName" };
        if (!targetFileName) return { success: false, error: "Missing targetFileName" };

        const conf = await this._getUserConfig(userId);
        const runtime = await this._openUserRemoteRuntime(userId, conf);
        try {
            const userUploadPath = await this._getUploadPath(userId);
            const sourceSafeName = this.sanitizeRemoteFileName(sourceFileName);
            const targetSafeName = this.sanitizeRemoteFileName(targetFileName);
            const sourcePath = this._joinRemotePath(runtime.connectionString, userUploadPath, sourceSafeName);
            const targetPath = this._joinRemotePath(runtime.connectionString, userUploadPath, targetSafeName);

            const ret = await new Promise((resolve) => {
                let completed = false;
                try {
                    const proc = spawn(
                        rcloneBinary,
                        [...runtime.configArgs, 'moveto', sourcePath, targetPath],
                        { env: buildRcloneEnv() }
                    );
                    const timer = setTimeout(() => {
                        if (completed) return;
                        completed = true;
                        try { proc.kill('SIGKILL'); } catch {}
                        resolve({ code: -1, stdout: '', stderr: 'TIMEOUT', error: new Error('Node.js enforced timeout') });
                    }, 10 * 60 * 1000);
                    let stdout = '';
                    let stderr = '';
                    proc.stdout.on('data', (d) => { stdout += d.toString(); });
                    proc.stderr.on('data', (d) => { stderr += d.toString(); });
                    proc.on('close', (code) => {
                        if (completed) return;
                        completed = true;
                        clearTimeout(timer);
                        resolve({ code, stdout, stderr });
                    });
                    proc.on('error', (err) => {
                        if (completed) return;
                        completed = true;
                        clearTimeout(timer);
                        resolve({ code: -1, stdout, stderr, error: err });
                    });
                } catch (error) {
                    resolve({ code: -1, stdout: '', stderr: error.message, error });
                }
            });

            if (ret.code === 0) {
                return { success: true, fileName: targetSafeName };
            }

            return this._buildFailureResult(
                this._buildRcloneError(ret, `rclone moveto exited with code ${ret.code}`),
                { operation: "moveto", remotePathScoped: true }
            );
        } finally {
            await runtime.dispose();
        }
    }

    /**
     * 获取文件列表 (带智能缓存策略)
     */
    static async listRemoteFiles(userId, forceRefresh = false) {
        const cacheKey = `files_${userId}`;

        if (!forceRefresh) {
            // 1. 尝试内存缓存
            const memCached = localCache.get(cacheKey);
            if (memCached) return memCached.files || memCached;

            // 2. 尝试 Cache 缓存 (持久化)
            try {
                const cacheCached = await cache.get(cacheKey, "json");
                if (cacheCached) {
                    // 根据文件新鲜度动态调整内存缓存时间
                    const cacheAge = this._calculateOptimalCacheTime(cacheCached.files || cacheCached);
                    localCache.set(cacheKey, cacheCached, cacheAge);
                    // 返回文件数组（兼容旧格式和新格式）
                    return cacheCached.files || cacheCached;
                }
            } catch (e) {
                log.error("Cache get files error:", e.message);
            }
        }

        this.loading = true;
        try {
            const conf = await this._getUserConfig(userId);
            const connectionString = this._getConnectionString(conf);

            // 获取用户自定义上传路径
            const userUploadPath = await this._getUploadPath(userId);
            const fullRemotePath = this._joinRemotePath(connectionString, userUploadPath);

            let ret = await this._runRclone(["lsjson", fullRemotePath]);

            if (ret.code !== 0 && this._isRemotePathNotFound(ret, { operation: "listRemoteFiles" })) {
                await this._resolvePathScopedNotFound(ret, connectionString);
                log.info(`Directory ${userUploadPath} not found, attempting to create it...`);
                // 尝试创建一个空目录/触发目录初始化 (异步化)
                await this._runRclone(["mkdir", fullRemotePath], 10000);
                // 再次尝试
                ret = await this._runRclone(["lsjson", fullRemotePath]);
            }

            if (ret.code !== 0) {
                if (this._isRemotePathNotFound(ret, { operation: "listRemoteFiles" })) {
                    await this._resolvePathScopedNotFound(ret, connectionString);
                    log.warn("Rclone directory still not found after attempt, returning empty list.");
                    this.loading = false;
                    return [];
                }
                throw this._buildFailureError(this._buildFailureResult(
                    `Rclone lsjson failed: ${this.sanitizeRcloneOutput(ret.stderr)}`,
                    { operation: "listRemoteFiles", remotePathScoped: true }
                ));
            }

            let files = JSON.parse(ret.stdout || "[]");
            if (!Array.isArray(files)) files = [];

            files.sort((a, b) => {
                if (a.IsDir !== b.IsDir) return b.IsDir ? 1 : -1;
                return new Date(b.ModTime) - new Date(a.ModTime);
            });

            // 智能缓存处理
            const cacheData = {
                files,
                timestamp: Date.now(),
                userId
            };

            // 根据文件变化频率动态设置缓存时间
            const optimalMemoryTTL = this._calculateOptimalCacheTime(files);
            const optimalKVTTL = Math.max(600, optimalMemoryTTL / 1000); // KV至少缓存10分钟

            localCache.set(cacheKey, cacheData, optimalMemoryTTL);
            try {
                // Cache 缓存使用动态时间，应对重启
                await cache.set(cacheKey, cacheData, optimalKVTTL);
            } catch (e) {
                log.error("Cache set files error:", e.message);
            }

            this.loading = false;
            return files;

        } catch (e) {
            log.error("List files error (Detail):", e);
            this.loading = false;
            return [];
        }
    }

    /**
     * 计算最优缓存时间 (基于文件变化频率)
     * @param {Array} files - 文件列表
     * @returns {number} 缓存时间(毫秒)
     */
    static _calculateOptimalCacheTime(files) {
        if (!files || files.length === 0) {
            return 5 * 60 * 1000; // 空目录：5分钟
        }

        // 计算文件的平均修改时间间隔
        const now = Date.now();
        const recentFiles = files
            .filter(f => !f.IsDir)
            .map(f => new Date(f.ModTime).getTime())
            .filter(time => (now - time) < 7 * 24 * 60 * 60 * 1000) // 只考虑最近7天的文件
            .sort((a, b) => b - a); // 降序排序

        if (recentFiles.length < 2) {
            return 15 * 60 * 1000; // 文件较少：15分钟
        }

        // 计算平均修改间隔
        let totalInterval = 0;
        for (let i = 1; i < recentFiles.length; i++) {
            totalInterval += recentFiles[i - 1] - recentFiles[i];
        }
        const avgInterval = totalInterval / (recentFiles.length - 1);

        // 根据平均间隔动态调整缓存时间
        if (avgInterval < 60 * 1000) { // 高频变化（<1分钟）
            return 2 * 60 * 1000; // 2分钟
        } else if (avgInterval < 60 * 60 * 1000) { // 中等频率（<1小时）
            return 5 * 60 * 1000; // 5分钟
        } else if (avgInterval < 24 * 60 * 60 * 1000) { // 低频变化（<1天）
            return 30 * 60 * 1000; // 30分钟
        } else { // 极低频变化
            return 60 * 60 * 1000; // 1小时
        }
    }

    static isLoading() {
        return this.loading;
    }

    /**
     * 简单的文件完整性检查 (带重试机制以应对 API 延迟) - 异步非阻塞版
     * @param {string} fileName - 文件名
     * @param {string} userId - 用户ID
     * @param {number} retries - 重试次数
     * @param {boolean} skipFallback - 是否跳过目录列表回退 (用于快速检查)
     */
    static async getRemoteFileInfo(fileName, userId, retries = 3, skipFallback = false) {
        if (!userId) return null;

        for (let i = 0; i < retries; i++) {
            try {
                const conf = await this._getUserConfig(userId);
                const connectionString = this._getConnectionString(conf);

                // 获取用户自定义上传路径
                const userUploadPath = await this._getUploadPath(userId);

                // 优先尝试直接查询文件（更高效）
                const fullRemotePath = this._joinRemotePath(connectionString, userUploadPath, fileName);
                let ret = await this._runRclone(["lsjson", fullRemotePath], 10000);

                // 如果明确返回“不存在”类错误，先确认远端根仍可访问。
                // MEGA 会把凭据/根节点异常和路径节点异常都写成 Object not found；
                // 根可用才表示目标文件/目录不存在，否则应暴露真实绑定问题。
                if (ret.code !== 0 && ret.stderr) {
                    if (this._isRemotePathNotFound(ret, { operation: "lsjson" })) {
                        await this._resolvePathScopedNotFound(ret, connectionString);
                        log.debug(`[getRemoteFileInfo] File clearly not found: ${fileName}`);
                        return null;
                    }
                }

                // 如果直接查询失败（且不是明确的不存在），尝试列出目录（除非禁用了回退）
                if (ret.code !== 0 && !skipFallback) {
                    // 仅当非超时错误时尝试 fallback
                    if (ret.stderr !== "TIMEOUT") {
                        const fullRemoteFolder = this._joinRemotePath(connectionString, userUploadPath);
                        ret = await this._runRclone(["lsjson", "--files-only", "--max-depth", "1", fullRemoteFolder], 15000);

                        if (ret.code === 0) {
                            try {
                                const files = JSON.parse(ret.stdout || "[]");
                                if (Array.isArray(files)) {
                                    const file = files.find(f => f.Name === fileName);
                                    if (file) return file;
                                }
                            } catch (error) {
                                log.warn('Failed to parse directory listing JSON', {
                                    fileName,
                                    userId,
                                    error: error.message
                                });
                            }
                        }
                    }
                } else if (ret.code === 0) {
                    // 直接查询成功，解析结果
                    try {
                        const files = JSON.parse(ret.stdout || "[]");
                        if (Array.isArray(files) && files.length > 0) {
                            return files[0]; // 直接查询文件时只返回一个文件
                        }
                    } catch (error) {
                        log.warn('Failed to parse direct file query JSON', {
                            fileName,
                            userId,
                            error: error.message
                        });
                    }
                }

                // 如果都没有找到或出错，记录日志（排除找不到文件的情况，减少日志噪音）
                if (ret.code !== 0 && !this._isRemotePathNotFound(ret, { operation: "lsjson" })) {
                    // console.warn(`[getRemoteFileInfo] Status ${ret.code} for ${fileName}: ${ret.stderr}`);
                }
            } catch (e) {
                if (NON_RETRYABLE_RCLONE_ERROR_CODES.has(e?.errorCode)) {
                    throw e;
                }
                log.warn(`[getRemoteFileInfo] Attempt ${i + 1} failed for ${fileName}:`, e.message);
            }

            if (i < retries - 1) {
                // 等待一段时间后重试
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
            }
        }
        return null;
    }
    
    /**
     * Generic execute method for rclone commands
     * @param {Array} commandArgs - Command arguments (e.g., ['copy', 'source', 'destination'])
     * @param {string} taskId - Optional task ID for tracking
     * @param {Object} options - Options object
     * @param {Function} options.onProgress - Progress callback function
     * @param {AbortSignal} options.signal - AbortSignal for cancellation
     * @returns {Promise} - Promise that resolves when command completes
     */
    static async execute(commandArgs, taskId = null, options = {}) {
        if (!commandArgs || !Array.isArray(commandArgs) || commandArgs.length === 0) {
            throw new Error('Command arguments are required');
        }

        return new Promise((resolve, reject) => {
            try {
                const args = ["--config", "/dev/null", ...commandArgs];
                const proc = spawn(rcloneBinary, args, { env: buildRcloneEnv() });

                let cancelled = false;
                let errorLog = "";

                // Handle cancellation if signal is provided
                if (options.signal) {
                    if (options.signal.aborted) {
                        cancelled = true;
                        proc.kill('SIGTERM');
                        reject(new Error('Command cancelled before execution'));
                        return;
                    }

                    options.signal.addEventListener('abort', () => {
                        if (!cancelled) {
                            cancelled = true;
                            proc.kill('SIGTERM');
                            reject(new Error('Command cancelled'));
                        }
                    });
                }

                // Handle progress output if callback is provided
                if (options.onProgress) {
                    proc.stderr.on("data", (data) => {
                        if (cancelled) return;
                        
                        try {
                            const lines = data.toString().split('\n');
                            for (const line of lines) {
                                if (!line.trim()) continue;
                                try {
                                    const log = JSON.parse(line);
                                    // Parse progress information from rclone JSON log
                                    // Handle both "total_size"/"bytes" and "stats.totalBytes"/"stats.bytes" formats
                                    let totalBytes = log.total_size || (log.stats && log.stats.totalBytes);
                                    let transferredBytes = log.bytes || (log.stats && log.stats.bytes);
                                    
                                    if (totalBytes && transferredBytes) {
                                        options.onProgress({
                                            progress: Math.round((transferredBytes / totalBytes) * 100),
                                            totalBytes,
                                            transferredBytes
                                        });
                                    }
                                } catch (e) {
                                    // Collect non-JSON lines as error log
                                    errorLog += line + "\n";
                                }
                            }
                        } catch (e) {
                            errorLog += data.toString();
                        }
                    });
                } else {
                    proc.stderr.on("data", (data) => {
                        if (cancelled) return;
                        errorLog += data.toString();
                    });
                }

                proc.on("close", (code) => {
                    if (cancelled) return;
                    
                    if (code === 0) {
                        resolve({ success: true, exitCode: code });
                    } else {
                        const errorMessage = CloudTool.sanitizeRcloneOutput(errorLog.trim() || `Command exited with code ${code}`);
                        reject(new Error(errorMessage));
                    }
                });

                proc.on("error", (err) => {
                    if (cancelled) return;
                    reject(new Error(`Process error: ${CloudTool.sanitizeRcloneOutput(err.message)}`));
                });

            } catch (e) {
                reject(new Error(`Failed to execute command: ${CloudTool.sanitizeRcloneOutput(e.message)}`));
            }
        });
    }

    static async killTask(taskId) {
        // Implementation in TaskManager
    }
}

// Export CloudTool as rclone for backward compatibility with tests
export const rclone = CloudTool;
