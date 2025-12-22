import { spawn, spawnSync, execSync } from "child_process";
import path from "path";
import fs from "fs";
import { config } from "../config/index.js";
import { d1 } from "./d1.js"; // 引入数据库

// 确定 rclone 二进制路径 (兼容 Zeabur 和 本地)
const rcloneBinary = fs.existsSync("/app/rclone/rclone") 
    ? "/app/rclone/rclone" 
    : "rclone";

export class CloudTool {
    // 内存缓存：避免频繁 lsjson (针对 listRemoteFiles)
    static cache = {
        data: null,
        time: 0
    };
    static loading = false;

    /**
     * 【内部核心】获取用户的 Rclone 环境变量
     * 这会在运行时动态创建一个名为 "target" 的 Rclone 配置
     */
    static async _getUserEnv(userId) {
        if (!userId) throw new Error("User ID is required for Rclone operations");

        // 1. 查库
        const drive = await d1.fetchOne(
            "SELECT * FROM user_drives WHERE user_id = ? AND status = 'active'", 
            [userId.toString()]
        );
        
        if (!drive) {
            throw new Error("未绑定网盘，请发送 /login 进行绑定");
        }

        const driveConfig = JSON.parse(drive.config_data);
        const env = { ...process.env }; // 继承当前环境变量

        // 2. 注入动态配置 -> 定义一个名为 'target' 的 remote
        // 对应 rclone.conf 中的 [target] type = ...
        env[`RCLONE_CONFIG_TARGET_TYPE`] = drive.type;

        for (const [key, value] of Object.entries(driveConfig)) {
            // 3. 特殊处理：Mega 的密码需要 obscure (混淆)
            // 如果存的是明文密码，我们需要在这里实时混淆一下
            let finalValue = value;
            // 【修复】只要是 Mega 的密码，无条件进行混淆
            // 去掉了之前的正则判断，因为简单密码也会命中正则，导致漏掉混淆
            if (drive.type === 'mega' && key === 'pass') {
                 finalValue = this._obscure(value);
            }

            env[`RCLONE_CONFIG_TARGET_${key.toUpperCase()}`] = finalValue;
        }

        return env;
    }

    /**
     * 【重要修复】调用 rclone obscure 对密码进行混淆
     * 使用 spawnSync 避免 Shell 特殊字符转义问题
     */
    static _obscure(password) {
        try {
            // 使用参数数组传递密码，杜绝 Shell 注入和转义干扰
            const ret = spawnSync(rcloneBinary, ["obscure", password], { encoding: 'utf-8' });
            
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
                     finalPass = this._obscure(finalPass);
                }

                // 2. 构造动态后端连接字符串
                // 格式: :mega,user="xxx",pass="xxx":
                // 给值加上双引号，防止邮箱或密码中包含逗号导致解析错误
                const connectionString = `:${type},user=${configData.user},pass=${finalPass}:`;

                // 3. 直接对这个动态后端执行 about 命令
                const args = ["about", connectionString, "--json", "--timeout", "15s"];
                
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
     * 上传文件
     * @param {string} localPath 本地文件路径
     * @param {object} task 任务对象 (必须包含 userId)
     * @param {function} onProgress 进度回调 (可选)
     */
    static async uploadFile(localPath, task, onProgress) {
        return new Promise(async (resolve) => {
            try {
                // 获取专属环境变量
                const userEnv = await this._getUserEnv(task.userId);
                
                // 目标路径：使用动态的 'target' remote
                const remotePath = `target:${config.remoteFolder}/`; 

                // 启动上传进程
                const args = ["copy", localPath, remotePath, "--progress", "--transfers", "4", "--stats", "1s"];
                const proc = spawn(rcloneBinary, args, { env: userEnv });
                
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
        this.loading = true;
        try {
            // 1. 获取包含混淆后密码的 env
            const userEnv = await this._getUserEnv(userId);
            
            // 2. 提取配置，构造 Connection String (绕过环境变量隐式传递的问题)
            const type = userEnv['RCLONE_CONFIG_TARGET_TYPE'];
            const user = userEnv['RCLONE_CONFIG_TARGET_USER'];
            const pass = userEnv['RCLONE_CONFIG_TARGET_PASS'];
            
            const connectionString = `:${type},user=${user},pass=${pass}:`;
            const fullRemotePath = `${connectionString}${config.remoteFolder}/`;

            // 【关键修复】移除 "--stat" 参数
            // --stat 会让 lsjson 返回目录对象本身(Object)，而不是目录内容列表(Array)
            // 这就是导致 "files.sort is not a function" 的根本原因
            const args = ["lsjson", fullRemotePath];
            
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
            const userEnv = await this._getUserEnv(userId);
            
            const type = userEnv['RCLONE_CONFIG_TARGET_TYPE'];
            const user = userEnv['RCLONE_CONFIG_TARGET_USER'];
            const pass = userEnv['RCLONE_CONFIG_TARGET_PASS'];
            const connectionString = `:${type},user=${user},pass=${pass}:`;
            
            const fullRemotePath = `${connectionString}${config.remoteFolder}/${fileName}`;
            
            const ret = spawnSync(rcloneBinary, ["lsjson", fullRemotePath], { 
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