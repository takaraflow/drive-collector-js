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

    static async uploadFile(localPath, task) {
        return new Promise((resolve) => {
            const args = ["copy", localPath, `${config.remoteName}:${config.remoteFolder}`, "--ignore-existing", "--size-only", "--transfers", "1", "--contimeout", "60s", "--progress", "--use-json-log"];
            task.proc = this.rcloneExec(args);
            let stderr = "";
            let lastUpdate = 0;

            task.proc.stderr.on("data", (data) => {
                // 修复：针对缓冲区积压导致的大文件进度不更新，进行按行切割
                const lines = data.toString().split('\n');
                for (let line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const stats = JSON.parse(line);
                        // 适配 Rclone 不同版本的 JSON 层级 (根对象或 stats 键下)
                        const s = stats.stats || stats; 
                        if (s && s.percentage !== undefined) {
                            const now = Date.now();
                            if (now - lastUpdate > 3000) {
                                lastUpdate = now;
                                // 核心修改：实时更新上传进度
                                updateStatus(task, UIHelper.renderProgress(s.bytes || 0, s.totalBytes || 1, "正在转存网盘"));
                            }
                        }
                    } catch (e) {
                        // 正则兜底解析，确保进度条绝对能动
                        const match = line.match(/(\d+)%/);
                        if (match) {
                            const now = Date.now();
                            if (now - lastUpdate > 3000) {
                                lastUpdate = now;
                                const pct = parseInt(match[1]);
                                updateStatus(task, `⏳ **正在转存网盘...**\n\n${UIHelper.renderProgress(pct, 100, "转存进度")}`);
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