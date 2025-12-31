#!/usr/bin/env node

/**
 * 测试 Axiom 日志修复
 * 验证 instrumentation 是否正确工作
 */

import { trace } from '@opentelemetry/api';
import { instrument } from '@microlabs/otel-cf-workers';

// 模拟环境变量
const env = {
    AXIOM_TOKEN: process.env.AXIOM_TOKEN || 'xaat-827c7e82-40f5-4096-aecd-baa46d1c86fc',
    AXIOM_DATASET: process.env.AXIOM_DATASET || 'lb',
    NODE_ENV: 'development'
};

console.log('🧪 Axiom 日志修复测试');
console.log('========================');
console.log('环境配置:');
console.log('  AXIOM_TOKEN:', env.AXIOM_TOKEN ? '✅ 已设置' : '❌ 未设置');
console.log('  AXIOM_DATASET:', env.AXIOM_DATASET ? '✅ 已设置' : '❌ 未设置');
console.log('');

// 创建测试 handler
const testHandler = {
    async fetch(request, env, ctx) {
        console.log('📡 测试请求开始');
        
        // 模拟日志记录器行为
        const logger = {
            info: function(message, meta = {}, ctx = null) {
                const span = trace.getActiveSpan();
                console.log(`   logger.info('${message}')`);
                console.log(`   当前活跃 span: ${span ? '✅ 存在' : '❌ null'}`);
                
                if (span) {
                    console.log('   ✅ 会通过 span.addEvent 发送日志到 Axiom');
                    span.addEvent(message, {
                        ...meta,
                        'log.level': 'info',
                        'service.name': 'lb-worker-js-test'
                    });
                    return true;
                } else {
                    console.log('   ⚠️  没有活跃 span，日志不会发送到 Axiom');
                    return false;
                }
            }
        };
        
        // 记录一条测试日志
        logger.info('测试日志', { test: true, timestamp: Date.now() });
        
        return new Response('Test completed', { status: 200 });
    }
};

// 创建配置
function createConfigAxiom(env) {
    const config = {
        serviceName: 'lb-worker-js-test',
        exporter: {
            url: 'https://api.axiom.co/v1/traces',
            headers: {
                'Authorization': env?.AXIOM_TOKEN ? `Bearer ${env.AXIOM_TOKEN}` : '',
                'X-Axiom-Dataset': env?.AXIOM_DATASET || ''
            }
        }
    };
    
    console.log('🔧 配置创建:', {
        hasToken: !!env?.AXIOM_TOKEN,
        dataset: env?.AXIOM_DATASET,
        serviceName: config.serviceName
    });
    
    return config;
}

// 主测试函数
async function main() {
    console.log('\n开始 instrumentation 测试...\n');
    
    try {
        // 1. 创建配置
        const config = createConfigAxiom(env);
        console.log('✅ 配置创建成功');
        
        // 2. 创建 instrumented handler
        const instrumentedHandler = { ...testHandler };
        instrument(instrumentedHandler, config);
        console.log('✅ instrumentation 完成');
        
        // 3. 创建测试请求
        const request = new Request('http://localhost/test', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ test: true })
        });
        
        // 4. 执行请求
        console.log('\n🚀 执行 instrumented handler...');
        const response = await instrumentedHandler.fetch(request, env, {});
        
        console.log('\n✅ 测试完成');
        console.log('响应状态:', response.status);
        
    } catch (error) {
        console.log('\n❌ 测试失败:', error.message);
        console.log('错误详情:', error.stack);
    }
}

main().catch(console.error);