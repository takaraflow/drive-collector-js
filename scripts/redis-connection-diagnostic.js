#!/usr/bin/env node

// 立即加载环境变量
import dotenv from 'dotenv';
const result = dotenv.config();
console.log('[INIT] dotenv.config() result:', result.error ? `error: ${result.error.message}` : 'success');

// 调试环境变量
console.log('[INIT] API_ID:', process.env.API_ID ? `${process.env.API_ID.substring(0, 4)}...` : 'missing');
console.log('[INIT] NF_REDIS_URL:', process.env.NF_REDIS_URL ? 'exists' : 'missing');

/**
 * Redis 连接深度诊断脚本
 * 专门用于分析 Northflank 环境下的 Redis 连接问题
 */

import { config } from "../src/config/index.js";
import { cache } from "../src/services/CacheService.js";
import logger from "../src/services/logger.js";

async function runRedisDiagnostics() {
    console.log('[SCRIPT] runRedisDiagnostics 函数开始执行');
    console.log('[DEBUG] 脚本开始执行');
    console.log('🔍 开始 Redis 连接深度诊断...\n');

    // 1. 环境配置检查
    console.log('📋 环境配置检查:');
    console.log(`   NF_REDIS_URL: ${config.redis.url ? '已配置' : '未配置'}`);
    console.log(`   NF_REDIS_HOST: ${config.redis.host || '未配置'}`);
    console.log(`   NF_REDIS_PORT: ${config.redis.port || '未配置'}`);
    console.log(`   NF_REDIS_PASSWORD: ${config.redis.password ? '已配置' : '未配置'}`);
    console.log(`   当前提供商: ${cache.getCurrentProvider()}`);
    console.log(`   故障转移模式: ${cache.isFailoverMode ? '是' : '否'}`);
    console.log('');

    if (cache.currentProvider !== 'redis') {
        console.log('⚠️ 当前未使用 Redis，跳过 Redis 特定诊断\n');
        return;
    }

    // 等待 CacheService 初始化
    console.log('[DEBUG] 开始等待 CacheService 初始化 (2秒)');
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('[DEBUG] CacheService 初始化等待完成');

    // 2. 连接状态监控
    console.log('🔗 连接状态监控:');

    if (!cache.redisClient) {
        console.log('   ❌ Redis 客户端未初始化');
        console.log('   可能原因:');
        console.log('   - 环境变量未正确传递到容器');
        console.log('   - Redis 配置不完整');
        console.log('   - Node.js 环境检测失败');
        return;
    }

    const status = cache.redisClient.status;
    console.log(`   连接状态: ${status}`);

    if (status === 'ready') {
        console.log('   ✅ 连接就绪');
    } else if (status === 'connecting') {
        console.log('   🔄 正在连接...');
    } else if (status === 'reconnecting') {
        console.log('   🔄 正在重连...');
    } else {
        console.log(`   ⚠️ 状态异常: ${status}`);
    }

    // 3. 基础连接测试
    console.log('\n🏓 基础连接测试:');
    console.log('[DEBUG] 开始 PING 测试');
    try {
        const pingStart = Date.now();
        console.log('[DEBUG] 调用 cache.redisClient.ping()');
        const result = await cache.redisClient.ping();
        console.log('[DEBUG] PING 完成');
        const pingTime = Date.now() - pingStart;

        console.log(`   PING 响应: ${result}`);
        console.log(`   往返延迟: ${pingTime}ms`);

        if (pingTime > 500) {
            console.log('   ⚠️ 高延迟连接 (>500ms)');
        } else if (pingTime > 100) {
            console.log('   ⚠️ 中等延迟连接 (100-500ms)');
        } else {
            console.log('   ✅ 低延迟连接 (<100ms)');
        }
    } catch (error) {
        console.log(`   ❌ PING 失败: ${error.message}`);
        console.log('   可能原因:');
        console.log('   - 网络连接问题');
        console.log('   - 认证失败');
        console.log('   - Redis 服务不可用');
        return;
    }

    // 4. 网络延迟分析
    console.log('\n📊 网络延迟分析:');
    console.log('[DEBUG] 开始 10 次延迟测试');
    const latencies = [];
    let avgLatency = 0;
    let stdDev = 0;
    for (let i = 0; i < 10; i++) {
        console.log(`[DEBUG] 第 ${i + 1} 次 PING 测试开始`);
        try {
            const start = Date.now();
            await cache.redisClient.ping();
            latencies.push(Date.now() - start);
            console.log(`[DEBUG] 第 ${i + 1} 次 PING 测试完成: ${latencies[latencies.length - 1]}ms`);
            await new Promise(resolve => setTimeout(resolve, 200)); // 200ms 间隔
        } catch (error) {
            console.log(`[DEBUG] 第 ${i + 1} 次 PING 测试失败: ${error.message}`);
            console.log(`   第${i + 1}次测试失败: ${error.message}`);
        }
    }
    console.log('[DEBUG] 延迟测试循环完成');

    if (latencies.length > 0) {
        avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        const minLatency = Math.min(...latencies);
        const maxLatency = Math.max(...latencies);

        console.log(`   平均延迟: ${avgLatency.toFixed(1)}ms`);
        console.log(`   最小延迟: ${minLatency}ms`);
        console.log(`   最大延迟: ${maxLatency}ms`);
        console.log(`   成功率: ${(latencies.length / 10 * 100).toFixed(0)}%`);

        // Northflank 环境特定分析
        console.log('\n🏭 Northflank 环境分析:');
        if (avgLatency > 200) {
            console.log('   ⚠️ Northflank Redis 延迟较高');
            console.log('   可能原因:');
            console.log('   - 跨区域网络延迟');
            console.log('   - Redis 实例负载过高');
            console.log('   - 容器网络配置问题');
        } else {
            console.log('   ✅ Northflank Redis 延迟正常');
        }

        // 延迟稳定性分析
        const variance = latencies.reduce((acc, lat) => acc + Math.pow(lat - avgLatency, 2), 0) / latencies.length;
        stdDev = Math.sqrt(variance);

        console.log(`   延迟标准差: ${stdDev.toFixed(1)}ms`);
        if (stdDev > 50) {
            console.log('   ⚠️ 延迟不稳定，网络连接可能不稳定');
        } else {
            console.log('   ✅ 延迟稳定');
        }
    }

    // 5. 操作性能测试
    console.log('\n⚡ 操作性能测试:');
    console.log('[DEBUG] 开始操作性能测试');
    const operations = ['SET', 'GET', 'DEL'];
    const results = {};

    for (const op of operations) {
        console.log(`[DEBUG] 开始 ${op} 操作测试`);
        const testKey = `__diag_test_${op.toLowerCase()}_${Date.now()}__`;
        try {
            let start, duration;

            switch (op) {
                case 'SET':
                    start = Date.now();
                    await cache.redisClient.set(testKey, 'test_value');
                    duration = Date.now() - start;
                    break;
                case 'GET':
                    start = Date.now();
                    await cache.redisClient.get(testKey);
                    duration = Date.now() - start;
                    break;
                case 'DEL':
                    start = Date.now();
                    await cache.redisClient.del(testKey);
                    duration = Date.now() - start;
                    break;
            }

            results[op] = duration;
            console.log(`[DEBUG] ${op} 操作完成: ${duration}ms`);
            console.log(`   ${op} 操作: ${duration}ms`);

        } catch (error) {
            console.log(`[DEBUG] ${op} 操作失败: ${error.message}`);
            console.log(`   ${op} 操作失败: ${error.message}`);
            results[op] = 'FAILED';
        }
    }
    console.log('[DEBUG] 操作性能测试完成');

    // 6. 连接配置信息
    console.log('\n⚙️ 连接配置信息:');
    const options = cache.redisClient.options || {};
    console.log(`   主机: ${options.host || 'unknown'}`);
    console.log(`   端口: ${options.port || 'unknown'}`);
    console.log(`   连接超时: ${options.connectTimeout || 'unknown'}ms`);
    console.log(`   重试次数: ${options.maxRetriesPerRequest || 'unknown'}`);
    console.log(`   重连策略: ${typeof options.retryStrategy === 'function' ? '已配置' : '未配置'}`);

    // 7. 诊断总结
    console.log('\n📋 诊断总结:');
    const issues = [];

    if (avgLatency > 200) issues.push('高延迟连接');
    if (stdDev > 50) issues.push('延迟不稳定');
    if (Object.values(results).some(r => r === 'FAILED')) issues.push('操作失败');

    if (issues.length === 0) {
        console.log('   ✅ Redis 连接状态良好');
        console.log('   建议监控连接稳定性');
    } else {
        console.log('   ⚠️ 发现问题:');
        issues.forEach(issue => console.log(`      - ${issue}`));
        console.log('   建议:');
        console.log('   - 检查 Northflank Redis 实例状态');
        console.log('   - 验证网络配置和防火墙设置');
        console.log('   - 考虑使用连接池或优化连接参数');
    }

    console.log('\n🔍 诊断完成\n');

    // 显式退出进程，确保脚本正常结束
    process.exit(0);
}

// 只有当直接运行此脚本时才执行诊断
import { pathToFileURL } from 'url';
import path from 'path';

// 标准化路径比较，避免 Windows 路径格式问题
const scriptPath = path.resolve(process.argv[1]);
const scriptURL = pathToFileURL(scriptPath).href;

if (import.meta.url === scriptURL) {
    runRedisDiagnostics().catch(error => {
        console.error('❌ 诊断脚本执行失败:', error.message);
        process.exit(1);
    });
}

export { runRedisDiagnostics };