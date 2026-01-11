import { d1 } from "../src/services/d1.js";
import { cache } from "../src/services/CacheService.js";
import { logger } from "../src/services/logger/index.js";

const log = logger.withModule ? logger.withModule('TaskMonitor') : logger;

/**
 * 实时监控任务状态
 */
class TaskMonitor {
    constructor() {
        this.isRunning = false;
        this.interval = null;
        this.lastTaskCount = 0;
        this.lastProcessingCount = 0;
    }

    async start() {
        if (this.isRunning) {
            console.log("⚠️ 监控已在运行中");
            return;
        }

        this.isRunning = true;
        console.log("🔍 启动任务状态监控 (每10秒检查一次)...");
        console.log("按 Ctrl+C 停止监控\n");

        // 立即执行一次检查
        await this.checkStatus();

        // 设置定时检查
        this.interval = setInterval(async () => {
            await this.checkStatus();
        }, 10000);

        // 处理退出信号
        process.on('SIGINT', () => {
            this.stop();
        });
    }

    async stop() {
        if (!this.isRunning) return;

        this.isRunning = false;
        if (this.interval) {
            clearInterval(this.interval);
        }
        console.log("\n🛑 监控已停止");
        process.exit(0);
    }

    async checkStatus() {
        const timestamp = new Date().toLocaleTimeString();
        console.log(`\n🕐 [${timestamp}] 检查任务状态...`);

        try {
            // 获取任务统计
            const taskStats = await d1.fetchOne(`
                SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) as queued,
                    SUM(CASE WHEN status = 'downloading' THEN 1 ELSE 0 END) as downloading,
                    SUM(CASE WHEN status = 'uploading' THEN 1 ELSE 0 END) as uploading,
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
                FROM tasks
            `);

            console.log(`📊 任务统计: 总计${taskStats.total} | 排队${taskStats.queued} | 下载${taskStats.downloading} | 上传${taskStats.uploading} | 完成${taskStats.completed} | 失败${taskStats.failed}`);

            // 检查是否有变化
            const currentProcessing = taskStats.downloading + taskStats.uploading;
            if (currentProcessing !== this.lastProcessingCount) {
                console.log(`🔄 处理中任务数量变化: ${this.lastProcessingCount} → ${currentProcessing}`);
                this.lastProcessingCount = currentProcessing;
            }

            // 检查卡住的任务
            if (taskStats.queued > 0 && currentProcessing === 0) {
                console.log("⚠️ 警告: 有排队任务但没有处理中的任务!");
                await this.checkStuckTasks();
            }

            // 检查最近失败的任务
            if (taskStats.failed > 0) {
                await this.checkRecentFailures();
            }

            // 检查系统状态
            await this.checkSystemHealth();

        } catch (error) {
            console.error(`❌ 检查失败: ${error.message}`);
        }
    }

    async checkStuckTasks() {
        console.log("🔍 检查卡住的任务...");

        const stuckTasks = await d1.fetchAll(`
            SELECT id, file_name, status, created_at, updated_at 
            FROM tasks 
            WHERE status = 'queued' 
            AND created_at < ? 
            ORDER BY created_at ASC 
            LIMIT 3
        `, [Date.now() - 5 * 60 * 1000]); // 5分钟前创建的排队任务

        if (stuckTasks.length > 0) {
            console.log("❌ 发现可能卡住的任务:");
            stuckTasks.forEach((task, index) => {
                const age = Math.floor((Date.now() - task.created_at) / 60000);
                console.log(`   ${index + 1}. ${task.id} (${task.file_name}) - 卡住${age}分钟`);
            });
        }
    }

    async checkRecentFailures() {
        const recentFailures = await d1.fetchAll(`
            SELECT id, file_name, error_msg, updated_at 
            FROM tasks 
            WHERE status = 'failed' 
            AND updated_at > ? 
            ORDER BY updated_at DESC 
            LIMIT 2
        `, [Date.now() - 10 * 60 * 1000]); // 最近10分钟失败的任务

        if (recentFailures.length > 0) {
            console.log("❌ 最近失败的任务:");
            recentFailures.forEach((task, index) => {
                const minutesAgo = Math.floor((Date.now() - task.updated_at) / 60000);
                console.log(`   ${index + 1}. ${task.file_name} - ${minutesAgo}分钟前失败`);
                console.log(`      错误: ${task.error_msg}`);
            });
        }
    }

    async checkSystemHealth() {
        try {
            // 检查缓存
            await cache.get("health_check", "text");
            console.log("✅ 缓存正常");
        } catch (err) {
            console.log("❌ 缓存异常:", err.message);
        }

        try {
            // 检查数据库
            await d1.fetchOne("SELECT 1");
            console.log("✅ 数据库正常");
        } catch (err) {
            console.log("❌ 数据库异常:", err.message);
        }
    }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
    const monitor = new TaskMonitor();
    monitor.start().catch(console.error);
}

export { TaskMonitor };