import { Button } from "telegram/tl/custom/button.js";
import path from "path";
import { getConfig } from "../config/index.js";
import { STRINGS, format } from "../locales/zh-CN.js";
import { escapeHTML, formatBytes } from "../utils/common.js";
import { CloudTool } from "../services/rclone.js";

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
        
        return `⏳ <b>${actionName}...</b>${fileInfo}\n\n` + `<code>[${bar}]</code> ${percentage}% (${formatBytes(current)}/${formatBytes(total)})`;
    }

    /**
     * 格式化文件列表页面 (样式：文件名+缩进详情)
     */
    static async renderFilesPage(files, page = 0, pageSize = 6, isLoading = false, userId = null) {
        const start = page * pageSize;
        const pagedFiles = files.slice(start, start + pageSize);
        const totalPages = Math.ceil(files.length / pageSize);

        let text;
        if (userId) {
            const userPath = await CloudTool._getUploadPath(userId);
            text = format(STRINGS.files.directory_prefix, { folder: userPath });
        } else {
            text = format(STRINGS.files.directory_prefix, { folder: getConfig().remoteFolder });
        }
        
        if (files.length === 0 && !isLoading) {
            text += STRINGS.files.dir_empty;
        } else {
            pagedFiles.forEach(f => {
                const ext = path.extname(f.Name).toLowerCase();
                const emoji = [".mp4", ".mkv", ".avi", ".mov", ".flv", ".webm"].includes(ext) ? "🎞️" : [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"].includes(ext) ? "🖼️" : [".mp3", ".wav", ".flac", ".m4a", ".ogg"].includes(ext) ? "🎵" : [".zip", ".rar", ".7z", ".tar", ".gz"].includes(ext) ? "📦" : [".pdf", ".epub", ".txt", ".md", ".docx", ".xlsx", ".pptx"].includes(ext) ? "📝" : "📄";
                const size = formatBytes(f.Size, 2);
                const time = f.ModTime.replace("T", " ").substring(0, 16);
                const displayName = escapeHTML(this._shortenFileName(f.Name, 36));
                text += `${emoji} <b>${displayName}</b>\n    <code>${size}</code> | <code>${time}</code>\n\n`;
            });
        }

        text += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n` + format(STRINGS.files.page_info, { 
            current: page + 1, 
            total: totalPages || 1, 
            count: files.length 
        });
        if (isLoading) text += `\n🔄 <i>${STRINGS.files.syncing}</i>`;
        
        const buttons = [
            this._buildPaginationRow({
                page,
                totalPages,
                refreshData: `files_refresh_${page}`,
                pageData: (targetPage) => `files_page_${targetPage}`,
                labels: STRINGS.files
            })
        ];
        return { text, buttons };
    }

    static _buildPaginationRow({ page, totalPages, refreshData, pageData, labels = {} }) {
        const lastPage = Math.max(0, (totalPages || 1) - 1);
        const row = [];

        if (page > 0) {
            row.push(Button.inline(labels.btn_home || "⏮️", Buffer.from(pageData(0))));
            row.push(Button.inline(labels.btn_prev || "⬅️", Buffer.from(pageData(page - 1))));
        }

        row.push(Button.inline(labels.btn_refresh || "🔄", Buffer.from(refreshData)));

        if (page < lastPage) {
            row.push(Button.inline(labels.btn_next || "➡️", Buffer.from(pageData(page + 1))));
            row.push(Button.inline(labels.btn_end || "⏭️", Buffer.from(pageData(lastPage))));
        }

        return row;
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
     * 生成ASCII进度条
     * @param {number} current - 当前进度值
     * @param {number} total - 总进度值
     * @param {number} length - 进度条长度
     * @returns {string} ASCII进度条字符串
     */
    static generateProgressBar(current, total, length = 20) {
        if (total <= 0) return '';
        const percentage = Math.round((current / total) * 100);
        const filled = Math.max(0, Math.min(length, Math.round((current / total) * length)));
        const bar = "█".repeat(filled) + "░".repeat(length - filled);
        return `[${bar}] ${percentage}%`;
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
        const failedCount = allTasks.filter(t => t.status === 'failed').length;
        const cancelledCount = allTasks.filter(t => t.status === 'cancelled').length;
        const activeCount = Math.max(0, totalCount - completedCount - failedCount - cancelledCount);

        const statusLines = [];
        const overflowTasks = [];

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
            
            // 【重要】无论下载还是上传，只要是焦点任务且有进度，就显示百分比
            let line;
            if (isFocus && total > 0 && (displayStatus === 'downloading' || displayStatus === 'uploading')) {
                const progress = Math.round((downloaded / total) * 100);
                line = `${statusIcon} ${displayName} [${progress}%]`;
            } else if (isFocus && displayStatus === 'uploading' && !total) {
                // 上传中但尚未获取到具体大小时，显示上传中标识
                line = `${statusIcon} ${displayName} [上传中]`;
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

                line = `${statusIcon} ${displayName} (${statusText})`;
            }

            if (isFocus || displayStatus === 'failed') {
                statusLines.push(line);
            } else {
                overflowTasks.push(line);
            }
        });

        let text;

        if (allTasks.length === 0) {
            text = format(STRINGS.task.batch_monitor, {
                current: completedCount,
                total: totalCount,
                statusText: STRINGS.files.batch_empty
            });
            text = text.replace(/━━━━━━━━━━━━━━\n/g, '').replace(/💡 进度条仅显示当前正在处理的文件/g, '');
        } else {
            const compactLines = statusLines.length > 0
                ? statusLines
                : overflowTasks.slice(0, 3);
            const hiddenCount = Math.max(0, totalCount - compactLines.length);
            if (hiddenCount > 0) {
                compactLines.push(`… 其余 ${hiddenCount} 个文件正在队列中`);
            }

            text = format(STRINGS.task.batch_monitor, {
                current: completedCount,
                total: totalCount,
                statusText: [
                    `📌 汇总: ✅${completedCount} 🔄${activeCount} ❌${failedCount} 🚫${cancelledCount}`,
                    ...compactLines
                ].join('\n')
            });

            // 将第二个━━━━━━━━━━━━━━替换为ASCII进度条（如果有焦点任务进度）
            if (total > 0 && (focusStatus === 'downloading' || focusStatus === 'uploading')) {
                const progressBar = `<code>${this.generateProgressBar(downloaded, total)}</code> (${formatBytes(downloaded)}/${formatBytes(total)})`;
                text = text.replace(/━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件/g, `${progressBar}`);
            } else {
                text = text.replace(/\n━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件/g, '');
            }
        }

        return { text };
    }

    /**
      * 渲染系统诊断报告 (HTML 表格格式)
      * @param {Object} data - 诊断数据对象
      * @param {Object} data.networkResults - 网络诊断结果 (NetworkDiagnostic.diagnoseAll() 返回)
      * @param {Object} data.instanceInfo - 实例状态信息 (结构化对象)
      * @param {Object} data.systemResources - 系统资源信息
      * @returns {string} HTML格式的诊断报告
      */
     static renderDiagnosisReport(data) {
         let html = format(STRINGS.diagnosis.title, {}) + '\n━━━━━━━━━━━━━━━━━━━\n';
 
         // 多实例状态
         html += format(STRINGS.diagnosis.multi_instance_title, {}) + '\n';
 
         if (data.instanceInfo) {
             const instance = data.instanceInfo;
             const instanceId = escapeHTML(instance.currentInstanceId || 'unknown');
             const leaderBadge = instance.isLeader ? ` ${STRINGS.diagnosis.leader}` : '';
             
            html += `<code>ID:   ${instanceId}${leaderBadge}</code>\n`;
            html += `<code>TG:   ${instance.tgActive ? '✅ ' + STRINGS.diagnosis.connected : '❌ ' + STRINGS.diagnosis.disconnected} | 🔒 ${instance.isTgLeader ? STRINGS.diagnosis.yes : STRINGS.diagnosis.no}</code>\n`;
            html += `<code>活跃: ${instance.instanceCount || 0} 个实例</code>\n`;
            if (instance.cacheProvider) {
                const provider = escapeHTML(instance.cacheProvider);
                const failover = instance.cacheFailover ? STRINGS.diagnosis.yes : STRINGS.diagnosis.no;
                html += `<code>Cache: ${provider} | Failover: ${failover}</code>\n`;
            }
            if (instance.version) {
                const versionLabel = STRINGS.diagnosis.version_label || "版本";
                html += `<code>${versionLabel}: ${escapeHTML(instance.version)}</code>\n`;
            }
         } else {
             html += `<code>数据获取失败</code>\n`;
         }
 
         html += '\n';
 
         // 网络诊断
         html += format(STRINGS.diagnosis.network_title, {}) + '\n';
 
         if (data.networkResults && data.networkResults.services) {
             const statusEmojis = {
                 ok: '✅',
                 error: '❌',
                 warning: '⚠️'
             };
 
             // 固定长度的标签名，实现表格对齐效果
              const serviceLabels = {
                  'telegram': 'TG-MT',
                  'd1': 'DB-D1',
                  'kv': 'KV-ST',
                  'rclone': 'RCLONE',
                  'bot': 'TG-BOT',
                  'tunnel': 'TUNNEL',
                  'redis': 'REDIS'
              };
 
             for (const [service, result] of Object.entries(data.networkResults.services)) {
                 const emoji = statusEmojis[result.status] || '❓';
                 const label = serviceLabels[service] || service.toUpperCase();
                 const responseTime = result.responseTime || 'N/A';
                 
                 // 使用固定长度的标签名实现对齐
                 html += `<code>${label.padEnd(7)}: ${emoji} ${escapeHTML(result.message)} (${responseTime})</code>\n`;
             }
         } else {
             html += `<code>网络诊断数据为空</code>\n`;
         }
 
         html += '\n';
 
         // 系统资源
         html += format(STRINGS.diagnosis.system_resources_title, {}) + '\n';
 
         if (data.systemResources) {
             const res = data.systemResources;
             html += `<code>内存: ${res.memoryMB || 'N/A'}</code>\n`;
             html += `<code>运行: ${res.uptime || 'N/A'}</code>\n`;
         } else {
             html += `<code>系统资源数据为空</code>\n`;
         }
 
         html += '━━━━━━━━━━━━━━━━━━━\n';
 
         // 总结状态
         if (data.networkResults && data.networkResults.services) {
             const errorCount = Object.values(data.networkResults.services).filter(r => r.status === 'error').length;
             if (errorCount > 0) {
                 html += `⚠️ 发现 ${errorCount} 个服务异常，请检查网络连接或配置。`;
             } else {
                 html += `✅ 所有服务运行正常`;
             }
         } else {
             html += `⚠️ 无法获取完整的诊断信息`;
         }
 
         return html;
     }

     /**
      * 渲染全局任务队列概览
      * @param {Object} data - { statusCounts, activeTasks, userCounts }
      * @returns {{text: string, buttons: Array}} HTML格式的队列报告和按钮
      */
     static renderTaskQueue(data) {
         const TQ = STRINGS.task_queue;
         const statusLabels = TQ.status_labels;
         let html = TQ.title + '\n━━━━━━━━━━━━━━━━━━━\n';

         // 状态分布
         html += TQ.status_dist + '\n';
         const orderedStatuses = ['queued', 'downloading', 'uploading', 'completed', 'failed', 'cancelled'];
         let totalActive = 0;
         for (const s of orderedStatuses) {
             const count = data.statusCounts[s] || 0;
             if (count > 0 || ['queued', 'downloading', 'uploading'].includes(s)) {
                 const label = statusLabels[s] || s;
                 html += format(TQ.status_row, { status: label, count }) + '\n';
             }
             if (['queued', 'downloading', 'uploading'].includes(s)) {
                 totalActive += count;
             }
         }

         html += '\n';

         // 活跃任务
         if (data.activeTasks.length > 0) {
             html += format(TQ.active_tasks, { limit: data.activeTasks.length }) + '\n';
             for (let i = 0; i < data.activeTasks.length; i++) {
                 const t = data.activeTasks[i];
                 const name = this._shortenFileName(t.file_name || '-', 25);
                 const statusIcon = (statusLabels[t.status] || t.status).split(' ')[0];
                 const time = t.updated_at ? this._formatRelativeTime(t.updated_at) : '-';
                 html += format(TQ.task_row, {
                     index: i + 1,
                     statusIcon,
                     name: escapeHTML(name),
                     user: escapeHTML(String(t.user_id)),
                     time
                 }) + '\n';
             }
         } else {
             html += TQ.no_active + '\n';
         }

         html += '\n';

         // 用户分布
         if (data.userCounts.length > 0) {
             html += TQ.user_dist + '\n';
             for (let i = 0; i < data.userCounts.length; i++) {
                 const u = data.userCounts[i];
                 html += format(TQ.user_row, {
                     index: i + 1,
                     userId: escapeHTML(String(u.user_id)),
                     count: u.count
                 }) + '\n';
             }
         }

         html += '━━━━━━━━━━━━━━━━━━━';

         // 状态筛选按钮（按信息密度收敛：活跃状态保留，历史状态仅非零显示）
         const activeStatuses = ['queued', 'downloading', 'uploading'];
         const otherStatuses = ['completed', 'failed', 'cancelled'];
         const btnRow1 = activeStatuses.map(s => {
             const count = data.statusCounts[s] || 0;
             const label = (statusLabels[s] || s).split(' ').pop();
             return Button.inline(`${this._statusActionIcon(s)} ${label}(${count})`, Buffer.from(`tq_${s}_0`));
         });
         const btnRow2 = otherStatuses
             .filter(s => (data.statusCounts[s] || 0) > 0)
             .map(s => {
                 const count = data.statusCounts[s] || 0;
                 const label = (statusLabels[s] || s).split(' ').pop();
                 return Button.inline(`${this._statusActionIcon(s)} ${label}(${count})`, Buffer.from(`tq_${s}_0`));
             });
         const buttons = btnRow2.length > 0 ? [btnRow1, btnRow2] : [btnRow1];

         return { text: html, buttons };
     }

     /**
      * 渲染指定状态的任务详情列表
      * @param {string} status - 任务状态
      * @param {Object} data - { tasks, total, page, pageSize, totalPages }
      * @returns {{text: string, buttons: Array}}
      */
     static renderTaskQueueDetail(status, data) {
         const TQ = STRINGS.task_queue;
         const statusLabels = TQ.status_labels;
         const statusLabel = statusLabels[status] || status;
         const statusIcon = statusLabel.split(' ')[0];

         let html = format(TQ.detail_title, { status: statusLabel, total: data.total }) + '\n';
         html += '━━━━━━━━━━━━━━━━━━━\n';

         if (data.tasks.length === 0) {
             html += TQ.no_tasks_in_status + '\n';
         } else {
             for (let i = 0; i < data.tasks.length; i++) {
                 const t = data.tasks[i];
                 const name = this._shortenFileName(t.file_name || '-', 25);
                 const time = t.updated_at ? this._formatRelativeTime(t.updated_at) : '-';
                 html += format(TQ.task_detail_row, {
                     index: data.page * data.pageSize + i + 1,
                     statusIcon,
                     name: escapeHTML(name),
                     user: escapeHTML(String(t.user_id)),
                     time
                 }) + '\n';
                 // 失败任务显示错误原因
                 if (status === 'failed' && t.error_msg) {
                     const shortError = t.error_msg.length > 50 ? t.error_msg.substring(0, 50) + '...' : t.error_msg;
                     html += format(TQ.task_error_row, { error: escapeHTML(shortError) }) + '\n';
                 }
                 // 显示文件大小
                 if (t.file_size) {
                     html += format(TQ.task_size_row, { size: formatBytes(t.file_size) }) + '\n';
                 }
             }
         }

         html += '━━━━━━━━━━━━━━━━━━━\n';
         html += format(TQ.detail_page_info, {
             current: data.page + 1,
             total: data.totalPages || 1,
             count: data.total
         });

         // 翻页按钮
         const page = data.page;
         const totalPages = data.totalPages;
         const navRow = this._buildPaginationRow({
             page,
             totalPages,
             refreshData: `tq_refresh_${status}_${page}`,
             pageData: (targetPage) => `tq_${status}_${targetPage}`,
             labels: TQ
         });
         const backRow = [
             Button.inline(this._withLeadingIcon(TQ.btn_back, '↩️'), Buffer.from('tq_back'))
         ];

         const retryRows = [];
         if (status === 'failed') {
             if (data.tasks.some(task => task.id)) {
                 retryRows.push([
                     Button.inline(this._withLeadingIcon(TQ.btn_retry_failed_page, '🔄'), Buffer.from(`retry_failed_page_${data.page}`))
                 ]);
             }
         }

         const buttons = retryRows.length > 0
             ? [backRow, ...retryRows, navRow]
             : [backRow, navRow];

         return { text: html, buttons };
     }

     /**
      * 格式化相对时间
      */
     static _formatRelativeTime(timestamp) {
         const diff = Date.now() - timestamp;
         if (diff < 0) return '刚刚';
         if (diff < 60000) return '刚刚';
         if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
         if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
         return `${Math.floor(diff / 86400000)}天前`;
     }

     static _statusActionIcon(status) {
         const icons = {
             queued: '🕒',
             downloading: '⬇️',
             downloaded: '📦',
             uploading: '⬆️',
             completed: '✅',
             failed: '❌',
             cancelled: '🚫'
         };
         return icons[status] || '•';
     }

     static _withLeadingIcon(label, icon) {
         const value = String(label || '');
         if (/^[\u2190-\u21FF\u2300-\u23FF\u2600-\u27BF]/u.test(value)) {
             return value;
         }
         const first = value.codePointAt(0);
         if (first && first > 0xffff) {
             return value;
         }
         return `${icon} ${value}`;
     }
 }
