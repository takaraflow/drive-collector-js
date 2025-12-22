import { Button } from "telegram/tl/custom/button.js";
import path from "path";
import { config } from "../config/index.js";

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

        let text = `📂 **目录**: \`${config.remoteFolder}\`\n\n`;
        
        if (files.length === 0 && !isLoading) {
            text += "ℹ️ 目录为空或尚未加载。";
        } else {
            pagedFiles.forEach(f => {
                const ext = path.extname(f.Name).toLowerCase();
                const emoji = [".mp4", ".mkv", ".avi"].includes(ext) ? "🎞️" : [".jpg", ".png", ".webp"].includes(ext) ? "🖼️" : [".zip", ".rar", ".7z"].includes(ext) ? "📦" : [".pdf", ".epub"].includes(ext) ? "📝" : "📄";
                const size = (f.Size / 1048576).toFixed(2) + " MB";
                const time = f.ModTime.replace("T", " ").substring(0, 16);
                text += `${emoji} **${f.Name}**\n> \`${size}\` | \`${time}\`\n\n`;
            });
        }

        text += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n📊 *第 ${page + 1}/${totalPages || 1} 页 | 共 ${files.length} 个文件*`;
        if (isLoading) text += `\n🔄 _正在同步最新数据..._`;
        
        // 生成分页导航按钮
        const buttons = [
            [
                Button.inline(page <= 0 ? "🚫" : "🏠 首页", Buffer.from(`files_page_0`)),
                Button.inline(page <= 0 ? "🚫" : "⬅️ 上一页", Buffer.from(`files_page_${page - 1}`)),
                Button.inline("🔄 刷新", Buffer.from(`files_refresh_${page}`)),
                Button.inline(page >= totalPages - 1 ? "🚫" : "下一页 ➡️", Buffer.from(`files_page_${page + 1}`)),
                Button.inline(page >= totalPages - 1 ? "🚫" : "🔚 尾页", Buffer.from(`files_page_${totalPages - 1}`))
            ]
        ];
        return { text, buttons };
    }
}