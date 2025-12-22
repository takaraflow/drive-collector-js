import { spawn } from "child_process";
import path from "path";
import { config, CACHE_TTL } from "../config/index.js";
import { UIHelper } from "../ui/templates.js";
import { updateStatus, safeEdit } from "../utils/common.js";

// 模块内部状态：文件列表内存缓存与状态锁
let remoteFilesCache = null;
let lastCacheTime = 0;
let isRemoteLoading = false;

/**
 * --- 云端操作工具库 (CloudTool) ---
 */
export class CloudTool {
    /**
     * 基础执行器：统一管理 Rclone 进程生成
     */
    static rcloneExec(args) {
        return spawn("rclone", [...args, "--config", path.resolve(config.configPath)]);
    }

    static async getRemoteFileInfo(fileName) {
        return new Promise((resolve) => {
            const rclone = this.rcloneExec(["lsjson", `${config.remoteName}:${config.remoteFolder}`, "--files-only"]);
            let output = "";
            rclone.stdout.on("data", (data) => output += data);
            rclone.on("close", () => {
                try { resolve(JSON.parse(output).find(f => f.Name === fileName) || null); } catch (e) { resolve(null); }
            });
        });
    }

    static async listRemoteFiles(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && remoteFilesCache && (now - lastCacheTime < CACHE_TTL)) {
            return remoteFilesCache;
        }

        if (isRemoteLoading && remoteFilesCache) return remoteFilesCache;

        isRemoteLoading = true; 
        return new Promise((resolve) => {
            // 增加降权参数，确保并发查询不至于彻底拖慢转存
            const rclone = this.rcloneExec(["lsjson", `${config.remoteName}:${config.remoteFolder}`, "--files-only", "--tpslimit", "2"]);
            let output = "";
            rclone.stdout.on("data", (data) => output += data);
            rclone.on("close", () => {
                try { 
                    const files = JSON.parse(output).sort((a, b) => new Date(b.ModTime) - new Date(a.ModTime));
                    remoteFilesCache = files;
                    lastCacheTime = Date.now();
                    resolve(files);
                } catch (e) { resolve(remoteFilesCache || []); }
                finally { isRemoteLoading = false; }
            });
        });
    }

    /**
     * 上传文件
     * @param {string} localPath 本地路径
     * @param {object} task 任务对象
     * @param {function} onProgress (新增) 心跳回调函数
     */
    static async uploadFile(localPath, task, onProgress = null) {
        return new Promise((resolve) => {
            const args = ["copy", localPath, `${config.remoteName}:${config.remoteFolder}`, "--ignore-existing", "--size-only", "--transfers", "1", "--contimeout", "60s", "--progress", "--use-json-log"];
            task.proc = this.rcloneExec(args);
            let stderr = "";
            let lastUpdate = 0;

            task.proc.stderr.on("data", (data) => {
                const lines = data.toString().split('\n');
                for (let line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const stats = JSON.parse(line);
                        const s = stats.stats || stats;
                        if (s && s.percentage !== undefined) {
                            const now = Date.now();
                            if (now - lastUpdate > 3000) {
                                lastUpdate = now;
                                // 1. 更新 UI
                                updateStatus(task, UIHelper.renderProgress(s.bytes || 0, s.totalBytes || 1, "正在转存网盘"));
                                // 2. (新增) 如果有心跳回调，执行它！
                                if (onProgress) onProgress();
                            }
                        }
                    } catch (e) {
                        // 正则兜底逻辑
                        const match = line.match(/(\d+)%/);
                        if (match) {
                            const now = Date.now();
                            if (now - lastUpdate > 3000) {
                                lastUpdate = now;
                                const pct = parseInt(match[1]);
                                updateStatus(task, UIHelper.renderProgress(pct, 100, "正在转存网盘"));
                                if (onProgress) onProgress(); // 这里也要加
                            }
                        }
                        stderr += line; 
                    }
                }
            });
            task.proc.on("close", (code) => resolve({ success: code === 0, error: stderr.trim() }));
        });
    }

    // 导出当前加载状态供 UI 使用
    static isLoading() {
        return isRemoteLoading;
    }
}