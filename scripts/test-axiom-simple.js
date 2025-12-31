#!/usr/bin/env node

/**
 * 简化的 Axiom 日志测试
 * 直接测试日志发送功能
 */

import { trace } from '@opentelemetry/api';

// 模拟环境变量
const env = {
    AXIOM_TOKEN: process.env.AXIOM_TOKEN || 'xaat-827c7e82-40f5-4096-aecd-baa46d1c86fc',
    AXIOM_DATASET: process.env.AXIOM_DATASET || 'lb',
    NODE_ENV: 'development'
};

console.log('🧪 简化版 Axiom 日志测试');
console.log('========================');
console.log('环境配置:');
console.log('  AXIOM_TOKEN:', env.AXIOM_TOKEN ? '✅ 已设置' : '❌ 未设置');
console.log('  AXIOM_DATASET:', env.AXIOM_DATASET ? '✅ 已设置' : '❌ 未设置');
console.log('  NODE_ENV:', env.NODE_ENV);
console.log('');

// 测试 1: 直接发送日志到 Axiom API
async function testDirectLogSend() {
    console.log('📡 测试 1: 直接发送日志到 Axiom API...');
    
    if (!env.AXIOM_TOKEN || !env.AXIOM_DATASET) {
        console.log('❌ 缺少配置，跳过测试');
        return false;
    }

    try {
        const logPayload = {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: 'Axiom 日志连接测试',
            service: 'lb-worker-js',
            test_id: 'test-' + Date.now(),
            metadata: {
                environment: env.NODE_ENV,
                timestamp: Date.now(),
                version: '0.1.5'
            }
        };

        // 使用 Axiom 的日志 API 端点
        const response = await fetch(`https://api.axiom.co/v1/datasets/${env.AXIOM_DATASET}/ingest`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.AXIOM_TOKEN}`,
                'Content-Type': 'application/json',
                'X-Axiom-Dataset': env.AXIOM_DATASET
            },
            body: JSON.stringify([logPayload])
        });

        if (response.ok) {
            console.log('✅ 日志发送成功');
            const result = await response.json();
            console.log('   响应:', JSON.stringify(result, null, 2));
            return true;
        } else {
            console.log('❌ 日志发送失败:', response.status, response.statusText);
            const errorText = await response.text();
            console.log('   错误:', errorText);
            return false;
        }
    } catch (error) {
        console.log('❌ 发送日志时出错:', error.message);
        return false;
    }
}

// 测试 2: 检查 OpenTelemetry 配置
async function testOpenTelemetrySetup() {
    console.log('\n🔧 测试 2: OpenTelemetry 配置检查...');
    
    try {
        // 检查是否可以导入模块
        const otelApi = await import('@opentelemetry/api');
        console.log('✅ @opentelemetry/api 导入成功');
        
        // 检查当前活跃的 span
        const activeSpan = otelApi.trace.getActiveSpan();
        console.log('   当前活跃 span:', activeSpan ? '存在' : 'null');
        
        // 创建配置对象
        const config = {
            serviceName: 'lb-worker-js',
            exporter: {
                url: 'https://api.axiom.co/v1/traces',
                headers: {
                    'Authorization': env.AXIOM_TOKEN ? `Bearer ${env.AXIOM_TOKEN}` : '',
                    'X-Axiom-Dataset': env.AXIOM_DATASET || ''
                }
            }
        };
        
        console.log('✅ OpenTelemetry 配置对象创建成功');
        console.log('   Service:', config.serviceName);
        console.log('   Exporter:', config.exporter.url);
        console.log('   Has Auth:', !!config.exporter.headers.Authorization);
        
        return true;
    } catch (error) {
        console.log('❌ OpenTelemetry 配置检查失败:', error.message);
        return false;
    }
}

// 测试 3: 模拟日志记录器行为
async function testLoggerBehavior() {
    console.log('\n📝 测试 3: 模拟日志记录器行为...');
    
    // 模拟 logger.info 行为
    const mockLogger = {
        info: function(message, meta = {}, ctx = null) {
            const span = trace.getActiveSpan();
            console.log(`   logger.info('${message}', ${JSON.stringify(meta)})`);
            console.log(`   当前活跃 span: ${span ? '存在' : 'null'}`);
            
            if (span) {
                console.log('   ✅ 会通过 span.addEvent 发送日志到 Axiom');
                return true;
            } else {
                console.log('   ⚠️  没有活跃 span，日志不会发送到 Axiom');
                return false;
            }
        }
    };
    
    // 测试调用
    const result = mockLogger.info('测试日志', { test: true, timestamp: Date.now() });
    
    return result;
}

// 主测试函数
async function main() {
    console.log('开始测试...\n');
    
    const test1 = await testDirectLogSend();
    const test2 = await testOpenTelemetrySetup();
    const test3 = await testLoggerBehavior();
    
    console.log('\n========================');
    console.log('测试结果总结:');
    console.log(`  1. 直接日志发送: ${test1 ? '✅ 通过' : '❌ 失败'}`);
    console.log(`  2. OpenTelemetry 配置: ${test2 ? '✅ 通过' : '❌ 失败'}`);
    console.log(`  3. 日志记录器行为: ${test3 ? '✅ 通过' : '❌ 失败'}`);
    
    if (test1 && test2 && test3) {
        console.log('\n🎉 所有测试通过！Axiom 日志功能应该可以正常工作。');
    } else {
        console.log('\n⚠️  部分测试失败，需要进一步诊断。');
    }
}

main().catch(console.error);