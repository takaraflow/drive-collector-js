import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { config } from "../config/index.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { SettingsRepository } from "../repositories/SettingsRepository.js";
import { STRINGS } from "../locales/zh-CN.js";
import { localCache } from "../utils/LocalCache.js";
import { cache } from "./CacheService.js";
import { logger } from "./logger/index.js";
import { DriveProviderFactory } from "./drives/index.js";
const log = logger.withModule ? logger.withModule('RcloneService') : logger;

const buildRcloneEnv = () => ({
    ...process.env,
    LC_ALL: "C",
    LANG: "C"
});

// 确定 rclone 二进制路径 (兼容 Zeabur 和 本地)
const rcloneBinary = fs.existsSync("/app/rclone/rclone") 
    ? "/app/rclone/rclone" 
    : "rclone";

export class CloudTool {
    static loading = false;

    static async _getUserConfig(userId) {
        if (!userId) throw new Error(STRINGS.drive.user_id_required);

        // 1. 使用 Repo
        const drives = await DriveRepository.findByUserId(userId);
        
        if (!drives || drives.length === 0) {
            throw new Error(STRINGS.drive.no_drive_found);
        }

        // 2. 查找默认网盘，如果没有则使用第一个
        const defaultDriveId = await SettingsRepository.get(`default_drive_${userId}`, null);
        const activeDrive = drives.find(d => d.id === defaultDriveId) || drives[0];
        
        const driveConfig = JSON.parse(activeDrive.config_data);
        
        // 3. 使用 Provider 处理密码混淆
        const provider = DriveProviderFactory.getProvider(activeDrive.type);
        
        // Clone config and inject type
        const config = { ...driveConfig, type: activeDrive.type };
        
        // Allow provider to process password if present
        if (config.pass) {
            config.pass = provider.processPassword(config.pass);
        }
        
        // 4. 返回清洗后的配置对象
        return config;
    }

    /**
     * 【重要修复】调用 rclone obscure 对密码进行混淆
     * 使用 spawnSync 避免 Shell 特殊字符转义问题
     */
    static _obscure(password) {
        try {
            // 使用参数数组传递密码，杜绝 Shell 注入 and 转义干扰
            const ret = spawnSync(rcloneBinary, ["--config", "/dev/null", "obscure", password], { encoding: 'utf-8', env: buildRcloneEnv() });
            
            if (ret.error) {
                log.error("Obscure spawn error:", ret.error);
                return password;
            }
            if (ret.status !== 0) {
                log.error("Obscure non-zero exit:", ret.stderr);
                return password;
            }
            
            return ret.stdout.trim();
        } catch (e) {
            log.error("Password obscure failed:", e);
            return password; // 失败则返回原值尝试
        }
    }

