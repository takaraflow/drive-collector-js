#!/usr/bin/env node

/**
 * CacheService 配置分析脚本
 * 用于诊断 Redis 连接问题，特别是 ECONNREFUSED 错误
 */

console.log('🔍 CacheService Redis 连接配置分析\n');

// 模拟 config.redis 对象（根据 config/index.js）
const config = {
    redis: {
        url: process.env.REDIS_URL || process.env.NF_REDIS_URL,
        host: process.env.REDIS_HOST || process.env.NF_REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT || process.env.NF_REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || process.env.NF_REDIS_PASSWORD,
    }
};

// 模拟 CacheService 构造函数中的配置解析
console.log('🔄 CacheService 配置解析过程:\n');

// L1 缓存配置
const l1CacheTtl = 10 * 1000;
console.log(`L1 内存缓存 TTL: ${l1CacheTtl}ms (10秒)`);

// Redis 配置 - 支持多种环境变量格式
const redisConfig = config.redis || {};
console.log('原始 redisConfig:', JSON.stringify(redisConfig, null, 2));

// 优先使用标准环境变量
const redisUrl = process.env.REDIS_URL || redisConfig.url;
const redisHost = process.env.REDIS_HOST || redisConfig.host;
const redisPort = parseInt(process.env.REDIS_PORT, 10) || redisConfig.port || 6379;
const redisPassword = process.env.REDIS_PASSWORD || redisConfig.password;

console.log('\n1️⃣ 标准环境变量解析:');
console.log(`   REDIS_URL: ${redisUrl || '未配置'}`);
console.log(`   REDIS_HOST: ${redisHost || '未配置'}`);
console.log(`   REDIS_PORT: ${redisPort}`);
console.log(`   REDIS_PASSWORD: ${redisPassword ? '已配置' : '未配置'}`);

// 支持 Northflank 环境变量 (NF_ 前缀)
let finalRedisUrl = redisUrl;
let finalRedisHost = redisHost;
let finalRedisPort = redisPort;
let finalRedisPassword = redisPassword;

if (!redisUrl && !redisHost) {
    console.log('\n2️⃣ Northflank 环境变量 (NF_ 前缀):');
    finalRedisUrl = process.env.NF_REDIS_URL;
    finalRedisHost = process.env.NF_REDIS_HOST;
    finalRedisPort = parseInt(process.env.NF_REDIS_PORT, 10) || redisPort;
    finalRedisPassword = process.env.NF_REDIS_PASSWORD || redisPassword;
    
    console.log(`   NF_REDIS_URL: ${finalRedisUrl || '未配置'}`);
    console.log(`   NF_REDIS_HOST: ${finalRedisHost || '未配置'}`);
    console.log(`   NF_REDIS_PORT: ${finalRedisPort}`);
    console.log(`   NF_REDIS_PASSWORD: ${finalRedisPassword ? '已配置' : '未配置'}`);
} else {
    console.log('\n2️⃣ 跳过 NF_ 变量 (标准变量已配置)');
}

const hasRedis = !!(finalRedisUrl || (finalRedisHost && finalRedisPort));

console.log('\n📊 最终配置状态:');
console.log(`   hasRedis: ${hasRedis}`);
console.log(`   最终 URL: ${finalRedisUrl || '未配置'}`);
console.log(`   最终 Host: ${finalRedisHost || '未配置'}`);
console.log(`   最终 Port: ${finalRedisPort}`);
console.log(`   最终 Password: ${finalRedisPassword ? '已配置' : '未配置'}`);

if (!hasRedis) {
    console.log('\n❌ Redis 未配置 - 将跳过初始化');
    process.exit(1);
}

console.log('\n✅ Redis 已配置，继续分析连接配置...\n');

// 模拟 ioredis 配置构建
console.log('🔧 ioredis 连接配置构建:\n');

