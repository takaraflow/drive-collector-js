import { Button } from "telegram/tl/custom/button.js";
import path from "path";
import { config } from "../config/index.js";
import { STRINGS, format } from "../locales/zh-CN.js";

/**
 * --- UI 模板工具库 (UIHelper) ---
 */
export class UIHelper {
    /**
     * 生成 ASCII 进度条文本
     */
    static renderProgress(current, total, actionName = "正在拉取资源") {
        const percentage = (current / (total || 1) * 100).toFixed(1);
        const barLen = 20;
        const filled = Math.round(barLen * (current / (total || 1)));
        const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
        return `⏳ **${actionName}...**\n\n` + `\`[${bar}]\` ${percentage}% (${(current / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`;
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
                text += `${emoji} **${f.Name}**\n> \`${size}\` | \`${time}\`\n\n`;
            });
        }

        text += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` + format(STRINGS.files.page_info, { 
            current: page + 1, 
            total: totalPages || 1, 
            count: files.length 
        });
        if (isLoading) text += `\n🔄 _${STRINGS.files.syncing}_`;
        
        // 生成分页导航按钮
        const buttons = [
            [
                Button.inline(page <= 0 ? "🚫" : STRINGS.files.btn_home, Buffer.from(`files_page_0`)),
                Button.inline(page <= 0 ? "🚫" : STRINGS.files.btn_prev, Buffer.from(`files_page_${page - 1}`)),
                Button.inline(STRINGS.files.btn_refresh, Buffer.from(`files_refresh_${page}`)),
                Button.inline(page >= totalPages - 1 ? "🚫" : STRINGS.files.btn_next, Buffer.from(`files_page_${page + 1}`)),
                Button.inline(page >= totalPages - 1 ? "🚫" : STRINGS.files.btn_end, Buffer.from(`files_page_${totalPages - 1}`))
            ]
        ];
        return { text, buttons };
    }
}