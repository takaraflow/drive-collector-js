#!/usr/bin/env node

/**
 * --- Bot 入口点 (指挥部) ---
 * 职责：通过 Telegram Bot API 处理用户交互，无需 MTProto 连接
 * 部署：可部署在 Cloudflare Workers 或任意免费托管平台
 */

import { config } from "./src/config/index.js";
import { client } from "./src/services/telegram.js";
import { Dispatcher } from "./src/bot/Dispatcher.js";
import { TaskManager } from "./src/core/TaskManager.js";
import { instanceCoordinator } from "./src/services/InstanceCoordinator.js";
import { kv } from "./src/services/kv.js";
import { DatabaseService } from "./src/services/database.js";

// 启动 Bot
export async function startBot() {
  try {
    console.log("🤖 启动 Bot 指挥部...");

    // 1. 初始化多实例协调器
    await instanceCoordinator.start();

    // 2. 初始化数据库服务
    DatabaseService.startFlushing();

    // 3. 启动任务管理器（仅启动轮询，Worker 实例会处理任务）
    TaskManager.startPolling();

    // 4. 设置事件处理器
    client.addEventHandler(Dispatcher.handle.bind(Dispatcher));

    // 5. 连接到 Telegram
    await client.start({
      botAuthToken: process.env.TELEGRAM_BOT_TOKEN,
    });

    console.log("✅ Bot 指挥部启动完成");
    console.log(`📍 实例 ID: ${instanceCoordinator.getInstanceId()}`);
    console.log(`👑 是否领导者: ${instanceCoordinator.isLeader()}`);

    // 优雅关闭
    process.on('SIGINT', async () => {
      console.log("🛑 正在关闭 Bot...");
      await client.disconnect();
      await instanceCoordinator.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log("🛑 收到终止信号，正在关闭 Bot...");
      await client.disconnect();
      await instanceCoordinator.stop();
      process.exit(0);
    });

  } catch (error) {
    console.error("❌ Bot 启动失败:", error);
    process.exit(1);
  }
}

// 启动应用（仅在直接运行时执行）
if (import.meta.url === `file://${process.argv[1]}`) {
  startBot();
}