const redisConnectionConfig = {
    connectTimeout: 15000, // Northflank环境连接超时调整为15秒
    keepAlive: 30000, // TCP keep-alive，每30秒发送一次
    family: 4, // 强制使用IPv4
    lazyConnect: true, // 延迟连接，避免启动时的连接风暴
    enableReadyCheck: true, // Northflank环境特定配置
    maxRetriesPerRequest: 5, // 每请求最大重试次数
    enableAutoPipelining: true, // 优化批量操作
    retryStrategy: (times) => {
        const maxRetries = process.env.REDIS_MAX_RETRIES || 5;
        if (times > maxRetries) {
            console.log(`🚨 Redis 重连超过最大次数 (${maxRetries})，停止重连`);
            return null; // 停止重连，触发错误
        }
        const delay = Math.min(times * 500, 30000); // 最大30秒间隔
        console.log(`⚠️ Redis 重试尝试 ${times}/${maxRetries}，延迟 ${delay}ms`);
        return delay;
    },
    reconnectOnError: (err) => {
        const msg = err.message.toLowerCase();
        // Northflank环境特殊处理：对ECONNRESET和timeout错误更宽容
        const shouldReconnect = msg.includes('econnreset') ||
                               msg.includes('timeout') ||
                               msg.includes('network') ||
                               !msg.includes('auth');
        if (shouldReconnect) {
            console.log(`⚠️ Redis 重连错误: ${err.message}，将尝试重连`);
        }
        return shouldReconnect;
    },
    // TLS 配置 - 从环境变量读取 SNI 主机名
    tls: {
        rejectUnauthorized: false, // 禁用证书验证（Northflank环境需要）
        servername: process.env.REDIS_SNI_SERVERNAME || process.env.REDIS_HOST || process.env.NF_REDIS_HOST || (finalRedisUrl ? new URL(finalRedisUrl).hostname : undefined), // SNI 主机名从环境变量读取
    }
};

// 优先使用 URL，否则使用 host/port/password
if (finalRedisUrl) {
    redisConnectionConfig.url = finalRedisUrl;
} else {
    redisConnectionConfig.host = finalRedisHost;
    redisConnectionConfig.port = finalRedisPort;
    if (finalRedisPassword) {
        redisConnectionConfig.password = finalRedisPassword;
    }
}

console.log('连接配置对象:');
console.log(JSON.stringify(redisConnectionConfig, (key, value) => {
    if (key === 'password' && value) return '***';
    if (typeof value === 'function') return `[Function: ${key}]`;
    if (key === 'tls') return JSON.stringify(value, null, 2);
    return value;
}, 2));

// 分析连接目标
console.log('\n🎯 连接目标分析:\n');

if (finalRedisUrl) {
    try {
        const url = new URL(finalRedisUrl);
        console.log(`URL 解析结果:`);
        console.log(`   协议: ${url.protocol}`);
        console.log(`   主机: ${url.hostname}`);
        console.log(`   端口: ${url.port || (url.protocol === 'rediss:' ? '6380' : '6379')}`);
        console.log(`   用户名: ${url.username || '无'}`);
        console.log(`   密码: ${url.password ? '***' : '无'}`);
        
        // 关键检查
        if (url.protocol === 'redis:') {
            console.log('\n⚠️ 警告: 使用明文 Redis 协议 (redis://)');
            console.log('   远程环境应该使用 rediss:// (TLS)');
        } else if (url.protocol === 'rediss:') {
            console.log('\n✅ 正确: 使用 TLS Redis 协议 (rediss://)');
        }
        
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
            console.log('\n⚠️ 警告: 使用本地主机名');
            console.log('   ECONNREFUSED 错误的常见原因: 远程环境无法连接到 localhost');
        }
        
    } catch (e) {
        console.log(`URL 解析错误: ${e.message}`);
    }
} else {
    console.log(`直接连接: ${finalRedisHost}:${finalRedisPort}`);
    
    if (finalRedisHost === 'localhost' || finalRedisHost === '127.0.0.1') {
        console.log('\n⚠️ 严重警告: 使用 localhost/127.0.0.1');
        console.log('   ECONNREFUSED 错误的根本原因!');
        console.log('   在远程环境中，localhost 指向容器本身，而不是 Redis 服务');
    }
    
    if (!finalRedisPassword) {
        console.log('\n⚠️ 警告: 未配置密码');
        console.log('   远程 Redis 通常需要认证');
    }
}

// TLS 配置分析
console.log('\n🔐 TLS 配置分析:\n');
console.log(`rejectUnauthorized: ${redisConnectionConfig.tls.rejectUnauthorized}`);
console.log(`servername: ${redisConnectionConfig.tls.servername}`);

