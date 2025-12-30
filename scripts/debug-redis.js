#!/usr/bin/env node

// 简化的 Redis 连接调试脚本
// 专门用于分析 ECONNREFUSED 问题

console.log('🔍 Redis 连接问题诊断脚本\n');

// 模拟环境变量检查
const envVars = {
    REDIS_URL: process.env.REDIS_URL,
    REDIS_HOST: process.env.REDIS_HOST,
    REDIS_PORT: process.env.REDIS_PORT,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD,
    NF_REDIS_URL: process.env.NF_REDIS_URL,
    NF_REDIS_HOST: process.env.NF_REDIS_HOST,
    NF_REDIS_PORT: process.env.NF_REDIS_PORT,
    NF_REDIS_PASSWORD: process.env.NF_REDIS_PASSWORD,
    NODE_ENV: process.env.NODE_ENV
};

console.log('📋 当前环境变量:');
Object.entries(envVars).forEach(([key, value]) => {
    if (value) {
        if (key.includes('PASSWORD')) {
            console.log(`   ${key}: ${value.substring(0, 4)}...${value.substring(value.length - 4)}`);
        } else {
            console.log(`   ${key}: ${value}`);
        }
    } else {
        console.log(`   ${key}: (未设置)`);
    }
});

console.log('\n🔄 配置解析逻辑分析:');

// 模拟 CacheService 的配置解析
const redisConfig = {}; // 假设 config.redis 为空对象

// 优先使用标准环境变量
const redisUrl = process.env.REDIS_URL || redisConfig.url;
const redisHost = process.env.REDIS_HOST || redisConfig.host;
const redisPort = parseInt(process.env.REDIS_PORT, 10) || redisConfig.port || 6379;
const redisPassword = process.env.REDIS_PASSWORD || redisConfig.password;

console.log('   第一步 - 标准环境变量:');
console.log(`     redisUrl: ${redisUrl || '未配置'}`);
console.log(`     redisHost: ${redisHost || '未配置'}`);
console.log(`     redisPort: ${redisPort}`);
console.log(`     redisPassword: ${redisPassword ? '已配置' : '未配置'}`);

// 支持 Northflank 环境变量 (NF_ 前缀)
let finalRedisUrl = redisUrl;
let finalRedisHost = redisHost;
let finalRedisPort = redisPort;
let finalRedisPassword = redisPassword;

if (!redisUrl && !redisHost) {
    console.log('   第二步 - Northflank 环境变量 (NF_ 前缀):');
    finalRedisUrl = process.env.NF_REDIS_URL;
    finalRedisHost = process.env.NF_REDIS_HOST;
    finalRedisPort = parseInt(process.env.NF_REDIS_PORT, 10) || redisPort;
    finalRedisPassword = process.env.NF_REDIS_PASSWORD || redisPassword;
    
    console.log(`     NF_REDIS_URL: ${finalRedisUrl || '未配置'}`);
    console.log(`     NF_REDIS_HOST: ${finalRedisHost || '未配置'}`);
    console.log(`     NF_REDIS_PORT: ${finalRedisPort}`);
    console.log(`     NF_REDIS_PASSWORD: ${finalRedisPassword ? '已配置' : '未配置'}`);
} else {
    console.log('   第二步 - 跳过 NF_ 变量 (标准变量已配置)');
}

const hasRedis = !!(finalRedisUrl || (finalRedisHost && finalRedisPort));
console.log(`\n   最终状态 - hasRedis: ${hasRedis}`);

if (!hasRedis) {
    console.log('\n❌ 问题诊断: Redis 未配置');
    console.log('   可能原因:');
    console.log('   1. REDIS_URL/NF_REDIS_URL 未设置');
    console.log('   2. REDIS_HOST/NF_REDIS_HOST 未设置');
    console.log('   3. 环境变量未正确传递到容器');
    process.exit(1);
}

console.log('\n✅ Redis 配置已检测到');
console.log(`   最终连接目标: ${finalRedisUrl || `${finalRedisHost}:${finalRedisPort}`}`);

