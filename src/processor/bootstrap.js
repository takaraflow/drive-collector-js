import { TaskManager } from "./TaskManager.js";
import { instanceCoordinator } from "../services/InstanceCoordinator.js";
import { logger } from "../services/logger/index.js";

const log = logger.withModule ? logger.withModule('ProcessorBootstrap') : logger;

/**
 * Processor 引导模块：负责 TaskManager 初始化、任务轮询、文件预热等逻辑
 */

/**
 * 启动 Processor 核心组件
 * @returns {Promise<void>}
 */
export async function startProcessor() {
    log.info("🔄 正在启动 Processor 核心组件...");

    // 1. 初始化后台任务系统（包括文件预热和僵尸任务恢复）
    await TaskManager.init();
    log.info("✅ 历史任务初始化扫描与文件预热完成");

    // 1.5 订阅跨实例广播(状态变更 / 缓存失效)。走 Redis pub/sub,不占 QStash 配额;
    //     订阅是接收变更通知的唯一入口,必须在这里显式拉起,否则本实例收不到其他实例的改动。
    const { stateSynchronizer } = await import("../services/StateSynchronizer.js");
    const { consistentCache } = await import("../services/ConsistentCache.js");
    await stateSynchronizer.init();
    await consistentCache.init();
    log.info("📡 已订阅实例间广播(state:changed / cache:invalidate)");

    // 2. 启动自动缩放监控（QStash事件驱动，无需轮询）
    TaskManager.startAutoScaling();
    // TaskManager.startPolling(); // 移除：QStash集成后此方法已不存在
    log.info("📊 已启动自动缩放监控（QStash事件驱动）");

    log.info("🎉 Processor 核心组件启动完成！");
}

/**
 * 停止 Processor 核心组件
 * @returns {Promise<void>}
 */
export async function stopProcessor() {
    log.info("📴 正在停止 Processor 核心组件...");

    try {
        // 停止实例协调器
        await instanceCoordinator.stop();

        // 停止自动缩放监控
        TaskManager.stopAutoScaling();

        log.info("✅ Processor 核心组件停止完成");
    } catch (e) {
        log.error("❌ 停止 Processor 核心组件失败:", e);
        throw e;
    }
}