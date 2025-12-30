#!/usr/bin/env node

/**
 * 增强的错误诊断脚本
 * 输出 CacheService 中的详细错误信息和堆栈跟踪
 */

console.log('🔍 CacheService 增强错误诊断\n');

// 模拟 CacheService 的错误事件监听器配置
console.log('📋 CacheService 错误事件监听器配置:\n');

const errorListeners = [
    {
        event: 'connect',
        handler: '记录连接成功信息，包括主机、端口、URL、密码状态、环境变量和平台信息'
    },
    {
        event: 'ready',
        handler: '记录连接建立时间和配置详情'
    },
    {
        event: 'reconnecting',
        handler: '记录重连延迟、上次错误、失败次数和当前提供商'
    },
    {
        event: 'error',
        handler: '记录错误详情：消息、代码、errno、syscall、hostname、port、address、运行时间、环境、平台、堆栈第一行'
    },
    {
        event: 'close',
        handler: '记录连接关闭、持续时间、上次错误、失败次数、当前提供商、密码状态、环境、平台'
    },
    {
        event: 'wait',
        handler: '调试：命令排队，等待连接'
    },
    {
        event: 'end',
        handler: '警告：连接被客户端结束，触发自动重启'
    },
    {
        event: 'select',
        handler: '调试：数据库选择'
    }
];

console.log('已配置的事件监听器:');
errorListeners.forEach((listener, index) => {
    console.log(`${index + 1}. ${listener.event}: ${listener.handler}`);
});

console.log('\n📊 详细错误日志字段:\n');

const errorFields = [
    { field: 'error.message', description: '错误消息文本' },
    { field: 'error.code', description: '错误代码 (如 ECONNREFUSED)' },
    { field: 'error.errno', description: '系统错误编号' },
    { field: 'error.syscall', description: '系统调用 (如 connect)' },
    { field: 'error.hostname', description: '目标主机名' },
    { field: 'error.port', description: '目标端口' },
    { field: 'error.address', description: '解析的IP地址' },
    { field: 'uptime', description: '连接存活时间 (秒)' },
    { field: 'node_env', description: 'Node.js 环境' },
    { field: 'platform', description: '操作系统平台' },
    { field: 'stack[0]', description: '堆栈跟踪第一行' }
];

errorFields.forEach(item => {
    console.log(`   ${item.field}: ${item.description}`);
});

console.log('\n🔄 完整的错误处理流程:\n');

const errorFlow = [
    {
        step: 1,
        action: '错误事件触发',
        details: 'this.redisClient.on(\'error\', (error) => { ... })'
    },
    {
        step: 2,
        action: '记录错误日志',
        details: 'logger.error(`🚨 Redis ERROR: ${error.message}`, { ... })'
    },
    {
        step: 3,
        action: '保存错误信息',
        details: 'this.lastRedisError = error.message'
    },
    {
        step: 4,
        action: '检查是否需要故障转移',
        details: '_shouldFailover(error) 检查可重试错误'
    },
    {
        step: 5,
        action: '触发故障转移',
        details: '_failover() 切换到备用提供商'
    },
    {
        step: 6,
        action: '自动重启',
        details: 'close 事件触发 _restartRedisClient()'
    }
];

errorFlow.forEach(step => {
    console.log(`${step.step}. ${step.action}`);
    console.log(`   ${step.details}`);
});

console.log('\n🔍 ECONNREFUSED 错误详细分析:\n');

const econnrefusedAnalysis = {
    错误类型: '网络连接错误',
    系统调用: 'connect',
    错误代码: 'ECONNREFUSED',
    常见原因: [
        '目标主机不可达 (127.0.0.1 在远程容器中)',
        '端口未开放或服务未运行',
        '防火墙阻止连接',
        '认证失败导致连接拒绝'
    ],
    CacheService日志: {
        错误消息: 'connect ECONNREFUSED 127.0.0.1:6379',
        附加信息: {
            code: 'ECONNREFUSED',
            errno: 'ECONNREFUSED',
            syscall: 'connect',
            address: '127.0.0.1',
            port: 6379,
            uptime: '0s (连接失败)',
            node_env: 'production',
            platform: 'linux',
            stack: 'Error: connect ECONNREFUSED 127.0.0.1:6379\n    at TCPConnectWrap.afterConnect [as oncomplete] ...'
        }
    }
};

console.log(JSON.stringify(econnrefusedAnalysis, null, 2));

console.log('\n📋 完整错误信息示例:\n');

const exampleErrorLog = {
    timestamp: '2025-12-30T18:27:03.105Z',
    level: 'ERROR',
    message: '🚨 Redis ERROR: connect ECONNREFUSED 127.0.0.1:6379',
    context: {
        code: 'ECONNREFUSED',
        errno: -111,
        syscall: 'connect',
        hostname: undefined,
        port: 6379,
        address: '127.0.0.1',
        uptime: '0s',
        node_env: 'production',
        platform: 'linux',
        stack: 'Error: connect ECONNREFUSED 127.0.0.1:6379\n    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1634:14)\n    at RedisClient._onConnect (/app/node_modules/ioredis/built/RedisClient.js:183:28)'
    }
};

console.log('错误日志示例:');
console.log(JSON.stringify(exampleErrorLog, null, 2));

console.log('\n💡 诊断建议:\n');

const recommendations = [
    {
        问题: 'ECONNREFUSED 到 127.0.0.1:6379',
        解决方案: '将 REDIS_HOST 或 REDIS_URL 从 localhost 改为远程主机名',
        示例: 'REDIS_URL=rediss://user:pass@remote-host:6379'
    },
    {
        问题: '缺少认证',
        解决方案: '设置 REDIS_PASSWORD 环境变量',
        示例: 'REDIS_PASSWORD=your_password'
    },
    {
        问题: 'TLS 配置',
        解决方案: '使用 rediss:// 协议并配置 SNI',
        示例: 'REDIS_SNI_SERVERNAME=remote-host'
    },
    {
        问题: '详细日志',
        解决方案: '检查上述所有日志字段以获取完整诊断信息',
        示例: '查看 error.code, error.address, uptime, stack 等字段'
    }
];

recommendations.forEach((rec, index) => {
    console.log(`${index + 1}. ${rec.问题}`);
    console.log(`   解决方案: ${rec.解决方案}`);
    console.log(`   示例: ${rec.示例}`);
    console.log('');
});

console.log('🔍 诊断完成\n');