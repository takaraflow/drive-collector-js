#!/usr/bin/env node

/**
 * 模拟 ECONNREFUSED 错误场景
 * 演示用户描述的问题：连接到 127.0.0.1:6379 失败，但手动连接远程 URL 成功
 */

console.log('🔴 模拟 ECONNREFUSED 错误场景\n');

// 模拟用户遇到的错误场景
console.log('用户报告的错误信息:');
console.log('   Error: connect ECONNREFUSED 127.0.0.1:6379');
console.log('');

console.log('用户手动连接命令 (成功):');
console.log('   redis-cli -h remote-host.example.com -p 6379 -a password');
console.log('');

// 模拟 CacheService 在错误配置下的行为
console.log('🔄 CacheService 在错误配置下的行为:\n');

// 假设环境变量配置错误
const wrongEnv = {
    REDIS_HOST: '127.0.0.1',  // 错误：使用 localhost
    REDIS_PORT: '6379',
    REDIS_PASSWORD: '',        // 错误：缺少密码
    // REDIS_URL: 未设置
};

console.log('错误的环境变量配置:');
Object.entries(wrongEnv).forEach(([key, value]) => {
    console.log(`   ${key}=${value || '(空)'}`);
});

console.log('\n🔧 CacheService 配置解析过程:\n');

// 模拟 CacheService 的配置逻辑
const config = { redis: {} }; // 假设 config.redis 为空
const redisConfig = config.redis || {};

// 第一步：标准环境变量
const redisUrl = process.env.REDIS_URL || redisConfig.url || wrongEnv.REDIS_HOST;
const redisHost = process.env.REDIS_HOST || redisConfig.host || wrongEnv.REDIS_HOST;
const redisPort = parseInt(process.env.REDIS_PORT || redisConfig.port || wrongEnv.REDIS_PORT, 10);
const redisPassword = process.env.REDIS_PASSWORD || redisConfig.password || wrongEnv.REDIS_PASSWORD;

console.log('1️⃣ 标准环境变量解析:');
console.log(`   REDIS_URL: ${redisUrl || '未配置'}`);
console.log(`   REDIS_HOST: ${redisHost}`);
console.log(`   REDIS_PORT: ${redisPort}`);
console.log(`   REDIS_PASSWORD: ${redisPassword ? '已配置' : '未配置'}`);

// 第二步：Northflank 变量（如果标准变量未配置）
let finalRedisUrl = redisUrl;
let finalRedisHost = redisHost;
let finalRedisPort = redisPort;
let finalRedisPassword = redisPassword;

if (!redisUrl && !redisHost) {
    console.log('\n2️⃣ Northflank 环境变量:');
    finalRedisUrl = process.env.NF_REDIS_URL;
    finalRedisHost = process.env.NF_REDIS_HOST;
    finalRedisPort = parseInt(process.env.NF_REDIS_PORT || '6379', 10);
    finalRedisPassword = process.env.NF_REDIS_PASSWORD || '';
} else {
    console.log('\n2️⃣ 跳过 Northflank 变量 (标准变量已配置)');
}

console.log(`\n   最终配置: ${finalRedisHost}:${finalRedisPort} (密码: ${finalRedisPassword ? '有' : '无'})`);

// 模拟 ioredis 配置构建
console.log('\n🔧 ioredis 配置构建:\n');

const ioredisConfig = {
    connectTimeout: 15000,
    keepAlive: 30000,
    family: 4,
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 5,
    enableAutoPipelining: true,
    retryStrategy: (times) => {
        const maxRetries = 5;
        if (times > maxRetries) {
            return null; // 停止重连
        }
        return Math.min(times * 500, 30000);
    },
    reconnectOnError: (err) => {
        const msg = err.message.toLowerCase();
        return msg.includes('econnreset') || msg.includes('timeout') || msg.includes('network') || !msg.includes('auth');
    },
    tls: {
        rejectUnauthorized: false,
        servername: process.env.REDIS_SNI_SERVERNAME || finalRedisHost || undefined,
    }
};

