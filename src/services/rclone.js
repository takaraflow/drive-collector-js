import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { config } from "../config/index.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { STRINGS } from "../locales/zh-CN.js";
import { cacheService } from "../utils/CacheService.js";

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
        const user = conf.user.replace(/"/g, '\\"');
        const pass = conf.pass.replace(/"/g, '\\"');
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
     * 上传文件
     */
    static async uploadFile(localPath, task, onProgress) {
        return new Promise(async (resolve) => {
            try {
                const conf = await this._getUserConfig(task.userId);
                const connectionString = this._getConnectionString(conf);
                const remotePath = `${connectionString}${config.remoteFolder}/`; 

                const args = ["--config", "/dev/null", "copy", localPath, remotePath, "--progress", "--transfers", "4", "--stats", "1s"];
                const proc = spawn(rcloneBinary, args, { env: process.env });
                task.proc = proc;

                let lastLogTime = 0;
                let errorLog = "";

                proc.stderr.on("data", (data) => {
                    const log = data.toString();
                    if (!log.includes("Transferred:") && !log.includes("ETA")) {
                        errorLog += log;
                    }
                    if (onProgress && Date.now() - lastLogTime > 2000) {
                        lastLogTime = Date.now();
                        onProgress();
                    }
                });

                proc.on("close", (code) => {
                    if (code === 0) {
                        resolve({ success: true });
                    } else {
                        const finalError = errorLog.slice(-500) || `Rclone exited with code ${code}`;
                        console.error(`Rclone Error (Task ${task.id}):`, finalError);
                        resolve({ success: false, error: finalError.trim() });
                    }
                });

                proc.on("error", (err) => {
                    resolve({ success: false, error: err.message });
                });

            } catch (e) {
                resolve({ success: false, error: e.message });
            }
        });
    }

    /**
     * 获取文件列表
     */
    static async listRemoteFiles(userId, forceRefresh = false) {
        const cacheKey = `files_${userId}`;
        
        if (!forceRefresh) {
            const cached = cacheService.get(cacheKey);
            if (cached) return cached;
        }
        
        this.loading = true;
        try {
            const conf = await this._getUserConfig(userId);
            const connectionString = this._getConnectionString(conf);
            const fullRemotePath = `${connectionString}${config.remoteFolder}/`;
            const args = ["--config", "/dev/null", "lsjson", fullRemotePath];
            
            const ret = spawnSync(rcloneBinary, args, { 
                env: process.env, 
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024 
            });

            if (ret.error) throw ret.error;
            if (ret.status !== 0) throw new Error(`Rclone lsjson failed: ${ret.stderr}`);

            let files = JSON.parse(ret.stdout || "[]");
            if (!Array.isArray(files)) files = [];
            
            files.sort((a, b) => {
                if (a.IsDir !== b.IsDir) return b.IsDir ? 1 : -1;
                return new Date(b.ModTime) - new Date(a.ModTime);
            });

            // 缓存 10 分钟
            cacheService.set(cacheKey, files, 10 * 60 * 1000);
            this.loading = false;
            return files;

        } catch (e) {
            console.error("List files error (Detail):", e.message); 
            this.loading = false;
            return []; 
        }
    }

    static isLoading() {
        return this.loading;
    }

    /**
     * 简单的文件完整性检查
     */
    static async getRemoteFileInfo(fileName, userId) {
        if (!userId) return null; 

        try {
            const conf = await this._getUserConfig(userId);
            const connectionString = this._getConnectionString(conf);
            const fullRemotePath = `${connectionString}${config.remoteFolder}/${fileName}`;
            
            const ret = spawnSync(rcloneBinary, ["--config", "/dev/null", "lsjson", fullRemotePath], { 
                env: process.env,
                encoding: 'utf-8' 
            });

            if (ret.status !== 0) return null;
            const files = JSON.parse(ret.stdout);
            return files[0] || null;
        } catch (e) {
            return null;
        }
    }
    
    static async killTask(taskId) {
        // Implementation in TaskManager
    }
}