// 分析连接配置
console.log('\n⚙️ 连接配置分析:');
if (finalRedisUrl) {
    try {
        const url = new URL(finalRedisUrl);
        console.log(`   URL 协议: ${url.protocol}`);
        console.log(`   主机名: ${url.hostname}`);
        console.log(`   端口: ${url.port || '默认'}`);
        console.log(`   用户名: ${url.username || '无'}`);
        console.log(`   密码: ${url.password ? '已配置' : '无'}`);
        
        // 检查 TLS
        if (url.protocol === 'rediss:') {
            console.log('   TLS: ✅ 启用 (rediss://)');
        } else if (url.protocol === 'redis:') {
            console.log('   TLS: ❌ 未启用 (redis://)');
        }
    } catch (e) {
        console.log(`   URL 解析错误: ${e.message}`);
    }
} else {
    console.log(`   主机: ${finalRedisHost}`);
    console.log(`   端口: ${finalRedisPort}`);
    console.log(`   密码: ${finalRedisPassword ? '已配置' : '无'}`);
}

// 检查 ECONNREFUSED 的常见原因
console.log('\n🔍 ECONNREFUSED 常见原因分析:');

const issues = [];

if (!finalRedisUrl && !finalRedisHost) {
    issues.push('未配置 Redis 主机地址');
}

if (finalRedisHost === '127.0.0.1' || finalRedisHost === 'localhost') {
    issues.push('使用 localhost/127.0.0.1 - 应该使用远程 Redis URL');
}

if (!finalRedisPassword) {
    issues.push('未配置 Redis 密码 - 远程 Redis 通常需要认证');
}

if (finalRedisPort === 6379 && finalRedisHost && !finalRedisUrl) {
    issues.push('使用默认端口 6379 - 确认远程 Redis 端口是否正确');
}

if (issues.length > 0) {
    console.log('   发现以下潜在问题:');
    issues.forEach(issue => console.log(`   ⚠️ ${issue}`));
} else {
    console.log('   ✅ 配置看起来正常');
}

// 模拟 ioredis 配置构建
console.log('\n🔧 ioredis 配置构建:');
const redisConfigBuilt = {
    connectTimeout: 15000,
    keepAlive: 30000,
    family: 4,
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: 5,
    enableAutoPipelining: true,
    tls: {
        rejectUnauthorized: false,
        servername: process.env.REDIS_SNI_SERVERNAME || finalRedisHost || (finalRedisUrl ? new URL(finalRedisUrl).hostname : undefined)
    }
};

if (finalRedisUrl) {
    redisConfigBuilt.url = finalRedisUrl;
} else {
    redisConfigBuilt.host = finalRedisHost;
    redisConfigBuilt.port = finalRedisPort;
    if (finalRedisPassword) {
        redisConfigBuilt.password = finalRedisPassword;
    }
}

console.log('   配置对象:', JSON.stringify(redisConfigBuilt, (key, value) => {
    if (key === 'password' && value) return '***';
    if (typeof value === 'function') return '[Function]';
    return value;
}, 2));

// TLS 配置分析
console.log('\n🔐 TLS 配置分析:');
console.log(`   rejectUnauthorized: ${redisConfigBuilt.tls.rejectUnauthorized}`);
console.log(`   servername: ${redisConfigBuilt.tls.servername}`);

if (finalRedisUrl && finalRedisUrl.startsWith('rediss://')) {
    console.log('   ✅ 使用 TLS 连接 (rediss://)');
} else if (finalRedisUrl && finalRedisUrl.startsWith('redis://')) {
    console.log('   ⚠️ 使用非 TLS 连接 (redis://) - 远程环境可能需要 TLS');
}

// 诊断建议
console.log('\n💡 诊断建议:');

if (!finalRedisUrl) {
    console.log('   1. 设置 REDIS_URL 环境变量，格式: rediss://user:password@host:port');
    console.log('   2. 确保使用 rediss:// 协议启用 TLS');
    console.log('   3. 确认主机名、端口、密码正确');
} else {
    console.log('   1. 检查 Redis URL 格式是否正确');
    console.log('   2. 确认远程 Redis 服务是否运行');
    console.log('   3. 检查网络连接和防火墙设置');
    console.log('   4. 验证用户名密码是否正确');
}

console.log('\n📋 配置检查清单:');
console.log('   ✅ 使用远程 Redis URL 而非 localhost');
console.log('   ✅ 配置 Redis 密码');
console.log('   ✅ 使用 TLS (rediss://)');
console.log('   ✅ 设置正确的 SNI 主机名');
console.log('   ✅ 禁用证书验证 (rejectUnauthorized: false)');

console.log('\n🔍 诊断完成\n');