import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { config } from "../config/index.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { STRINGS } from "../locales/zh-CN.js";
import { cacheService } from "../utils/CacheService.js";
import { kv } from "./kv.js";

// 确定 rclone 二进制路径 (兼容 Zeabur 和 本地)
const rcloneBinary = fs.existsSync("/app/rclone/rclone") 
    ? "/app/rclone/rclone" 
    : "rclone";

export class CloudTool {
    static loading = false;

    static async _getUserConfig(userId) {
        if (!userId) throw new Error(STRINGS.drive.user_id_required);

        // 1. 使用 Repo
        const drive = await DriveRepository.findByUserId(userId);
        
        if (!drive) {
            throw new Error(STRINGS.drive.no_drive_found);
        }
        
        const driveConfig = JSON.parse(drive.config_data);
        // 2. 密码混淆处理
        let finalPass = driveConfig.pass;
        if (drive.type === 'mega') {
             finalPass = this._obscure(finalPass);
        }
        // 3. 返回清洗后的配置对象
        return {
            type: drive.type,
            user: driveConfig.user,
            pass: finalPass
        };
    }

    /**
     * 【重要修复】调用 rclone obscure 对密码进行混淆
     * 使用 spawnSync 避免 Shell 特殊字符转义问题
     */
    static _obscure(password) {
        try {
            // 使用参数数组传递密码，杜绝 Shell 注入 and 转义干扰
            const ret = spawnSync(rcloneBinary, ["--config", "/dev/null", "obscure", password], { encoding: 'utf-8' });
            
            if (ret.error) {
                console.error("Obscure spawn error:", ret.error);
                return password;
            }
            if (ret.status !== 0) {
                console.error("Obscure non-zero exit:", ret.stderr);
                return password;
            }
            
            return ret.stdout.trim();
        } catch (e) {
            console.error("Password obscure failed:", e);
            return password; // 失败则返回原值尝试
        }
    }

