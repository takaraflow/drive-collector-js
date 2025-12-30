#!/usr/bin/env node

/**
 * Upstash Cache 连接验证脚本
 * 用于验证 Upstash Redis REST API 连接和配置
 *
 * 使用方法：
 * 1. 编辑下面的环境变量，填入你的 Upstash 连接信息
 * 2. 运行: node validate-upstash.js
 * 3. 脚本会执行基本的 Cache 操作来验证连接
 */

// ===== 配置你的 Upstash 连接信息 =====
process.env.KV_PROVIDER = 'upstash';
process.env.UPSTASH_REDIS_REST_URL = 'https://your-upstash-endpoint.upstash.io';  // 替换为你的实际 endpoint
process.env.UPSTASH_REDIS_REST_TOKEN = 'your-upstash-token';  // 替换为你的实际 token

async function testUpstash() {
    try {
        console.log('🔄 开始测试 Upstash KV 集成...');

        // 动态导入Cache服务
        const { cache } = await import('./src/services/CacheService.js');

        console.log('✅ KV服务初始化成功');

        // 测试SET操作
        console.log('📝 测试SET操作...');
        const setResult = await cache.set('test_key', { message: 'Hello from Upstash!', timestamp: Date.now() });
        console.log('SET结果:', setResult);

        // 测试GET操作
        console.log('📖 测试GET操作...');
        const getResult = await cache.get('test_key');
        console.log('GET结果:', getResult);

        // 测试DELETE操作
        console.log('🗑️  测试DELETE操作...');
        const deleteResult = await cache.delete('test_key');
        console.log('DELETE结果:', deleteResult);

        // 验证删除后获取
        const getAfterDelete = await cache.get('test_key');
        console.log('删除后GET结果:', getAfterDelete);

        console.log('🎉 所有测试通过！Upstash集成正常工作');

    } catch (error) {
        console.error('❌ 测试失败:', error.message);
        console.log('\n🔧 请检查以下配置:');
        console.log('1. UPSTASH_REDIS_REST_URL 环境变量');
        console.log('2. UPSTASH_REDIS_REST_TOKEN 环境变量');
        console.log('3. 确保网络连接正常');
        process.exit(1);
    }
}

// 只有当直接运行此脚本时才执行测试
if (import.meta.url === `file://${process.argv[1]}`) {
    testUpstash();
}

export { testUpstash };