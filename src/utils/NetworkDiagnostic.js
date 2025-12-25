import { client } from "../services/telegram.js";
import { d1 } from "../services/d1.js";
import { kv } from "../services/kv.js";
import { CloudTool } from "../services/rclone.js";
import { DriveRepository } from "../repositories/DriveRepository.js";
import { config } from "../config/index.js";
import { spawnSync } from "child_process";
import * as fs from "fs";

/**
 * 网络诊断工具
 * 检查所有外部API接口的连通性
 */
export class NetworkDiagnostic {
    static async diagnoseAll() {
        const results = {
            timestamp: new Date().toISOString(),
            services: {}
        };

        // 检查 Telegram MTProto API
        results.services.telegram = await this._checkTelegram();

        // 检查 Telegram Bot API
        results.services.telegramBot = await this._checkTelegramBot();

        // 检查 Cloudflare D1
        results.services.d1 = await this._checkD1();

        // 检查 Cloudflare KV
        results.services.kv = await this._checkKV();

        // 检查 rclone
        results.services.rclone = await this._checkRclone();

        // 检查云存储服务连接
        results.services.cloudStorage = await this._checkCloudStorage();

        return results;
    }

    /**
     * 检查 Telegram MTProto API 连通性
     */
    static async _checkTelegram() {
        const startTime = Date.now();
        try {
            await client.getMe();
            const responseTime = Date.now() - startTime;
            return {
                status: 'ok',
                responseTime: `${responseTime}ms`,
                message: 'Telegram MTProto API 连接正常'
            };
        } catch (error) {
            return {
                status: 'error',
                responseTime: `${Date.now() - startTime}ms`,
                message: `Telegram MTProto API 连接失败: ${error.message}`
            };
        }
    }

    /**
     * 检查 Telegram Bot API 连通性
     */
    static async _checkTelegramBot() {
        const startTime = Date.now();
        try {
            if (!config.botToken) {
                return {
                    status: 'warning',
                    responseTime: `${Date.now() - startTime}ms`,
                    message: '未配置 Bot Token，跳过 Bot API 测试'
                };
            }

            // 使用 Bot API 的 getMe 方法验证token
            const response = await fetch(`https://api.telegram.org/bot${config.botToken}/getMe`, {
                method: 'GET',
                timeout: 10000
            });

            const result = await response.json();

            if (result.ok) {
                const responseTime = Date.now() - startTime;
                return {
                    status: 'ok',
                    responseTime: `${responseTime}ms`,
                    message: `Telegram Bot API 连接正常 (@${result.result.username})`
                };
            } else {
                return {
                    status: 'error',
                    responseTime: `${Date.now() - startTime}ms`,
                    message: `Telegram Bot API 验证失败: ${result.description}`
                };
            }
        } catch (error) {
            return {
                status: 'error',
                responseTime: `${Date.now() - startTime}ms`,
                message: `Telegram Bot API 连接失败: ${error.message}`
            };
        }
    }

    /**
     * 检查 Cloudflare D1 连通性
     */
    static async _checkD1() {
        const startTime = Date.now();
        try {
            // 尝试一个简单的查询，比如检查表是否存在
            await d1.fetchAll("SELECT 1 as test");
            const responseTime = Date.now() - startTime;
            return {
                status: 'ok',
                responseTime: `${responseTime}ms`,
                message: 'Cloudflare D1 连接正常'
            };
        } catch (error) {
            return {
                status: 'error',
                responseTime: `${Date.now() - startTime}ms`,
                message: `Cloudflare D1 连接失败: ${error.message}`
            };
        }
    }

    /**
     * 检查 KV 存储连通性 (Cloudflare KV 或 Upstash)
     */
    static async _checkKV() {
        const startTime = Date.now();
        try {
            // 检测当前使用的KV提供商
            const kvProvider = process.env.KV_PROVIDER === 'upstash' ? 'Upstash Redis' : 'Cloudflare KV';

            // 尝试读取一个不存在的key，应该返回null但不报错
            const testKey = `__diagnostic_test_${Date.now()}__`;
            await kv.get(testKey);
            const responseTime = Date.now() - startTime;
            return {
                status: 'ok',
                responseTime: `${responseTime}ms`,
                message: `${kvProvider} 连接正常`
            };
        } catch (error) {
            const kvProvider = process.env.KV_PROVIDER === 'upstash' ? 'Upstash Redis' : 'Cloudflare KV';
            return {
                status: 'error',
                responseTime: `${Date.now() - startTime}ms`,
                message: `${kvProvider} 连接失败: ${error.message}`
            };
        }
    }

