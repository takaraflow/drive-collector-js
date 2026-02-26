import { client, getUpdateHealth } from "../services/telegram.js";
import { d1 } from "../services/d1.js";
import { cache } from "../services/CacheService.js";
import { config } from "../config/index.js";
import { tunnelService } from "../services/TunnelService.js";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as dns from "dns";

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

        // 检查 Telegram 更新循环健康
        results.services.telegramUpdateHealth = await this._checkUpdateLoopHealth();

        // 检查 Cloudflare D1
        results.services.d1 = await this._checkD1();

        // 检查 Cache 存储 (Redis/KV)
        results.services.kv = await this._checkCache();

        // 专门检查 Redis 连接 (如果使用 Redis)
        if (cache.currentProvider === 'redis' && cache.redisClient) {
            results.services.redis = await this._checkRedisConnection();
        }

        // 检查 rclone
        results.services.rclone = await this._checkRclone();

        // 检查 Tunnel (Cloudflare Tunnel)
        results.services.tunnel = await this._checkTunnel();

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
            const botApiPrefix = `https://api.telegram.org/bot${config.botToken}${config.telegram.testMode ? "/test" : ""}`;
            const response = await fetch(`${botApiPrefix}/getMe`, {
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
     * 检查 Telegram 更新循环健康状态
     */
    static async _checkUpdateLoopHealth() {
        const startTime = Date.now();
        try {
            const health = getUpdateHealth();
            const timeSince = health.timeSince;
            
            // 如果超过 90 秒没有更新，认为更新循环可能卡住
            if (timeSince > 90000) {
                return {
                    status: 'warning',
                    responseTime: `${Date.now() - startTime}ms`,
                    message: `更新循环可能卡住 (最后更新: ${Math.floor(timeSince / 1000)}s 前)`,
                    details: {
                        lastUpdate: new Date(health.lastUpdate).toISOString(),
                        timeSinceSeconds: Math.floor(timeSince / 1000)
                    }
                };
            }
            
            return {
                status: 'ok',
                responseTime: `${Date.now() - startTime}ms`,
                message: `更新循环正常 (最后更新: ${Math.floor(timeSince / 1000)}s 前)`,
                details: {
                    lastUpdate: new Date(health.lastUpdate).toISOString(),
                    timeSinceSeconds: Math.floor(timeSince / 1000)
                }
            };
        } catch (error) {
            return {
                status: 'error',
                responseTime: `${Date.now() - startTime}ms`,
                message: `无法检查更新循环健康: ${error.message}`
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
     * 检查 Cache 存储连通性 (Cloudflare KV 或 Upstash)
     */
    static async _checkCache() {
        const startTime = Date.now();
        try {
            // 使用 cache.getCurrentProvider() 获取当前提供商
            const cacheProvider = cache.getCurrentProvider();

            // 尝试读取一个不存在的key，应该返回null但不报错
            const testKey = `__diagnostic_test_${Date.now()}__`;
            await cache.get(testKey);
            const responseTime = Date.now() - startTime;
            return {
                status: 'ok',
                responseTime: `${responseTime}ms`,
                message: `${cacheProvider} 连接正常`
            };
        } catch (error) {
            const cacheProvider = cache.getCurrentProvider();
            return {
                status: 'error',
                responseTime: `${Date.now() - startTime}ms`,
                message: `${cacheProvider} 连接失败: ${error.message}`
            };
        }
    }

    /**
     * 检查 Northflank 环境特定的连接问题
     */
    static async _checkNorthflankRedisIssues() {
        const issues = {
            connectionStability: null,
            networkLatency: null,
            sslHandshake: null,
            environmentConfig: null
        };

        // 检查环境变量
        const northflankVars = ['NF_SERVICE_ID', 'NF_PROJECT_ID', 'NF_REGION', 'NF_DEPLOYMENT_ID'];
        const presentVars = northflankVars.filter(varName => process.env[varName]);

        issues.environmentConfig = {
            isNorthflank: presentVars.length > 0,
            presentVars,
            missingVars: northflankVars.filter(varName => !process.env[varName])
        };

        // 检查SSL配置（Northflank Redis使用SSL）
        const redisUrl = process.env.NF_REDIS_URL || process.env.REDIS_URL;
        issues.sslHandshake = {
            usesSSL: redisUrl?.startsWith('rediss://'),
            urlConfigured: !!redisUrl
        };

        return issues;
    }

    /**
     * 专门检查 Redis 连接质量和延迟
     */
    static async _checkRedisConnection() {
        const startTime = Date.now();
        const diagnostics = {
            connectionTime: 0,
            pingLatency: [],
            operationsLatency: {},
            dnsResolutionTime: null,
            portReachability: null,
            northflankEnv: {}
        };

        try {
            if (!cache.redisClient) {
                return {
                    status: 'error',
                    responseTime: '0ms',
                    message: 'Redis 客户端未初始化',
                    details: {
                        northflankCheck: await this._checkNorthflankRedisIssues(),
                        recommendation: '检查Redis连接配置和网络连接'
                    }
                };
            }

            // Northflank 环境变量检测
            const northflankVars = ['NF_SERVICE_ID', 'NF_PROJECT_ID', 'NF_REGION', 'NF_IMAGE', 'NF_DEPLOYMENT_ID'];
            northflankVars.forEach(varName => {
                if (process.env[varName]) {
                    diagnostics.northflankEnv[varName] = process.env[varName];
                }
            });

            const connectionInfo = cache.redisClient.options || {};
            const host = connectionInfo.host;
            const port = connectionInfo.port || 6379;

            // DNS 解析耗时检测
            if (host && !net.isIP(host)) {
                try {
                    const dnsStart = Date.now();
                    await new Promise((resolve, reject) => {
                        dns.lookup(host, { family: 4 }, (err, address, family) => {
                            if (err) reject(err);
                            else resolve({ address, family });
                        });
                    });
                    diagnostics.dnsResolutionTime = Date.now() - dnsStart;
                } catch (dnsError) {
                    diagnostics.dnsResolutionTime = `failed: ${dnsError.code || dnsError.message}`;
                }
            }

            // Redis 节点可达性测试 (TCP 连接测试)
            try {
                const portTestStart = Date.now();
                await new Promise((resolve, reject) => {
                    const socket = net.createConnection({ host, port, timeout: 5000 });
                    socket.on('connect', () => {
                        socket.end();
                        resolve();
                    });
                    socket.on('error', reject);
                    socket.on('timeout', () => {
                        socket.destroy();
                        reject(new Error('Connection timeout'));
                    });
                });
                diagnostics.portReachability = Date.now() - portTestStart;
            } catch (portError) {
                diagnostics.portReachability = `unreachable: ${portError.message}`;
            }

            // 1. 测试基础连接延迟
            const pingStart = Date.now();
            await cache.redisClient.ping();
            diagnostics.connectionTime = Date.now() - pingStart;

            // 2. 多次 ping 测试以获得平均延迟
            for (let i = 0; i < 3; i++) {
                const pingTime = Date.now();
                await cache.redisClient.ping();
                diagnostics.pingLatency.push(Date.now() - pingTime);
                await new Promise(resolve => setTimeout(resolve, 100)); // 小延迟避免拥塞
            }

            // 3. 测试基本操作延迟
            const testKey = `__redis_diag_${Date.now()}__`;

            // SET 操作
            const setStart = Date.now();
            await cache.redisClient.set(testKey, 'diagnostic_test');
            diagnostics.operationsLatency.set = Date.now() - setStart;

            // GET 操作
            const getStart = Date.now();
            await cache.redisClient.get(testKey);
            diagnostics.operationsLatency.get = Date.now() - getStart;

            // DEL 操作
            const delStart = Date.now();
            await cache.redisClient.del(testKey);
            diagnostics.operationsLatency.del = Date.now() - delStart;

            const totalTime = Date.now() - startTime;
            const avgPing = diagnostics.pingLatency.reduce((a, b) => a + b, 0) / diagnostics.pingLatency.length;

            // 分析结果
            let status = 'ok';
            let performance = 'good';
            let warnings = [];

            if (avgPing > 100) performance = 'fair';
            if (avgPing > 500) {
                performance = 'poor';
                warnings.push('高延迟连接');
            }

            if (diagnostics.operationsLatency.set > 50 || diagnostics.operationsLatency.get > 50) {
                warnings.push('操作延迟较高');
            }

            const message = `Northflank Redis 连接正常 (延迟: ${avgPing.toFixed(1)}ms, 性能: ${performance})` +
                           (warnings.length > 0 ? ` - 警告: ${warnings.join(', ')}` : '');

            return {
                status,
                responseTime: `${totalTime}ms`,
                message,
                details: {
                    host: connectionInfo.host || 'unknown',
                    port: connectionInfo.port || 'unknown',
                    avgPingMs: avgPing.toFixed(1),
                    performance,
                    operations: diagnostics.operationsLatency,
                    connectionTimeMs: diagnostics.connectionTime,
                    warnings: warnings.length > 0 ? warnings : null,
                    dnsResolutionTime: diagnostics.dnsResolutionTime,
                    portReachability: diagnostics.portReachability,
                    northflankEnv: Object.keys(diagnostics.northflankEnv).length > 0 ? diagnostics.northflankEnv : null
                }
            };

        } catch (error) {
            const totalTime = Date.now() - startTime;
            return {
                status: 'error',
                responseTime: `${totalTime}ms`,
                message: `Northflank Redis 连接失败: ${error.message}`,
                details: {
                    error: error.message,
                    code: error.code,
                    errno: error.errno
                }
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
     * 检查 Tunnel (Cloudflare Tunnel) 状态
     */
    static async _checkTunnel() {
        const startTime = Date.now();
        try {
            const tunnelConfig = config?.tunnel;
            
            if (!tunnelConfig || !tunnelConfig.enabled) {
                return {
                    status: 'warning',
                    responseTime: `${Date.now() - startTime}ms`,
                    message: 'Tunnel 功能未启用'
                };
            }

            const status = tunnelService.getStatus();
            
            if (!status.enabled) {
                return {
                    status: 'warning',
                    responseTime: `${Date.now() - startTime}ms`,
                    message: 'Tunnel 未初始化'
                };
            }

            // 获取 tunnel URL
            const tunnelUrl = await tunnelService.getPublicUrl();
            const responseTime = Date.now() - startTime;

            if (tunnelUrl) {
                return {
                    status: 'ok',
                    responseTime: `${responseTime}ms`,
                    message: `Tunnel 正常 (${tunnelUrl})`,
                    details: {
                        url: tunnelUrl,
                        provider: tunnelConfig.provider || 'cloudflare',
                        serviceUp: status.serviceUp,
                        lastUpdate: status.lastUpdate
                    }
                };
            } else {
                return {
                    status: 'warning',
                    responseTime: `${responseTime}ms`,
                    message: 'Tunnel 服务运行中但未获取到公网 URL',
                    details: {
                        provider: tunnelConfig.provider || 'cloudflare',
                        serviceUp: status.serviceUp,
                        lastUpdate: status.lastUpdate
                    }
                };
            }
        } catch (error) {
            return {
                status: 'error',
                responseTime: `${Date.now() - startTime}ms`,
                message: `Tunnel 检查失败: ${error.message}`
            };
        }
    }

}
