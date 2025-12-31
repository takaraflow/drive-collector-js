#!/usr/bin/env node

/**
 * 完整 Cache 测试脚本 - 整合所有诊断
 * 测试 Redis 配置、TLS、性能、故障转移
 */

import 'dotenv/config';

// 设置测试环境
process.env.NODE_ENV = 'diagnostic';

async function runCompleteTest() {
    console.log('🚀 完整 Cache 测试开始...\n');

    // 1. Redis 配置测试
    console.log('1. 🔍 Redis 配置测试');
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    
    try {
        const { stdout } = await execAsync('node scripts/test-redis-config.js');
        console.log(stdout);
    } catch (e) {
        console.error('❌ Redis 配置测试失败:', e.message);
    }
    console.log('');

    // 2. Redis 连接诊断
    console.log('2. 🩺 Redis 连接诊断');
    try {
        const { stdout } = await execAsync('node scripts/redis-connection-diagnostic.js');
        console.log(stdout);
    } catch (e) {
        console.error('❌ Redis 连接诊断失败:', e.message);
    }
    console.log('');

    // 3. Cache 性能测试
    console.log('3. 📊 Cache 性能测试');
    try {
        const { stdout } = await execAsync('node scripts/cache-test.js -v -c 10');
        console.log(stdout);
    } catch (e) {
        console.error('❌ Cache 性能测试失败:', e.message);
    }
    console.log('');

    // 4. Upstash 验证 (可选)
    console.log('4. 🔍 Upstash 验证 (如果配置)');
    try {
        const { stdout } = await execAsync('node scripts/validate-upstash.js');
        console.log(stdout);
    } catch (e) {
        console.log('ℹ️ Upstash 未配置或脚本错误，跳过');
    }

    console.log('\n✅ 完整测试完成！');
}

runCompleteTest().catch(console.error);