    /**
     * 辅助方法：构造安全的连接字符串
     */
    static _getConnectionString(conf) {
        try {
            const provider = DriveProviderFactory.getProvider(conf.type);
            return provider.getConnectionString(conf);
        } catch (e) {
            // Fallback for unknown types or errors (though this shouldn't happen with valid types)
            log.error(`Failed to get connection string for type ${conf.type}:`, e);
            const user = (conf.user || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const pass = (conf.pass || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            return `:${conf.type},user="${user}",pass="${pass}":`;
        }
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
            return this._normalizePath(config.remoteFolder);
        } catch (error) {
            log.error(`Failed to get upload path for user ${userId}:`, error);
            // 出错时使用默认路径
            return this._normalizePath(config.remoteFolder);
        }
    }

    /**
     * 从D1数据库获取用户上传路径
     * @param {string} userId - 用户ID
     * @returns {Promise<string|null>} 用户自定义路径或null
     */
    static async _getUserUploadPathFromD1(userId) {
        try {
            const drives = await DriveRepository.findByUserId(userId);
            const defaultDriveId = await SettingsRepository.get(`default_drive_${userId}`, null);
            const activeDrive = drives.length > 0 ? (drives.find(d => d.id === defaultDriveId) || drives[0]) : null;
            
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
    static _validatePath(path) {
        if (!path || typeof path !== 'string') return false;
        
        // 移除开头和结尾的空白
        path = path.trim();
        
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
        
        return true;
    }

    /**
     * 【重构】验证配置是否有效 (异步非阻塞版)
     */
    static async validateConfig(type, configData, checkCommand = "about") {
        return new Promise((resolve) => {
            try {
                // Construct the full config object for _getConnectionString
                // Assuming configData contains the necessary fields (user/pass or token)
                // Password processing should be done by the caller (Provider) before calling this.
                const conf = { ...configData, type };

                const connectionString = this._getConnectionString(conf);

                // 通过 Provider 获取最合适的验证命令
                const provider = DriveProviderFactory.getProvider(type);
                const finalCheckCommand = (checkCommand === "about")
                    ? provider.getValidationCommand()
                    : checkCommand;

                const args = ["--config", "/dev/null", finalCheckCommand, connectionString, "--max-depth", "1", "--timeout", "15s"];

                
                const proc = spawn(rcloneBinary, args, { env: buildRcloneEnv() });

                let errorLog = "";
                proc.stderr.on("data", (data) => {
                    errorLog += data.toString();
                });

                proc.on("close", (code) => {
                    if (code === 0) {
                        resolve({ success: true });
                    } else {
                        if (errorLog.includes("Multi-factor authentication") || errorLog.includes("2FA")) {
                            resolve({ success: false, reason: "2FA" });
                        } else {
                            log.error("Validation failed. Cmd:", `rclone about :${type},user=***,pass=***:`);
                            log.error("Error Log:", errorLog);
                            resolve({ success: false, reason: "ERROR", details: errorLog });
                        }
                    }
                });

                proc.on("error", (err) => {
                    resolve({ success: false, reason: "ERROR", details: err.message });
                });

            } catch (e) {
                resolve({ success: false, reason: "ERROR", details: e.message });
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
        
        return new Promise(async (resolve) => {
            let isResolved = false;
            const safeResolve = (value) => {
                if (isResolved) return;
                isResolved = true;
                resolve(value);
            };
            
            try {

                // 假设所有任务属于同一用户且目标一致（由调用者确保）
                const firstTask = tasks[0];
                const conf = await this._getUserConfig(firstTask.userId);
                const connectionString = this._getConnectionString(conf);
                
                // 获取用户自定义上传路径
                const userUploadPath = await this._getUploadPath(firstTask.userId);
                const remotePath = `${connectionString}${userUploadPath}`;

                // 准备 --files-from 数据 (使用 stdin 传递以支持大量文件且避免路径转义问题)
                // 注意：rclone copy 的 source 应该是这些文件共同的父目录
                // 使用 path.resolve 确保获取绝对路径，避免由于相对路径处理不当导致的上传失败
                // 【修复 3】过滤无效路径，防止解析到根目录
                const commonSourceDir = path.resolve(config.downloadDir || "/tmp/downloads");
                const fileList = tasks
                    .filter(t => t.localPath) // 确保路径存在
                    .map(t => path.relative(commonSourceDir, path.resolve(t.localPath)))
                    .join('\n');

                const args = [
                    "--config", "/dev/null",
                    "copy", commonSourceDir, remotePath,
                    "--files-from-raw", "-",         // 从 stdin 读取文件列表
                    "--progress",
                    "--use-json-log",               // 使用 JSON 日志以便精确解析进度
                    "--transfers", "4",             // 限制同时上传的文件数
                    "--checkers", "8",
                    "--retries", "3",               // 增加重试
                    "--low-level-retries", "10",
                    "--stats", "1s",
                    "--buffer-size", "32M"          // 增加缓冲区提升速度
                ];

                const proc = spawn(rcloneBinary, args, { env: buildRcloneEnv() });

                // 将进程关联到所有相关任务，以便统一取消
                tasks.forEach(t => t.proc = proc);

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
                let errorLog = "";

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
                        try {
                            const log = JSON.parse(line);
                            // 解析 rclone JSON 日志中的进度信息
                            if (log.msg === "Status update" || (log.stats && log.msg.includes("progress"))) {
                                const stats = log.stats || {};
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
                            errorLog += line + "\n";
                        }
                    }
                });

                proc.on("close", (code) => {
                    if (cancelled || isAnyTaskCancelled()) {
                        return safeResolve({ success: false, error: "CANCELLED" });
                    }
                    if (code === 0) {
                        // Even with exit code 0, check for errors in the log
                        const hasErrors = errorLog.includes('ERROR') || errorLog.includes('Failed') || errorLog.includes('failed');
                        if (hasErrors) {
                            log.error(`Rclone Batch completed with exit code 0 but contains errors:`, errorLog.slice(-500));
                            safeResolve({ success: false, error: `Upload completed but with errors: ${errorLog.slice(-200).trim()}` });
                        } else {
                            safeResolve({ success: true });
                        }
                    } else {
                        const finalError = errorLog.slice(-500) || `Rclone exited with code ${code}`;
                        log.error(`Rclone Batch Error:`, finalError);
                        safeResolve({ success: false, error: finalError.trim() });
                    }
                });

                proc.on("error", (err) => {
                    safeResolve({ success: false, error: err.message });
                });

                // 写入文件列表到 stdin 并关闭
                proc.stdin.write(fileList);
                proc.stdin.end();

            } catch (e) {
                safeResolve({ success: false, error: e.message });
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
    static async createRcatStream(fileName, userId) {
        const conf = await this._getUserConfig(userId);
        const connectionString = this._getConnectionString(conf);
        const userUploadPath = await this._getUploadPath(userId);
        const fullRemotePath = `${connectionString}${userUploadPath}${fileName}`;

        const args = [
            "--config", "/dev/null",
            "rcat", fullRemotePath,
            "--progress",
            "--use-json-log",
            "--buffer-size", "32M"
        ];

        const proc = spawn(rcloneBinary, args, { env: buildRcloneEnv() });

        return {
            stdin: proc.stdin,
            proc: proc
        };
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
            
            // 尝试获取文件列表，如果目录不存在则尝试创建 (异步化)
            const runLsJson = (path) => {
                return new Promise((resolve, reject) => {
                    const proc = spawn(rcloneBinary, ["--config", "/dev/null", "lsjson", path], {
                        env: buildRcloneEnv()
                    });
                    
                    let stdout = "";
                    let stderr = "";

                    proc.stdout.on("data", (data) => stdout += data);
                    proc.stderr.on("data", (data) => stderr += data);

                    proc.on("close", (code) => {
                        resolve({ code, stdout, stderr });
                    });

                    proc.on("error", (err) => reject(err));
                });
            };

            const fullRemotePath = `${connectionString}${userUploadPath}`;
            let ret = await runLsJson(fullRemotePath);

            if (ret.code !== 0 && ret.stderr && (ret.stderr.includes("directory not found") || ret.stderr.includes("error listing"))) {
                log.info(`Directory ${userUploadPath} not found, attempting to create it...`);
                // 尝试创建一个空目录/触发目录初始化
                spawnSync(rcloneBinary, ["--config", "/dev/null", "mkdir", fullRemotePath], { env: buildRcloneEnv() });
                // 再次尝试
                ret = await runLsJson(fullRemotePath);
            }

            if (ret.code !== 0) {
                if (ret.stderr && (ret.stderr.includes("directory not found") || ret.stderr.includes("error listing"))) {
                    log.warn("Rclone directory still not found after attempt, returning empty list.");
                    this.loading = false;
                    return [];
                }
                throw new Error(`Rclone lsjson failed: ${ret.stderr}`);
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

                const runLsJson = (path, args = [], timeout = 10000) => {
                    return new Promise((resolve, reject) => {
                        const proc = spawn(rcloneBinary, ["--config", "/dev/null", "lsjson", ...args, path], {
                            env: buildRcloneEnv()
                        });
                        
                        let stdout = "";
                        let stderr = "";
                        let completed = false;

                        // 设置超时保护
                        const timer = setTimeout(() => {
                            if (!completed) {
                                completed = true;
                                if (typeof proc.kill === 'function') {
                                    proc.kill();
                                }
                                resolve({ code: -1, stdout: "", stderr: "TIMEOUT" });
                            }
                        }, timeout);

                        proc.stdout.on("data", (data) => stdout += data);
                        proc.stderr.on("data", (data) => stderr += data);

                        proc.on("close", (code) => {
                            if (!completed) {
                                completed = true;
                                clearTimeout(timer);
                                resolve({ code, stdout, stderr });
                            }
                        });

                        proc.on("error", (err) => {
                            if (!completed) {
                                completed = true;
                                clearTimeout(timer);
                                reject(err);
                            }
                        });
                    });
                };

                // 优先尝试直接查询文件（更高效）
                const fullRemotePath = `${connectionString}${userUploadPath}${fileName}`;
                let ret = await runLsJson(fullRemotePath, [], 10000);

                // 如果明确返回“不存在”类错误，直接退出，不重试，不回退
                if (ret.code !== 0 && ret.stderr) {
                    const isNotFound = 
                        ret.stderr.includes("directory not found") || 
                        ret.stderr.includes("object not found") || 
                        ret.stderr.includes("error listing");
                    
                    if (isNotFound) {
                        log.debug(`[getRemoteFileInfo] File clearly not found: ${fileName}`);
                        return null; 
                    }
                }

                // 如果直接查询失败（且不是明确的不存在），尝试列出目录（除非禁用了回退）
                if (ret.code !== 0 && !skipFallback) {
                    // 仅当非超时错误时尝试 fallback
                    if (ret.stderr !== "TIMEOUT") {
                        const fullRemoteFolder = `${connectionString}${userUploadPath}`;
                        ret = await runLsJson(fullRemoteFolder, ["--files-only", "--max-depth", "1"], 15000);

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
                if (ret.code !== 0 && !ret.stderr.includes("directory not found") && !ret.stderr.includes("error listing")) {
                    // console.warn(`[getRemoteFileInfo] Status ${ret.code} for ${fileName}: ${ret.stderr}`);
                }
            } catch (e) {
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
                        const errorMessage = errorLog.trim() || `Command exited with code ${code}`;
                        reject(new Error(errorMessage));
                    }
                });

                proc.on("error", (err) => {
                    if (cancelled) return;
                    reject(new Error(`Process error: ${err.message}`));
                });

            } catch (e) {
                reject(new Error(`Failed to execute command: ${e.message}`));
            }
        });
    }

    static async killTask(taskId) {
        // Implementation in TaskManager
    }
}

// Export CloudTool as rclone for backward compatibility with tests
export const rclone = CloudTool;