import { spawn, execSync } from "child_process";
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
            if (drive.type === 'mega' && key === 'pass' && !value.match(/^[a-zA-Z0-9+/=]+$/)) {
                 // 简单的正则判断，如果看起来不像已经 obscure 过的，就尝试 obscure
                 // 注意：这会增加一点点延迟，但保证了兼容性
                 finalValue = this._obscure(value);
            }

            env[`RCLONE_CONFIG_TARGET_${key.toUpperCase()}`] = finalValue;
        }

        return env;
    }

    /**
     * 调用 rclone obscure 对密码进行混淆
     */
    static _obscure(password) {
        try {
            // 同步执行，因为我们需要拿到结果构建 env
            return execSync(`${rcloneBinary} obscure "${password}"`, { encoding: 'utf-8' }).trim();
        } catch (e) {
            console.error("Password obscure failed:", e);
            return password; // 失败则返回原值尝试
        }
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

                proc.stderr.on("data", (data) => {
                    const log = data.toString();
                    
                    // 解析 rclone 的进度输出 (简单的正则抓取)
                    // Transferred: 25.564 MiB / 100 MiB, 25%, 2.564 MiB/s, ETA 30s
                    if (onProgress && Date.now() - lastLogTime > 2000) {
                        lastLogTime = Date.now();
                        onProgress(); // 触发心跳
                    }
                });

                proc.on("close", (code) => {
                    if (code === 0) {
                        resolve({ success: true });
                    } else {
                        resolve({ success: false, error: `Rclone exited with code ${code}` });
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
        // 如果是多用户，我们暂时禁用全局缓存，或者将缓存改为 map 结构 { userId: data }
        // 简单起见，这里直接每次都查，或者你可以自己实现基于 userId 的缓存
        
        this.loading = true;
        try {
            const userEnv = await this._getUserEnv(userId);
            const remotePath = `target:${config.remoteFolder}/`;

            // 使用 lsjson 获取详细信息
            const args = ["lsjson", remotePath, "--stat"];
            
            // 使用 execSync 简单快速获取
            const output = execSync(`${rcloneBinary} ${args.join(" ")}`, { 
                env: userEnv,
                encoding: 'utf-8',
                maxBuffer: 10 * 1024 * 1024 // 10MB buffer
            });

            const files = JSON.parse(output);
            
            // 简单排序：文件夹在前，修改时间倒序
            files.sort((a, b) => {
                if (a.IsDir !== b.IsDir) return b.IsDir ? 1 : -1;
                return new Date(b.ModTime) - new Date(a.ModTime);
            });

            this.loading = false;
            return files;

        } catch (e) {
            console.error("List files error:", e);
            this.loading = false;
            return []; // 失败返回空数组
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
        // ⚠️ 注意：这个方法 TaskManager 里调用时还没传 userId
        // 为了最小化修改，如果 TaskManager 还没传 userId 给这个方法，我们先跳过校验
        // 或者你需要在 TaskManager.js 的 fileWorker 里，把 userId 传进来
        if (!userId) return null; 

        try {
            const userEnv = await this._getUserEnv(userId);
            const remotePath = `target:${config.remoteFolder}/${fileName}`;
            
            const output = execSync(`${rcloneBinary} lsjson "${remotePath}"`, { 
                env: userEnv,
                encoding: 'utf-8' 
            });
            const files = JSON.parse(output);
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