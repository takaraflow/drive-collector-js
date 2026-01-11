import { d1 } from "../src/services/d1.js";
import { cache } from "../src/services/CacheService.js";
import { logger } from "../src/services/logger/index.js";

const log = logger.withModule ? logger.withModule('TaskDiagnosis') : logger;

/**
 * 诊断文件处理卡住的问题
 */
async function diagnoseFileProcessingIssue() {
    console.log("🔬 开始诊断文件处理问题...\n");

    try {
        // 1. 检查最近的文件任务
        console.log("📁 检查最近的文件任务:");
        console.log("========================");
        
        const recentTasks = await d1.fetchAll(`
            SELECT id, user_id, file_name, file_size, status, error_msg, created_at, updated_at 
            FROM tasks 
            WHERE file_name IS NOT NULL 
            ORDER BY created_at DESC 
            LIMIT 10
        `);

        if (recentTasks.length === 0) {
            console.log("❌ 没有找到文件任务记录");
            return;
        }

        recentTasks.forEach((task, index) => {
            const age = Date.now() - task.created_at;
            const ageMinutes = Math.floor(age / 60000);
            const statusIcon = getStatusIcon(task.status);
            
            console.log(`${index + 1}. ${statusIcon} ${task.id}`);
            console.log(`   文件: ${task.file_name} (${formatFileSize(task.file_size)})`);
            console.log(`   状态: ${task.status}`);
            console.log(`   年龄: ${ageMinutes}分钟`);
            console.log(`   用户: ${task.user_id}`);
            
            if (task.error_msg) {
                console.log(`   ❌ 错误: ${task.error_msg}`);
            }
            
            // 检查是否卡住
            if (task.status === 'queued' && ageMinutes > 2) {
                console.log(`   ⚠️ 警告: 排队超过2分钟，可能卡住`);
            }
            if (['downloading', 'uploading'].includes(task.status)) {
                const lastUpdate = Date.now() - task.updated_at;
                const lastUpdateMinutes = Math.floor(lastUpdate / 60000);
                if (lastUpdateMinutes > 5) {
                    console.log(`   ⚠️ 警告: 处理超过5分钟，可能卡住`);
                }
            }
            console.log("");
        });

        // 2. 检查特定用户的问题
        if (recentTasks.length > 0) {
            const userId = recentTasks[0].user_id;
            console.log(`👤 检查用户 ${userId} 的所有任务:`);
            console.log("========================");
            
            const userTasks = await d1.fetchAll(`
                SELECT id, file_name, status, created_at, updated_at 
                FROM tasks 
                WHERE user_id = ? 
                ORDER BY created_at DESC
            `, [userId]);

            console.log(`该用户总任务数: ${userTasks.length}`);
            
            const statusCount = userTasks.reduce((acc, task) => {
                acc[task.status] = (acc[task.status] || 0) + 1;
                return acc;
            }, {});
            
            Object.entries(statusCount).forEach(([status, count]) => {
                console.log(`   ${status}: ${count}个`);
            });
        }

        // 3. 检查处理器状态
        console.log("\n🤖 检查处理器状态:");
        console.log("==================");
        
        const processorTasks = await d1.fetchAll(`
            SELECT id, status, claimed_by, updated_at 
            FROM tasks 
            WHERE status IN ('downloading', 'uploading')
        `);

        console.log(`当前处理中任务: ${processorTasks.length}`);
        
        if (processorTasks.length > 0) {
            processorTasks.forEach((task, index) => {
                const lastUpdate = Date.now() - task.updated_at;
                const lastUpdateMinutes = Math.floor(lastUpdate / 60000);
                console.log(`${index + 1}. ${task.id} - ${task.status} - 处理者: ${task.claimed_by} - ${lastUpdateMinutes}分钟前更新`);
                
                if (lastUpdateMinutes > 5) {
                    console.log(`   ⚠️ 可能卡住，建议检查处理器日志`);
                }
            });
        } else {
            console.log("没有处理中的任务");
        }

        // 4. 检查缓存中的任务锁
        console.log("\n🔒 检查任务锁状态:");
        console.log("==================");
        
        const lockKeys = await cache.listKeys("lock:task:");
        console.log(`任务锁数量: ${lockKeys.length}`);
        
        if (lockKeys.length > 0) {
            for (let i = 0; i < Math.min(5, lockKeys.length); i++) {
                const key = lockKeys[i];
                const lockData = await cache.get(key, "json");
                console.log(`${i + 1}. ${key}: ${JSON.stringify(lockData)}`);
            }
        }

        // 5. 检查QStash消息
        console.log("\n📨 检查QStash消息状态:");
        console.log("==================");
        
        // 这里可以添加QStash相关的检查
        console.log("QStash状态检查需要根据具体实现添加");

        // 6. 给出诊断建议
        console.log("\n💡 诊断建议:");
        console.log("==================");
        
        const queuedTasks = recentTasks.filter(t => t.status === 'queued');
        const activeTasks = recentTasks.filter(t => ['downloading', 'uploading'].includes(t.status));
        const failedTasks = recentTasks.filter(t => t.status === 'failed');

        if (queuedTasks.length > 0 && activeTasks.length === 0) {
            console.log("🔧 问题: 有排队任务但没有处理器");
            console.log("   建议:");
            console.log("   1. 检查 TaskManager 是否正常启动");
            console.log("   2. 检查处理器实例是否获取到任务");
            console.log("   3. 查看处理器日志: npm run start:processor");
        }

        if (activeTasks.length > 0) {
            const stuckTasks = activeTasks.filter(t => {
                const lastUpdate = Date.now() - t.updated_at;
                return lastUpdate > 5 * 60 * 1000; // 5分钟
            });
            
            if (stuckTasks.length > 0) {
                console.log("🔧 问题: 有任务卡在处理状态");
                console.log("   建议:");
                console.log("   1. 检查网络连接");
                console.log("   2. 检查 Rclone 配置");
                console.log("   3. 查看下载/上传日志");
                console.log("   4. 检查磁盘空间");
            }
        }

        if (failedTasks.length > 0) {
            console.log("🔧 问题: 有任务失败");
            console.log("   建议:");
            console.log("   1. 查看失败任务的错误信息");
            console.log("   2. 检查文件权限");
            console.log("   3. 检查远程存储配置");
        }

        console.log("\n📋 下一步调试命令:");
        console.log("==================");
        console.log("1. 实时监控: node scripts/monitor-tasks.js");
        console.log("2. 检查状态: node scripts/check-task-status.js");
        console.log("3. 查看日志: tail -f logs/app.log | grep -E '(TaskManager|ERROR|WARN)'");
        console.log("4. 重启处理器: npm run start:processor");

    } catch (error) {
        console.error("❌ 诊断过程中发生错误:", error);
    }
}

function getStatusIcon(status) {
    const icons = {
        'queued': '⏳',
        'downloading': '⬇️',
        'uploading': '⬆️',
        'completed': '✅',
        'failed': '❌',
        'cancelled': '🚫'
    };
    return icons[status] || '❓';
}

function formatFileSize(bytes) {
    if (!bytes) return '未知';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
    diagnoseFileProcessingIssue().catch(console.error);
}

export { diagnoseFileProcessingIssue };