    /**
     * 检查 rclone 可执行性
     */
    static _checkRclone() {
        const startTime = Date.now();
        try {
            const rcloneBinary = fs.existsSync("/app/rclone/rclone")
                ? "/app/rclone/rclone"
                : "rclone";

            // 先检查 rclone 是否可用
            const versionResult = spawnSync(rcloneBinary, ["version"], {
                encoding: 'utf-8',
                timeout: 10000
            });

            const responseTime = Date.now() - startTime;

            if (versionResult.status === 0) {
                // 解析版本信息，从输出中提取版本号
                const output = versionResult.stdout;
                const versionMatch = output.match(/rclone\s+v?([\d.]+)/i);
                const version = versionMatch ? versionMatch[1] : 'unknown';

                return {
                    status: 'ok',
                    responseTime: `${responseTime}ms`,
                    message: `rclone 正常 (版本: ${version})`
                };
            } else {
                return {
                    status: 'error',
                    responseTime: `${responseTime}ms`,
                    message: `rclone 错误: ${versionResult.stderr || versionResult.error}`
                };
            }
        } catch (error) {
            return {
                status: 'error',
                responseTime: `${Date.now() - startTime}ms`,
                message: `rclone 检查失败: ${error.message}`
            };
        }
    }

    /**
     * 检查云存储服务连接
     */
    static async _checkCloudStorage() {
        const startTime = Date.now();
        try {
            // 尝试获取第一个用户的云存储配置进行测试
            const drives = await DriveRepository.findAll();
            if (!drives || drives.length === 0) {
                return {
                    status: 'warning',
                    responseTime: `${Date.now() - startTime}ms`,
                    message: '未找到用户云存储配置，跳过连接测试'
                };
            }

            // 选择第一个配置进行测试
            const testDrive = drives[0];
            const configData = JSON.parse(testDrive.config_data);

            // 使用 CloudTool 的验证方法
            const validation = await CloudTool.validateConfig(testDrive.type, configData);

            if (validation.success) {
                const responseTime = Date.now() - startTime;
                return {
                    status: 'ok',
                    responseTime: `${responseTime}ms`,
                    message: `${testDrive.type.toUpperCase()} 云存储连接正常`
                };
            } else {
                let reason = validation.reason || '未知错误';
                if (validation.details) {
                    reason += `: ${validation.details}`;
                }
                return {
                    status: 'error',
                    responseTime: `${Date.now() - startTime}ms`,
                    message: `${testDrive.type.toUpperCase()} 云存储连接失败: ${reason}`
                };
            }
        } catch (error) {
            return {
                status: 'error',
                responseTime: `${Date.now() - startTime}ms`,
                message: `云存储检查失败: ${error.message}`
            };
        }
    }

    /**
     * 格式化诊断结果为可读文本
     */
    static formatResults(results) {
        let text = `🔍 <b>网络诊断报告</b>\n`;
        text += `⏰ ${results.timestamp}\n\n`;

        const statusEmojis = {
            ok: '✅',
            error: '❌',
            warning: '⚠️'
        };

        for (const [service, result] of Object.entries(results.services)) {
            const emoji = statusEmojis[result.status] || '❓';
            text += `${emoji} <b>${service.toUpperCase()}</b>: ${result.message}\n`;
            text += `   响应时间: ${result.responseTime}\n\n`;
        }

        const errorCount = Object.values(results.services).filter(r => r.status === 'error').length;
        if (errorCount > 0) {
            text += `⚠️ 发现 ${errorCount} 个服务异常，请检查网络连接或配置。`;
        } else {
            text += `✅ 所有服务运行正常。`;
        }

        return text;
    }
}