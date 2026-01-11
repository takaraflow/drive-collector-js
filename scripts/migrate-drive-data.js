#!/usr/bin/env node

/**
 * 网盘数据迁移脚本
 * 从 Cache 迁移所有 drive 配置到 D1 数据库
 * 使用 InstanceCoordinator 确保单实例执行
 */

import { cache } from "../src/services/CacheService.js";
import { d1 } from "../src/services/d1.js";
import { InstanceCoordinator } from "../src/services/InstanceCoordinator.js";
import { logger } from "../src/services/logger/index.js";

async function migrateDriveData() {
    const lockKey = 'drive-migration-lock';
    const lockTTL = 300000; // 5分钟锁

    try {
        logger.info("🔄 开始网盘数据迁移...");

        // 获取锁，确保单实例执行
        const hasLock = await InstanceCoordinator.acquireLock(lockKey, lockTTL);
        if (!hasLock) {
            logger.warn("⚠️ 其他实例正在执行迁移，退出");
            return;
        }

        logger.info("🔍 扫描 Cache 中的 drive 数据...");

        // 获取所有 drive 相关的 keys
        const driveKeys = await cache.listKeys('drive:');
        const driveIdKeys = await cache.listKeys('drive_id:');

        logger.info(`📊 发现 ${driveKeys.length} 个用户 drive keys，${driveIdKeys.length} 个 drive_id keys`);

        let migratedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        // 处理用户 drive keys
        for (const key of driveKeys) {
            try {
                const driveData = await cache.get(key, "json");
                if (!driveData || !driveData.id) {
                    logger.warn(`⚠️ 跳过无效的 drive 数据: ${key}`);
                    skippedCount++;
                    continue;
                }

                // 检查 D1 中是否已存在
                const existing = await d1.fetchOne(
                    "SELECT id FROM drives WHERE id = ?",
                    [driveData.id]
                );

                if (existing) {
                    logger.debug(`⏭️ 跳过已存在的 drive: ${driveData.id}`);
                    skippedCount++;
                    continue;
                }

                // 插入到 D1
                await d1.run(
                    `INSERT INTO drives (id, user_id, name, type, config_data, status, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        driveData.id,
                        driveData.user_id,
                        driveData.name || driveData.type, // 兼容旧数据格式
                        driveData.type,
                        JSON.stringify(driveData.config_data),
                        driveData.status || 'active',
                        driveData.created_at || Date.now(),
                        Date.now()
                    ]
                );

                migratedCount++;
                logger.debug(`✅ 迁移 drive: ${driveData.id} (${driveData.user_id})`);

            } catch (error) {
                logger.error(`❌ 迁移失败 ${key}:`, error);
                errorCount++;
            }
        }

        // 确保 drives 表存在（如果不存在）
        try {
            await d1.run(`
                CREATE TABLE IF NOT EXISTS drives (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    name TEXT,
                    type TEXT NOT NULL,
                    config_data TEXT NOT NULL,
                    status TEXT DEFAULT 'active',
                    created_at INTEGER,
                    updated_at INTEGER,
                    UNIQUE(user_id, type)
                )
            `);
            logger.info("📋 确保 drives 表存在");
        } catch (error) {
            logger.warn("⚠️ 创建 drives 表失败，可能已存在:", error.message);
        }

        logger.info(`📈 迁移完成: ${migratedCount} 成功, ${skippedCount} 跳过, ${errorCount} 失败`);

        // 释放锁
        await InstanceCoordinator.releaseLock(lockKey);

        logger.info("🎉 网盘数据迁移完成");

    } catch (error) {
        logger.error("💥 迁移过程中发生严重错误:", error);
        // 尝试释放锁
        try {
            await InstanceCoordinator.releaseLock(lockKey);
        } catch (lockError) {
            logger.error("❌ 释放锁失败:", lockError);
        }
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
    migrateDriveData().catch(error => {
        console.error("迁移失败:", error);
        process.exit(1);
    });
}

export { migrateDriveData };