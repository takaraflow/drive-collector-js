import { d1 } from "../src/services/d1.js";
import { cache } from "../src/services/CacheService.js";
import { logger } from "../src/services/logger/index.js";

const log = logger.withModule ? logger.withModule('TaskDebug') : logger;

/**
 * 检查任务状态和系统健康
 */
async function checkTaskStatus() {
    console.log("🔍 检查任务状态和系统健康...\n");

    try {
        // 1. 检查数据库中的任务
        console.log("📊 数据库任务状态:");
        console.log("==================");
        
        const allTasks = await d1.fetchAll(`
            SELECT id, user_id, file_name, status, error_msg, created_at, updated_at 
            FROM tasks 
            ORDER BY created_at DESC 
            LIMIT 10
        `);

        if (allTasks.length === 0) {
            console.log("❌ 数据库中没有任务记录");
        } else {
            allTasks.forEach((task, index) => {
                const age = Date.now() - task.created_at;
                const ageMinutes = Math.floor(age / 60000);
                
                console.log(`${index + 1}. 任务ID: ${task.id}`);
                console.log(`   文件: ${task.file_name}`);
                console.log(`   状态: ${task.status}`);
                console.log(`   年龄: ${ageMinutes}分钟`);
                if (task.error_msg) {
                    console.log(`   错误: ${task.error_msg}`);
                }
                console.log("");
            });
        }

        // 2. 检查缓存中的任务
        console.log("🗄️ 缓存中的任务:");
        console.log("==================");
        
        const cacheKeys = await cache.listKeys("task:");
        console.log(`缓存任务数量: ${cacheKeys.length}`);
        
        if (cacheKeys.length > 0) {
            // 检查前5个任务的详细信息
            for (let i = 0; i < Math.min(5, cacheKeys.length); i++) {
                const key = cacheKeys[i];
                const taskData = await cache.get(key, "json");
                console.log(`${i + 1}. ${key}: ${JSON.stringify(taskData)}`);
            }
        }

        // 3. 检查待处理任务队列
        console.log("⏳ 待处理任务队列:");
        console.log("==================");
        
        const waitingTasks = await d1.fetchAll(`
            SELECT id, file_name, status, created_at 
            FROM tasks 
            WHERE status = 'queued' 
            ORDER BY created_at ASC 
            LIMIT 5
        `);

        console.log(`排队任务数量: ${waitingTasks.length}`);
        waitingTasks.forEach((task, index) => {
            const age = Date.now() - task.created_at;
            const ageMinutes = Math.floor(age / 60000);
            console.log(`${index + 1}. ${task.id} (${task.file_name}) - 等待${ageMinutes}分钟`);
        });

        // 4. 检查处理中的任务
        console.log("🔄 处理中的任务:");
        console.log("==================");
        
        const processingTasks = await d1.fetchAll(`
            SELECT id, file_name, status, claimed_by, updated_at 
            FROM tasks 
            WHERE status IN ('downloading', 'uploading') 
            ORDER BY updated_at DESC 
            LIMIT 5
        `);

        console.log(`处理中任务数量: ${processingTasks.length}`);
        processingTasks.forEach((task, index) => {
            const lastUpdate = Date.now() - task.updated_at;
            const lastUpdateMinutes = Math.floor(lastUpdate / 60000);
            console.log(`${index + 1}. ${task.id} (${task.file_name}) - 处理者: ${task.claimed_by}, ${lastUpdateMinutes}分钟前更新`);
        });

        // 5. 检查失败的任务
        console.log("❌ 失败的任务:");
        console.log("==================");
        
        const failedTasks = await d1.fetchAll(`
            SELECT id, file_name, status, error_msg, updated_at 
            FROM tasks 
            WHERE status = 'failed' 
            ORDER BY updated_at DESC 
            LIMIT 5
        `);

        console.log(`失败任务数量: ${failedTasks.length}`);
        failedTasks.forEach((task, index) => {
            const lastUpdate = Date.now() - task.updated_at;
            const lastUpdateMinutes = Math.floor(lastUpdate / 60000);
            console.log(`${index + 1}. ${task.id} (${task.file_name}) - ${lastUpdateMinutes}分钟前失败`);
            console.log(`   错误: ${task.error_msg}`);
        });

        // 6. 系统健康检查
        console.log("🏥 系统健康检查:");
        console.log("==================");
        
        // 检查缓存连接
        try {
            await cache.get("health_check", "text");
            console.log("✅ 缓存连接正常");
        } catch (err) {
            console.log("❌ 缓存连接失败:", err.message);
        }

        // 检查数据库连接
        try {
            await d1.fetchOne("SELECT 1");
            console.log("✅ 数据库连接正常");
        } catch (err) {
            console.log("❌ 数据库连接失败:", err.message);
        }

        // 7. 问题诊断
        console.log("🔍 问题诊断:");
        console.log("==================");
        
        if (waitingTasks.length > 0 && processingTasks.length === 0) {
            console.log("⚠️ 发现问题: 有排队任务但没有处理中的任务");
            console.log("💡 可能的原因:");
            console.log("   - TaskManager 未启动或崩溃");
            console.log("   - 处理器实例未获取到任务");
            console.log("   - 任务认领机制有问题");
        }

        if (processingTasks.length > 0) {
            const oldestProcessing = processingTasks[processingTasks.length - 1];
            const stuckTime = Date.now() - oldestProcessing.updated_at;
            if (stuckTime > 5 * 60 * 1000) { // 5分钟
                console.log("⚠️ 发现问题: 有任务卡在处理状态超过5分钟");
                console.log("💡 可能的原因:");
                console.log("   - 下载/上传过程卡住");
                console.log("   - 网络连接问题");
                console.log("   - Rclone 或其他外部服务问题");
            }
        }

        if (failedTasks.length > 0) {
            console.log("⚠️ 发现失败任务，请检查错误信息");
        }

    } catch (error) {
        console.error("❌ 检查过程中发生错误:", error);
    }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
    checkTaskStatus().catch(console.error);
}

export { checkTaskStatus };