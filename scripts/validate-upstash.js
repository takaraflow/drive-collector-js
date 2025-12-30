#!/usr/bin/env node

/**
 * Upstash Cache 和 QStash 连接验证脚本
 * 用于验证 Upstash Redis REST API 连接和 QStash 配置
 *
 * 使用方法：
 * 1. 编辑下面的环境变量，填入你的 Upstash 连接信息
 * 2. 运行: node validate-upstash.js
 * 3. 脚本会执行基本的 Cache 和 QStash 操作来验证连接
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

        console.log('🎉 KV测试通过！Upstash集成正常工作');

    } catch (error) {
        console.error('❌ KV测试失败:', error.message);
        console.log('\n🔧 请检查以下配置:');
        console.log('1. UPSTASH_REDIS_REST_URL 环境变量');
        console.log('2. UPSTASH_REDIS_REST_TOKEN 环境变量');
        console.log('3. 确保网络连接正常');
    }
}

async function testQStash() {
    try {
        console.log('\n🔄 开始测试 QStash 配置...');

        // 检查环境变量
        const qstashToken = process.env.QSTASH_TOKEN;
        if (!qstashToken) {
            console.log('⚠️ QSTASH_TOKEN 环境变量未设置');
            console.log('📋 获取 QSTASH_TOKEN 的步骤:');
            console.log('1. 访问 https://console.upstash.com/qstash');
            console.log('2. 登录你的 Upstash 账户');
            console.log('3. 创建或选择你的 QStash 项目');
            console.log('4. 在 Settings 页面复制 Token');
            console.log('5. 将 token 设置为 QSTASH_TOKEN 环境变量');
            return;
        }

        console.log('✅ QSTASH_TOKEN 环境变量已设置');

        // 动态导入 QStash 服务
        const { QStashService } = await import('./src/services/QStashService.js');
        const service = new QStashService();

        console.log(`✅ QStash 服务初始化成功 (模式: ${service.isMockMode ? 'Mock' : 'Real'})`);

        if (service.isMockMode) {
            console.log('⚠️ 检测到模拟模式，可能的原因:');
            console.log('1. QSTASH_TOKEN 为空或无效');
            console.log('2. 配置文件中 qstash.token 未正确设置');
        } else {
            console.log('🎉 QStash 配置正常，将使用真实服务');
        }

    } catch (error) {
        console.error('❌ QStash 测试失败:', error.message);
        console.log('\n🔧 请检查以下配置:');
        console.log('1. QSTASH_TOKEN 环境变量是否正确设置');
        console.log('2. 确保 token 有效且未过期');
        console.log('3. 检查网络连接');
    }
}

async function main() {
    await testUpstash();
    await testQStash();
}

// 只有当直接运行此脚本时才执行测试
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { testUpstash, testQStash };