if (redisConnectionConfig.tls.servername === 'localhost' || redisConnectionConfig.tls.servername === '127.0.0.1') {
    console.log('\n⚠️ TLS SNI 主机名错误: 使用 localhost');
    console.log('   SNI (Server Name Indication) 需要远程主机名');
}

// ECONNREFUSED 问题诊断
console.log('\n🔍 ECONNREFUSED 错误深度诊断:\n');

const issues = [];

// 检查 1: 是否使用 localhost
if (finalRedisHost === 'localhost' || finalRedisHost === '127.0.0.1' || 
    (finalRedisUrl && (finalRedisUrl.includes('localhost') || finalRedisUrl.includes('127.0.0.1')))) {
    issues.push({
        severity: 'CRITICAL',
        issue: '使用 localhost/127.0.0.1 作为 Redis 主机',
        explanation: '在远程环境中，localhost 指向容器自身，无法访问外部 Redis 服务',
        fix: '使用远程 Redis URL，如 rediss://user:password@remote-host:6379'
    });
}

// 检查 2: 是否缺少密码
if (!finalRedisPassword) {
    issues.push({
        severity: 'HIGH',
        issue: '未配置 Redis 密码',
        explanation: '远程 Redis 服务通常需要密码认证',
        fix: '设置 REDIS_PASSWORD 或 NF_REDIS_PASSWORD 环境变量'
    });
}

// 检查 3: 是否使用明文协议
if (finalRedisUrl && finalRedisUrl.startsWith('redis://')) {
    issues.push({
        severity: 'MEDIUM',
        issue: '使用明文 Redis 协议 (redis://)',
        explanation: '远程环境通常需要 TLS 加密连接',
        fix: '使用 rediss:// 协议'
    });
}

// 检查 4: SNI 配置问题
if (redisConnectionConfig.tls.servername === 'localhost' || redisConnectionConfig.tls.servername === '127.0.0.1') {
    issues.push({
        severity: 'HIGH',
        issue: 'TLS SNI 主机名配置错误',
        explanation: 'SNI 需要远程主机名，不能是 localhost',
        fix: '设置 REDIS_SNI_SERVERNAME 环境变量或使用正确的 REDIS_HOST'
    });
}

// 检查 5: 缺少 URL 但有 host/port
if (!finalRedisUrl && finalRedisHost && finalRedisHost !== 'localhost') {
    issues.push({
        severity: 'MEDIUM',
        issue: '使用 host/port 而非 URL',
        explanation: 'URL 格式更清晰，包含协议和认证信息',
        fix: '使用 REDIS_URL 格式: rediss://user:password@host:port'
    });
}

if (issues.length > 0) {
    console.log('发现以下问题:\n');
    issues.forEach((item, index) => {
        console.log(`${index + 1}. [${item.severity}] ${item.issue}`);
        console.log(`   解释: ${item.explanation}`);
        console.log(`   修复: ${item.fix}`);
        console.log('');
    });
} else {
    console.log('✅ 配置检查通过，未发现明显问题');
}

// 正确配置示例
console.log('💡 正确配置示例:\n');

console.log('方法 1 - 使用 REDIS_URL (推荐):');
console.log('REDIS_URL=rediss://user:password@master.drive-collector-redis--qmnl9h54d875.addon.code.run:6379');
console.log('');

console.log('方法 2 - 使用单独参数:');
console.log('REDIS_HOST=master.drive-collector-redis--qmnl9h54d875.addon.code.run');
console.log('REDIS_PORT=6379');
console.log('REDIS_PASSWORD=your_password');
console.log('REDIS_SNI_SERVERNAME=master.drive-collector-redis--qmnl9h54d875.addon.code.run');
console.log('');

console.log('方法 3 - Northflank 格式:');
console.log('NF_REDIS_URL=rediss://user:password@master.drive-collector-redis--qmnl9h54d875.addon.code.run:6379');
console.log('');

console.log('🔧 环境变量设置建议:');
console.log('1. 在 Northflank 仪表板中设置环境变量');
console.log('2. 确保变量名正确 (REDIS_URL 或 NF_REDIS_URL)');
console.log('3. 使用 rediss:// 协议');
console.log('4. 包含用户名和密码');
console.log('5. 使用正确的远程主机名和端口');

console.log('\n🔍 诊断完成\n');