// 优先使用 URL
if (finalRedisUrl && finalRedisUrl.startsWith('redis')) {
    ioredisConfig.url = finalRedisUrl;
} else {
    ioredisConfig.host = finalRedisHost;
    ioredisConfig.port = finalRedisPort;
    if (finalRedisPassword) {
        ioredisConfig.password = finalRedisPassword;
    }
}

console.log('ioredis 配置对象:');
console.log(JSON.stringify(ioredisConfig, (key, value) => {
    if (key === 'password' && value) return '***';
    if (typeof value === 'function') return `[Function]`;
    return value;
}, 2));

// 模拟连接尝试
console.log('\n📡 模拟 Redis 连接尝试:\n');

console.log('场景 1: 使用 127.0.0.1:6379 (当前配置)');
console.log('   ioredis 尝试连接: 127.0.0.1:6379');
console.log('   结果: ❌ ECONNREFUSED');
console.log('   原因: 在远程容器中，127.0.0.1 指向容器自身，没有 Redis 服务');
console.log('');

console.log('场景 2: 使用远程 URL (正确配置)');
console.log('   ioredis 尝试连接: rediss://user:password@remote-host.example.com:6379');
console.log('   结果: ✅ 连接成功');
console.log('   原因: 连接到真正的远程 Redis 服务');
console.log('');

// 问题分析
console.log('🔍 问题根本原因分析:\n');

const rootCauses = [
    {
        problem: '使用 localhost/127.0.0.1',
        explanation: '在容器化环境中，localhost 指向容器自身，无法访问外部服务',
        impact: 'ECONNREFUSED 错误'
    },
    {
        problem: '缺少 Redis 密码',
        explanation: '远程 Redis 服务需要认证',
        impact: '可能的认证失败'
    },
    {
        problem: '未使用 TLS (rediss://)',
        explanation: '远程环境通常要求加密连接',
        impact: '连接可能被拒绝'
    },
    {
        problem: 'SNI 配置错误',
        explanation: 'TLS 握手需要正确的服务器名称',
        impact: 'SSL/TLS 握手失败'
    }
];

rootCauses.forEach((cause, index) => {
    console.log(`${index + 1}. ${cause.problem}`);
    console.log(`   解释: ${cause.explanation}`);
    console.log(`   影响: ${cause.impact}`);
    console.log('');
});

// 解决方案
console.log('✅ 解决方案:\n');

console.log('1. 设置正确的 Redis URL:');
console.log('   REDIS_URL=rediss://username:password@master.drive-collector-redis--xxxx.addon.code.run:6379');
console.log('');

console.log('2. 或者使用单独参数:');
console.log('   REDIS_HOST=master.drive-collector-redis--xxxx.addon.code.run');
console.log('   REDIS_PORT=6379');
console.log('   REDIS_PASSWORD=your_password');
console.log('   REDIS_SNI_SERVERNAME=master.drive-collector-redis--xxxx.addon.code.run');
console.log('');

console.log('3. 确保使用 rediss:// 协议 (TLS)');
console.log('4. 禁用证书验证 (已配置)');
console.log('5. 设置正确的 SNI 主机名');
console.log('');

// 验证正确配置
console.log('🔧 正确配置示例:\n');

const correctEnv = {
    REDIS_URL: 'rediss://user:pass@master.drive-collector-redis--qmnl9h54d875.addon.code.run:6379'
};

console.log('环境变量:');
Object.entries(correctEnv).forEach(([key, value]) => {
    console.log(`   ${key}=${value}`);
});

console.log('\n解析结果:');
const correctUrl = new URL(correctEnv.REDIS_URL);
console.log(`   协议: ${correctUrl.protocol} (TLS 加密)`);
console.log(`   主机: ${correctUrl.hostname} (远程地址)`);
console.log(`   端口: ${correctUrl.port || '6379'}`);
console.log(`   用户: ${correctUrl.username}`);
console.log(`   密码: ${correctUrl.password ? '***' : '无'}`);

console.log('\n✅ 这个配置将成功连接到远程 Redis 服务');
console.log('❌ 而不是尝试连接到本地 127.0.0.1:6379\n');