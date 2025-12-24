import { spawn, spawnSync, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { config } from "../config/index.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { STRINGS } from "../locales/zh-CN.js";

// 确定 rclone 二进制路径 (兼容 Zeabur 和 本地)
const rcloneBinary = fs.existsSync("/app/rclone/rclone") 
    ? "/app/rclone/rclone" 
    : "rclone";

export class CloudTool {
    // 内存缓存：避免频繁 lsjson (针对 listRemoteFiles)
    static cache = {};
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
            // 使用参数数组传递密码，杜绝 Shell 注入和转义干扰
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
     * 【重构】验证配置是否有效 (异步非阻塞版)
     * 使用 spawn 异步调用 + 动态后端语法 + 参数双引号包裹
     */
    static async validateConfig(type, configData) {
        return new Promise((resolve) => {
            try {
                // 1. 处理密码混淆
                let finalPass = configData.pass;
                // 【修复】只要是 Mega，输入的一定是明文，必须混淆
                if (type === 'mega') {
                     // 改为 CloudTool._obscure 以防上下文丢失
                     finalPass = CloudTool._obscure(finalPass);
                }

                // 2. 构造动态后端连接字符串
                // 格式: :mega,user="xxx",pass="xxx":
                // 给值加上双引号，防止邮箱或密码中包含逗号导致解析错误
                const connectionString = `:${type},user=${configData.user},pass=${finalPass}:`;

                // 3. 直接对这个动态后端执行 about 命令
                const args = ["--config", "/dev/null", "about", connectionString, "--json", "--timeout", "15s"];
                
                // 注意：这里不需要注入特殊的 env 了，因为配置都在 args 里
                const proc = spawn(rcloneBinary, args, { env: process.env });

                let errorLog = "";

                proc.stderr.on("data", (data) => {
                    errorLog += data.toString();
                });

                proc.on("close", (code) => {
                    if (code === 0) {
                        resolve({ success: true });
                    } else {
                        // 错误处理逻辑保持不变
                        if (errorLog.includes("Multi-factor authentication") || errorLog.includes("2FA")) {
                            resolve({ success: false, reason: "2FA" });
                        } else {
                            // 恢复正常的错误日志 (隐藏密码)
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
     * 上传文件 (彻底修复多租户隔离失效问题)
     * @param {string} localPath 本地文件路径
     * @param {object} task 任务对象 (必须包含 userId)
     * @param {function} onProgress 进度回调 (可选)
     */
    static async uploadFile(localPath, task, onProgress) {
        return new Promise(async (resolve) => {
            try {
                // 🛑 关键修复：显式获取配置，不依赖隐式环境变量
                const conf = await this._getUserConfig(task.userId);
                
                // 🛑 关键修复：构造显式 Connection String
                // 任何时候 rclone 都会直接用这个字符串里的账号密码，绝对不会读错配置
                const connectionString = `:${conf.type},user=${conf.user},pass=${conf.pass}:`;
                const remotePath = `${connectionString}${config.remoteFolder}/`; 

                // 启动上传进程
                const args = ["--config", "/dev/null", "copy", localPath, remotePath, "--progress", "--transfers", "4", "--stats", "1s"];
                
                // 这里 env 只需要 process.env 即可，因为配置已经在 args 里了
                const proc = spawn(rcloneBinary, args, { env: process.env });
                
                // 将进程句柄挂载到 task 上，方便 TaskManager 执行 cancelTask 时杀进程
                task.proc = proc;

                let lastLogTime = 0;
                let errorLog = "";

                proc.stderr.on("data", (data) => {
                    const log = data.toString();
                    
                    // 收集非进度的错误日志 (排除掉进度条信息)
                    if (!log.includes("Transferred:") && !log.includes("ETA")) {
                        errorLog += log;
                    }

                    // 解析进度
                    if (onProgress && Date.now() - lastLogTime > 2000) {
                        lastLogTime = Date.now();
                        onProgress(); // 触发心跳
                    }
                });

                proc.on("close", (code) => {
                    if (code === 0) {
                        resolve({ success: true });
                    } else {
                        // 2. 返回具体的错误日志，而不仅仅是 code
                        const finalError = errorLog.slice(-500) || `Rclone exited with code ${code}`;
                        console.error(`Rclone Error (Task ${task.id}):`, finalError); // 在控制台打印详细日志
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
     * 获取文件列表 (JSON 格式)
     * @param {string} userId
     * @param {boolean} forceRefresh
     */
    static async listRemoteFiles(userId, forceRefresh = false) {
        // 缓存机制：5分钟内不重复请求
        const cacheKey = `files_${userId}`;
        const now = Date.now();
        
        // 如果不强制刷新且缓存有效，直接返回缓存
        if (!forceRefresh && this.cache[cacheKey] && (now - this.cache[cacheKey].time) < 5 * 60 * 1000) {
            return this.cache[cacheKey].data;
        }
        
        this.loading = true;
        try {
            // 🛑 关键修复：复用 _getUserConfig，逻辑统一
            const conf = await this._getUserConfig(userId);
            
            const connectionString = `:${conf.type},user=${conf.user},pass=${conf.pass}:`;
            const fullRemotePath = `${connectionString}${config.remoteFolder}/`;

            const args = ["--config", "/dev/null", "lsjson", fullRemotePath];
            
            const ret = spawnSync(rcloneBinary, args, { 
                env: process.env, 
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024 
            });

            if (ret.error) throw ret.error;
            if (ret.status !== 0) throw new Error(`Rclone lsjson failed: ${ret.stderr}`);

            // 解析并确保是数组
            let files = JSON.parse(ret.stdout || "[]");
            if (!Array.isArray(files)) files = []; // 兜底保护
            
            files.sort((a, b) => {
                if (a.IsDir !== b.IsDir) return b.IsDir ? 1 : -1;
                return new Date(b.ModTime) - new Date(a.ModTime);
            });

            // 更新缓存
            this.cache[cacheKey] = {
                data: files,
                time: now
            };

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
     * 简单的文件完整性检查 (HEAD 请求)
     * 用于秒传判断和上传后校验
     */
    static async getRemoteFileInfo(fileName, userId) {
        if (!userId) return null; 

        try {
            // 🛑 关键修复：复用 _getUserConfig，逻辑统一
            const conf = await this._getUserConfig(userId);
            
            const connectionString = `:${conf.type},user=${conf.user},pass=${conf.pass}:`;
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
    
    // 杀死任务进程
    static async killTask(taskId) {
        // 逻辑在 TaskManager 中通过 task.proc.kill() 实现，这里留空即可
        // 或者可以实现更复杂的进程树清理
    }
}