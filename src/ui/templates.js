import { Button } from "telegram/tl/custom/button.js";
import path from "path";
import { config } from "../config/index.js";
import { STRINGS, format } from "../locales/zh-CN.js";
import { escapeHTML } from "../utils/common.js";

/**
 * --- UI 模板工具库 (UIHelper) ---
 */
export class UIHelper {
    /**
     * 生成 ASCII 进度条文本
     */
    static renderProgress(current, total, actionName = STRINGS.task.downloading, fileName = '') {
        const percentage = (current / (total || 1) * 100).toFixed(1);
        const barLen = 20;
        const filled = Math.max(0, Math.min(barLen, Math.round(barLen * (current / (total || 1)))));
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
        
        // 如果提供了文件名，显示简洁版本
        const displayName = fileName ? escapeHTML(this._shortenFileName(fileName, 25)) : '';
        const fileInfo = fileName ? `\n📄 ${displayName}` : '';
        
        return `⏳ <b>${actionName}...</b>${fileInfo}\n\n` + `<code>[${bar}]</code> ${percentage}% (${(current / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`;
    }

    /**
     * 格式化文件列表页面 (样式：文件名+缩进详情)
     */
    static renderFilesPage(files, page = 0, pageSize = 6, isLoading = false) {
        const start = page * pageSize;
        const pagedFiles = files.slice(start, start + pageSize);
        const totalPages = Math.ceil(files.length / pageSize);

        let text = format(STRINGS.files.directory_prefix, { folder: config.remoteFolder });
        
        if (files.length === 0 && !isLoading) {
            text += STRINGS.files.dir_empty_or_loading;
        } else {
            pagedFiles.forEach(f => {
                const ext = path.extname(f.Name).toLowerCase();
                const emoji = [".mp4", ".mkv", ".avi"].includes(ext) ? "🎞️" : [".jpg", ".png", ".webp"].includes(ext) ? "🖼️" : [".zip", ".rar", ".7z"].includes(ext) ? "📦" : [".pdf", ".epub"].includes(ext) ? "📝" : "📄";
                const size = (f.Size / 1048576).toFixed(2) + " MB";
                const time = f.ModTime.replace("T", " ").substring(0, 16);
                text += `${emoji} <b>${escapeHTML(f.Name)}</b>\n    <code>${size}</code> | <code>${time}</code>\n\n`;
            });
        }

        text += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` + format(STRINGS.files.page_info, { 
            current: page + 1, 
            total: totalPages || 1, 
            count: files.length 
        });
        if (isLoading) text += `\n🔄 <i>${STRINGS.files.syncing}</i>`;
        
        // 生成分页导航按钮
        const buttons = [
            [
                Button.inline(page <= 0 ? " " : STRINGS.files.btn_home, Buffer.from(page <= 0 ? "noop" : `files_page_0`)),
                Button.inline(page <= 0 ? " " : STRINGS.files.btn_prev, Buffer.from(page <= 0 ? "noop" : `files_page_${page - 1}`)),
                Button.inline(STRINGS.files.btn_refresh, Buffer.from(`files_refresh_${page}`)),
                Button.inline(page >= totalPages - 1 ? " " : STRINGS.files.btn_next, Buffer.from(page >= totalPages - 1 ? "noop" : `files_page_${page + 1}`)),
                Button.inline(page >= totalPages - 1 ? " " : STRINGS.files.btn_end, Buffer.from(page >= totalPages - 1 ? "noop" : `files_page_${totalPages - 1}`))
            ]
        ];
        return { text, buttons };
    }

    /**
     * 辅助方法：智能截断文件名
     * @param {string} fileName - 完整文件名
     * @param {number} maxLength - 最大长度（默认25个字符）
     * @returns {string} 截断后的文件名
     */
    static _shortenFileName(fileName, maxLength = 25) {
        if (!fileName || fileName.length <= maxLength) return fileName;

        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);

        // 对于 Telegram 文件名，尝试智能缩短
        if (base.includes('_by_')) {
            const parts = base.split('_by_');
            if (parts.length === 2) {
                // 保留前8个字符和后6个字符
                return `${parts[0].substring(0, 8)}_by_${parts[1].substring(0, 6)}${ext}`;
            }
        }

        // 一般情况：保留开头和结尾
        const keepFromStart = Math.ceil((maxLength - ext.length) * 0.6);
        const keepFromEnd = Math.floor((maxLength - ext.length) * 0.4);
        return `${base.substring(0, keepFromStart)}...${base.substring(base.length - keepFromEnd)}${ext}`;
    }

    /**
     * 🆕 渲染批量任务看板（优化版）
     * @param {Array} allTasks - 数据库中该组的所有任务
     * @param {Object} focusTask - 当前正在操作的 Task 对象
     * @param {string} focusStatus - 当前 Task 的状态
     * @param {number} downloaded - 已下载字节数
     * @param {number} total - 总字节数
     * @param {string} focusErrorMsg - 焦点任务的错误消息（用于实时显示）
     */
    static renderBatchMonitor(allTasks, focusTask, focusStatus, downloaded = 0, total = 0, focusErrorMsg = null) {
        const totalCount = allTasks.length;
        const completedCount = allTasks.filter(t => t.status === 'completed').length;
        
        let statusLines = [];

        allTasks.forEach(t => {
            // 使用 ID 进行精确匹配，而非文件名
            const isFocus = t.id === focusTask.id;
            const dbName = (t.file_name || "").trim();
            
            // 截断文件名以适应移动端显示
            const displayName = escapeHTML(this._shortenFileName(dbName, 20));
            
            // 确定显示状态：如果是焦点任务，使用实时的 focusStatus；否则使用数据库记录的 t.status
            const displayStatus = isFocus ? focusStatus : t.status;

            const statusIcon = displayStatus === 'completed' ? '✅' : 
                              displayStatus === 'failed' ? '❌' : 
                              displayStatus === 'cancelled' ? '🚫' : 
                              (isFocus && (displayStatus === 'downloading' || displayStatus === 'uploading') ? '🔄' : '🕒');
            
            if (isFocus && downloaded > 0 && (displayStatus === 'downloading' || displayStatus === 'uploading')) {
                const progress = Math.round((downloaded / total) * 100);
                statusLines.push(`${statusIcon} ${displayName} [${progress}%]`);
            } else {
                // 使用简短的状态文本
                let statusText = displayStatus === 'completed' ? '完成' :
                                displayStatus === 'failed' ? '失败' :
                                displayStatus === 'cancelled' ? '已取消' :
                                displayStatus === 'downloading' ? '下载中' :
                                displayStatus === 'uploading' ? '上传中' :
                                displayStatus === 'downloaded' ? '已下载' : '等待中';

                // 如果失败状态有错误信息，显示简短错误提示
                if (displayStatus === 'failed') {
                    const errorMsg = isFocus ? focusErrorMsg : t.error_msg;
                    if (errorMsg) {
                        const shortError = errorMsg.length > 30 ? errorMsg.substring(0, 30) + '...' : errorMsg;
                        statusText += `: ${escapeHTML(shortError)}`;
                    }
                }

                statusLines.push(`${statusIcon} ${displayName} (${statusText})`);
            }
        });

        let text;

        if (allTasks.length === 0) {
            text = format(STRINGS.task.batch_monitor, {
                current: completedCount,
                total: totalCount,
                statusText: STRINGS.files.dir_empty_or_loading
            });
            text = text.replace(/━━━━━━━━━━━━━━\n/g, '').replace(/💡 进度条仅显示当前正在处理的文件/g, ''); 
        } else {
            text = format(STRINGS.task.batch_monitor, {
                current: completedCount,
                total: totalCount,
                statusText: statusLines.join('\n')
            });
        }

        return { text };
    }
}