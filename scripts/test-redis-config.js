#!/usr/bin/env node

/**
 * Redis 配置测试脚本
 * 验证环境变量是否正确加载，TLS/SNI 配置是否正确读取
 */

// 设置测试环境变量，必须在导入任何模块之前
process.env.NODE_ENV = 'test';
process.env.API_ID = '12345';
process.env.API_HASH = 'test_hash';
process.env.BOT_TOKEN = 'test_token';

// 设置 Redis 测试配置
process.env.REDIS_URL = 'rediss://user:password@master.drive-collector-redis--qmnl9h54d875.addon.code.run:6379';
process.env.REDIS_SNI_SERVERNAME = 'master.drive-collector-redis--qmnl9h54d875.addon.code.run';

// 现在导入配置
import { config } from '../src/config/index.js';

console.log('🔍 Redis 配置测试');
console.log('==================\n');

// 测试配置对象
console.log('1. 配置对象中的 Redis 设置:');
console.log('   redis.url:', config.redis.url || '未配置');
console.log('   redis.host:', config.redis.host || '未配置');
console.log('   redis.port:', config.redis.port || '未配置');
console.log('   redis.password:', config.redis.password ? '***' : '未配置');

// 测试环境变量读取
console.log('\n2. 环境变量读取:');
console.log('   REDIS_URL:', process.env.REDIS_URL || '未设置');
console.log('   REDIS_HOST:', process.env.REDIS_HOST || '未设置');
console.log('   REDIS_PORT:', process.env.REDIS_PORT || '未设置');
console.log('   REDIS_PASSWORD:', process.env.REDIS_PASSWORD ? '***' : '未设置');
console.log('   REDIS_SNI_SERVERNAME:', process.env.REDIS_SNI_SERVERNAME || '未设置');

// 测试 URL 解析
if (config.redis.url) {
    try {
        const url = new URL(config.redis.url);
        console.log('\n3. URL 解析结果:');
        console.log('   Protocol:', url.protocol);
        console.log('   Username:', url.username || '无');
        console.log('   Password:', url.password ? '***' : '无');
        console.log('   Hostname:', url.hostname);
        console.log('   Port:', url.port || '默认');
        
        // 验证 TLS
        if (url.protocol === 'rediss:') {
            console.log('   ✅ TLS 连接 (rediss://)');
        } else if (url.protocol === 'redis:') {
            console.log('   ⚠️  非 TLS 连接 (redis://)');
        }
    } catch (e) {
        console.log('\n3. URL 解析错误:', e.message);
    }
}

// 测试 SNI 配置逻辑
console.log('\n4. SNI 配置逻辑测试:');
const testSni = process.env.REDIS_SNI_SERVERNAME || process.env.REDIS_HOST || (config.redis.url ? new URL(config.redis.url).hostname : undefined);
console.log('   预期 SNI 主机名:', testSni || '无法确定');

// 验证配置完整性
console.log('\n5. 配置完整性检查:');
const hasRedisConfig = !!(config.redis.url || (config.redis.host && config.redis.port));
console.log('   Redis 配置完整:', hasRedisConfig ? '✅' : '❌');

if (!hasRedisConfig) {
    console.log('\n⚠️  警告: Redis 配置不完整，CacheService 将无法使用 Redis');
    console.log('   请确保设置 REDIS_URL 或 REDIS_HOST + REDIS_PORT');
}

// 测试 CacheService 的 TLS 配置逻辑
console.log('\n6. CacheService TLS 配置测试:');
const redisUrl = config.redis.url;
const redisHost = config.redis.host;
const redisSni = process.env.REDIS_SNI_SERVERNAME || redisHost || (redisUrl ? new URL(redisUrl).hostname : undefined);
console.log('   TLS servername 将使用:', redisSni || '未定义');

console.log('\n✅ 配置测试完成');