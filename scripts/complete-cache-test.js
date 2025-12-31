#!/usr/bin/env node

/**
 * 完整缓存与性能诊断脚本
 * 一次性运行所有诊断，检查 Redis 连接、TLS 配置和消息响应性能
 */

import { config } from '../src/config/index.js';
import { createClient } from 'redis';
import { logger } from '../src/services/logger.js';

// 模拟环境变量用于测试
process.env.NODE_ENV = 'diagnostic';

async function testConfig() {
    console.log('\n=== 1. 配置诊断 ===');
    console.log('Redis URL:', config.redis.url || '未配置');
    console.log('Redis Host:', config.redis.host || '未配置');
    console.log('Redis Port:', config.redis.port);
    console.log('Redis TLS Enabled:', config.redis.tls.enabled);
    console.log('Redis TLS Reject Unauthorized:', config.redis.tls.rejectUnauthorized);
    
    if (config.redis.url && config.redis.url.includes('rediss://')) {
        console.log('⚠️  URL 使用 rediss:// 协议');
    }
    
    if (process.env.REDIS_TLS_ENABLED === 'false' || process.env.NF_REDIS_TLS_ENABLED === 'false') {
        console.log('✅  强制禁用 TLS 已设置');
    }
}

async function testConnection() {
    console.log('\n=== 2. 连接测试 ===');
    
    if (!config.redis.host && !config.redis.url) {
        console.log('❌ 未配置 Redis 连接信息');
        return;
    }
    
    const client = createClient({
        socket: {
            host: config.redis.host,
            port: config.redis.port,
            tls: config.redis.tls.enabled,
            rejectUnauthorized: config.redis.tls.rejectUnauthorized,
            ca: config.redis.tls.ca,
            cert: config.redis.tls.cert,
            key: config.redis.tls.key,
            servername: config.redis.tls.servername
        },
        password: config.redis.password,
        url: config.redis.url
    });
    
    try {
        console.log('正在连接...');
        const start = Date.now();
        await client.connect();
        const connectTime = Date.now() - start;
        console.log(`✅ 连接成功 (耗时: ${connectTime}ms)`);
        
        // 测试 Ping
        const pingStart = Date.now();
        const ping = await client.ping();
        const pingTime = Date.now() - pingStart;
        console.log(`✅ Ping: ${ping} (耗时: ${pingTime}ms)`);
        
        // 测试 Set/Get
        const testKey = 'diag:test:' + Date.now();
        const setStart = Date.now();
        await client.set(testKey, 'test_value', { EX: 10 });
        const setTime = Date.now() - setStart;
        
        const getStart = Date.now();
        const value = await client.get(testKey);
        const getTime = Date.now() - getStart;
        console.log(`✅ Set/Get 测试: ${setTime}ms / ${getTime}ms`);
        
        await client.del(testKey);
        await client.quit();
        
        return { connectTime, pingTime, setTime, getTime };
    } catch (error) {
        console.log(`❌ 连接失败: ${error.message}`);
        if (error.code === 'ECONNRESET') {
            console.log('   提示: ECONNRESET 通常表示 TLS 握手失败，请检查 REDIS_TLS_ENABLED 设置');
        }
        if (error.message.includes('AUTH')) {
            console.log('   提示: 认证失败，请检查密码');
        }
        await client.quit();
        throw error;
    }
}

async function testPerformance() {
    console.log('\n=== 3. 性能测试 ===');
    
    if (!config.redis.host && !config.redis.url) {
        console.log('❌ 跳过性能测试 (无 Redis)');
        return;
    }
    
    const client = createClient({
        socket: {
            host: config.redis.host,
            port: config.redis.port,
            tls: config.redis.tls.enabled,
            rejectUnauthorized: config.redis.tls.rejectUnauthorized
        },
        password: config.redis.password,
        url: config.redis.url
    });
    
    try {
        await client.connect();
        
        // 模拟消息锁竞争
        const lockKey = 'perf:test:lock';
        const start = Date.now();
        const lock = await client.set(lockKey, 'instance1', { NX: true, EX: 5 });
        const lockTime = Date.now() - start;
        console.log(`✅ 消息锁获取: ${lockTime}ms (结果: ${lock})`);
        
        // 模拟去重检查
        const msgKey = 'perf:test:msg:12345';
        const setStart = Date.now();
        await client.set(msgKey, Date.now(), { EX: 60 });
        const setMsgTime = Date.now() - setStart;
        
        const getStart = Date.now();
        await client.get(msgKey);
        const getMsgTime = Date.now() - getStart;
        console.log(`✅ 去重检查: Set ${setMsgTime}ms / Get ${getMsgTime}ms`);
        
        await client.del([lockKey, msgKey]);
        await client.quit();
        
        console.log('\n💡 预期性能指标:');
        console.log('   - 消息锁获取: < 10ms');
        console.log('   - 去重检查: < 5ms');
        console.log('   - 总消息处理: < 100ms');
    } catch (error) {
        console.log(`❌ 性能测试失败: ${error.message}`);
        await client.quit();
    }
}

async function testUpstash() {
    console.log('\n=== 4. Upstash 检查 ===');
    
    const hasUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
    
    if (!hasUpstash) {
        console.log('⚠️ 未配置 Upstash (可选)');
        return;
    }
    
    console.log('Upstash URL:', process.env.UPSTASH_REDIS_REST_URL);
    
    try {
        const start = Date.now();
        // 简单的 REST API 调用测试
        const response = await fetch(process.env.UPSTASH_REDIS_REST_URL + '/ping', {
            headers: {
                'Authorization': `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`
            }
        });
        const time = Date.now() - start;
        
        if (response.ok) {
            const data = await response.json();
            console.log(`✅ Upstash Ping: ${data.result} (耗时: ${time}ms)`);
        } else {
            console.log(`❌ Upstash 错误: ${response.status}`);
        }
    } catch (error) {
        console.log(`❌ Upstash 测试失败: ${error.message}`);
    }
}

async function main() {
    console.log('🚀 开始完整缓存与性能诊断');
    console.log('当前时间:', new Date().toISOString());
    
    try {
        await testConfig();
        await testConnection();
        await testPerformance();
        await testUpstash();
        
        console.log('\n✅ 诊断完成');
        console.log('\n💡 建议:');
        console.log('1. 如果使用 Northflank Redis 且连接失败，确保设置 REDIS_TLS_ENABLED=false');
        console.log('2. 如果使用 rediss:// URL 但需要 plain 连接，设置 REDIS_TLS_ENABLED=false');
        console.log('3. 消息响应慢通常是因为 Redis 连接失败，导致降级到 KV 存储');
        
    } catch (error) {
        console.log('\n❌ 诊断过程中发生错误:', error);
        process.exit(1);
    }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { testConfig, testConnection, testPerformance, testUpstash, main };