    /**
     * 辅助方法：构造安全的连接字符串
     */
    static _getConnectionString(conf) {
        const user = (conf.user || "").replace(/"/g, '\\"');
        const pass = (conf.pass || "").replace(/"/g, '\\"');
        return `:${conf.type},user="${user}",pass="${pass}":`;
    }

    /**
     * 【重构】验证配置是否有效 (异步非阻塞版)
     */
    static async validateConfig(type, configData) {
        return new Promise((resolve) => {
            try {
                let finalPass = configData.pass;
                if (type === 'mega') {
                     finalPass = CloudTool._obscure(finalPass);
                }

                const connectionString = this._getConnectionString({ type, user: configData.user, pass: finalPass });
                const args = ["--config", "/dev/null", "about", connectionString, "--json", "--timeout", "15s"];
                
                const proc = spawn(rcloneBinary, args, { env: process.env });

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
                            console.error("Validation failed. Cmd:", `rclone about :${type},user=***,pass=***:`);
                            console.error("Error Log:", errorLog);
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
            try {
                // 假设所有任务属于同一用户且目标一致（由调用者确保）
                const firstTask = tasks[0];
                const conf = await this._getUserConfig(firstTask.userId);
                const connectionString = this._getConnectionString(conf);
                const remotePath = `${connectionString}${config.remoteFolder}/`;

                // 准备 --files-from 数据 (使用 stdin 传递以支持大量文件且避免路径转义问题)
                // 注意：rclone copy 的 source 应该是这些文件共同的父目录
                // 使用 path.resolve 确保获取绝对路径，避免由于相对路径处理不当导致的上传失败
                const commonSourceDir = path.resolve(config.downloadDir || "/tmp/downloads");
                const fileList = tasks.map(t => path.relative(commonSourceDir, path.resolve(t.localPath || ""))).join('\n');

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

                const proc = spawn(rcloneBinary, args, { env: process.env });
                
                // 将进程关联到所有相关任务，以便统一取消
                tasks.forEach(t => t.proc = proc);

                let errorLog = "";

                proc.stderr.on("data", (data) => {
                    const lines = data.toString().split('\n');
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
                                        const task = tasks.find(t => t.localPath.endsWith(transfer.name));
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
                            // 非 JSON 日志（如普通错误输出）
                            errorLog += line + "\n";
                        }
                    }
                });

                proc.on("close", (code) => {
                    if (code === 0) {
                        // Even with exit code 0, check for errors in the log
                        const hasErrors = errorLog.includes('ERROR') || errorLog.includes('Failed') || errorLog.includes('failed');
                        if (hasErrors) {
                            console.error(`Rclone Batch completed with exit code 0 but contains errors:`, errorLog.slice(-500));
                            resolve({ success: false, error: `Upload completed but with errors: ${errorLog.slice(-200).trim()}` });
                        } else {
                            resolve({ success: true });
                        }
                    } else {
                        const finalError = errorLog.slice(-500) || `Rclone exited with code ${code}`;
                        console.error(`Rclone Batch Error:`, finalError);
                        resolve({ success: false, error: finalError.trim() });
                    }
                });

                proc.on("error", (err) => {
                    resolve({ success: false, error: err.message });
                });

                // 写入文件列表到 stdin 并关闭
                proc.stdin.write(fileList);
                proc.stdin.end();

            } catch (e) {
                resolve({ success: false, error: e.message });
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
     * 获取文件列表 (带智能缓存策略)
     */
    static async listRemoteFiles(userId, forceRefresh = false) {
        const cacheKey = `files_${userId}`;

        if (!forceRefresh) {
            // 1. 尝试内存缓存
            const memCached = cacheService.get(cacheKey);
            if (memCached) return memCached.files || memCached;

            // 2. 尝试 KV 缓存 (持久化)
            try {
                const kvCached = await kv.get(cacheKey, "json");
                if (kvCached) {
                    // 根据文件新鲜度动态调整内存缓存时间
                    const cacheAge = this._calculateOptimalCacheTime(kvCached.files || kvCached);
                    cacheService.set(cacheKey, kvCached, cacheAge);
                    // 返回文件数组（兼容旧格式和新格式）
                    return kvCached.files || kvCached;
                }
            } catch (e) {
                console.error("KV get files error:", e.message);
            }
        }

        this.loading = true;
        try {
            const conf = await this._getUserConfig(userId);
            const connectionString = this._getConnectionString(conf);
            
            // 尝试获取文件列表，如果目录不存在则尝试创建
            const fetchFiles = (path) => {
                return spawnSync(rcloneBinary, ["--config", "/dev/null", "lsjson", path], {
                    env: process.env,
                    encoding: 'utf-8',
                    maxBuffer: 10 * 1024 * 1024
                });
            };

            const fullRemotePath = `${connectionString}${config.remoteFolder}/`;
            let ret = fetchFiles(fullRemotePath);

            if (ret.status !== 0 && ret.stderr && (ret.stderr.includes("directory not found") || ret.stderr.includes("error listing"))) {
                console.log(`Directory ${config.remoteFolder} not found, attempting to create it...`);
                // 尝试创建一个空目录/触发目录初始化
                spawnSync(rcloneBinary, ["--config", "/dev/null", "mkdir", fullRemotePath], { env: process.env });
                // 再次尝试
                ret = fetchFiles(fullRemotePath);
            }

            if (ret.error) throw ret.error;
            if (ret.status !== 0) {
                if (ret.stderr && (ret.stderr.includes("directory not found") || ret.stderr.includes("error listing"))) {
                    console.warn("Rclone directory still not found after attempt, returning empty list.");
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

            cacheService.set(cacheKey, cacheData, optimalMemoryTTL);
            try {
                // KV 缓存使用动态时间，应对重启
                await kv.set(cacheKey, cacheData, optimalKVTTL);
            } catch (e) {
                console.error("KV set files error:", e.message);
            }

            this.loading = false;
            return files;

        } catch (e) {
            console.error("List files error (Detail):", e.message);
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
     * 简单的文件完整性检查 (带重试机制以应对 API 延迟)
     */
    static async getRemoteFileInfo(fileName, userId, retries = 3) {
        if (!userId) return null;

        for (let i = 0; i < retries; i++) {
            try {
                const conf = await this._getUserConfig(userId);
                const connectionString = this._getConnectionString(conf);

                // 优先尝试直接查询文件（更高效）
                const fullRemotePath = `${connectionString}${config.remoteFolder}/${fileName}`;
                let ret = spawnSync(rcloneBinary, ["--config", "/dev/null", "lsjson", fullRemotePath], {
                    env: process.env,
                    encoding: 'utf-8',
                    timeout: 10000 // 10秒超时
                });

                // 如果直接查询失败，尝试列出目录
                if (ret.status !== 0) {
                    console.warn(`[getRemoteFileInfo] Direct lsjson failed for ${fileName}, trying directory listing`);
                    const fullRemoteFolder = `${connectionString}${config.remoteFolder}/`;
                    ret = spawnSync(rcloneBinary, ["--config", "/dev/null", "lsjson", "--files-only", "--max-depth", "1", fullRemoteFolder], {
                        env: process.env,
                        encoding: 'utf-8',
                        timeout: 15000 // 15秒超时
                    });

                    if (ret.status === 0) {
                        const files = JSON.parse(ret.stdout || "[]");
                        if (Array.isArray(files)) {
                            const file = files.find(f => f.Name === fileName);
                            if (file) return file;
                        }
                    }
                } else {
                    // 直接查询成功，解析结果
                    const files = JSON.parse(ret.stdout || "[]");
                    if (Array.isArray(files) && files.length > 0) {
                        return files[0]; // 直接查询文件时只返回一个文件
                    }
                }

                if (ret.status !== 0) {
                    console.warn(`[getRemoteFileInfo] lsjson returned status ${ret.status} for ${fileName}: ${ret.stderr}`);
                }
            } catch (e) {
                console.warn(`[getRemoteFileInfo] Attempt ${i + 1} failed for ${fileName}:`, e.message);
            }

            if (i < retries - 1) {
                // 等待一段时间后重试
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
            }
        }
        return null;
    }
    
    static async killTask(taskId) {
        // Implementation in TaskManager
    }
}