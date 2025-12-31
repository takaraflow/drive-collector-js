#!/usr/bin/env node

/**
 * 测试修复 OpenTelemetry 导入问题
 */

// 首先检查模块是否可以正常导入
async function testModuleImport() {
    console.log('🧪 测试 OpenTelemetry 模块导入...\n');
    
    try {
        console.log('1. 测试 @opentelemetry/api 导入...');
        const { trace } = await import('@opentelemetry/api');
        console.log('   ✅ @opentelemetry/api 导入成功');
        
        console.log('\n2. 测试 @microlabs/otel-cf-workers 导入...');
        const otelCF = await import('@microlabs/otel-cf-workers');
        console.log('   ✅ @microlabs/otel-cf-workers 导入成功');
        console.log('   可用导出:', Object.keys(otelCF));
        
        return { trace, otelCF };
        
    } catch (error) {
        console.log('   ❌ 导入失败:', error.message);
        
        // 尝试直接导入 dist 文件
        try {
            console.log('\n3. 尝试直接导入 dist 文件...');
            const otelCF = await import('@microlabs/otel-cf-workers/dist/index.js');
            console.log('   ✅ 直接导入成功');
            console.log('   可用导出:', Object.keys(otelCF));
            return { otelCF };
        } catch (error2) {
            console.log('   ❌ 直接导入也失败:', error2.message);
            return null;
        }
    }
}

// 测试创建配置
function testConfigCreation() {
    console.log('\n4. 测试配置创建...');
    
    const env = {
        AXIOM_TOKEN: process.env.AXIOM_TOKEN || 'test-token',
        AXIOM_DATASET: process.env.AXIOM_DATASET || 'lb'
    };
    
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
    
    console.log('   ✅ 配置创建成功');
    console.log('   Service:', config.serviceName);
    console.log('   Exporter:', config.exporter.url);
    console.log('   Has Auth:', !!config.exporter.headers.Authorization);
    
    return config;
}

// 主测试
async function main() {
    console.log('🔧 OpenTelemetry 修复测试\n');
    
    const modules = await testModuleImport();
    
    if (modules) {
        const config = testConfigCreation();
        
        if (modules.otelCF && modules.otelCF.instrument) {
            console.log('\n5. 测试 instrumentation...');
            try {
                // 创建测试 handler
                const testHandler = {
                    async fetch(request, env, ctx) {
                        return new Response('Test', { status: 200 });
                    }
                };
                
                // 尝试 instrument
                const instrumented = modules.otelCF.instrument(testHandler, config);
                console.log('   ✅ instrumentation 成功');
                console.log('   Handler 已 instrumented:', !!instrumented.fetch);
            } catch (error) {
                console.log('   ❌ instrumentation 失败:', error.message);
            }
        } else {
            console.log('\n❌ instrument 函数不可用');
        }
    }
    
    console.log('\n========================');
    console.log('测试完成');
}

main().catch(console.error);