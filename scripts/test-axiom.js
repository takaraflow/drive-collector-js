#!/usr/bin/env node

/**
 * Axiom 日志测试脚本
 * 用于验证 Axiom 配置和日志发送功能
 */

// 模拟环境变量
process.env.AXIOM_TOKEN = process.env.AXIOM_TOKEN || 'xaat-827c7e82-40f5-4096-aecd-baa46d1c86fc';
process.env.AXIOM_DATASET = process.env.AXIOM_DATASET || 'lb';
process.env.NODE_ENV = 'development';

console.log('🧪 Axiom 日志测试脚本');
console.log('========================');
console.log('环境变量检查:');
console.log('  AXIOM_TOKEN:', process.env.AXIOM_TOKEN ? '✅ 已设置' : '❌ 未设置');
console.log('  AXIOM_DATASET:', process.env.AXIOM_DATASET ? '✅ 已设置' : '❌ 未设置');
console.log('  NODE_ENV:', process.env.NODE_ENV);
console.log('');

// 测试直接发送日志到 Axiom
async function testDirectAxiomLog() {
    if (!process.env.AXIOM_TOKEN || !process.env.AXIOM_DATASET) {
        console.log('❌ 缺少 Axiom 配置，跳过直接测试');
        return;
    }

    console.log('📡 测试直接发送日志到 Axiom...');
    
    try {
        const logData = {
            timestamp: new Date().toISOString(),
            level: 'info',
            message: 'Axiom 连接测试',
            service: 'lb-worker-js',
            test: true,
            metadata: {
                environment: process.env.NODE_ENV,
                timestamp: Date.now()
            }
        };

        // 使用 Axiom 的日志 API
        const response = await fetch('https://api.axiom.co/v1/datasets', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.AXIOM_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            const datasets = await response.json();
            console.log('✅ Axiom API 连接成功');
            console.log('   可用数据集:', datasets.map(d => d.name).join(', '));
            
            // 检查指定数据集是否存在
            const targetDataset = datasets.find(d => d.name === process.env.AXIOM_DATASET);
            if (targetDataset) {
                console.log(`✅ 数据集 '${process.env.AXIOM_DATASET}' 存在`);
            } else {
                console.log(`⚠️  数据集 '${process.env.AXIOM_DATASET}' 可能不存在，但不影响测试`);
            }
        } else {
            console.log('❌ Axiom API 连接失败:', response.status, response.statusText);
            const errorText = await response.text();
            console.log('   错误详情:', errorText);
        }
    } catch (error) {
        console.log('❌ Axiom 连接测试失败:', error.message);
    }
}

// 测试 OpenTelemetry 配置
async function testOpenTelemetryConfig() {
    console.log('\n🔧 测试 OpenTelemetry 配置...');
    
    try {
        // 检查 @microlabs/otel-cf-workers 是否可用
        const otelModule = await import('@microlabs/otel-cf-workers');
        console.log('✅ @microlabs/otel-cf-workers 模块可用');
        
        // 检查 @opentelemetry/api 是否可用
        const apiModule = await import('@opentelemetry/api');
        console.log('✅ @opentelemetry/api 模块可用');
        
        // 创建测试配置
        const testConfig = {
            serviceName: 'lb-worker-js-test',
            exporter: {
                url: 'https://api.axiom.co/v1/traces',
                headers: {
                    'Authorization': process.env.AXIOM_TOKEN ? `Bearer ${process.env.AXIOM_TOKEN}` : '',
                    'X-Axiom-Dataset': process.env.AXIOM_DATASET || ''
                }
            }
        };
        
        console.log('✅ OpenTelemetry 配置创建成功');
        console.log('   Service Name:', testConfig.serviceName);
        console.log('   Exporter URL:', testConfig.exporter.url);
        console.log('   Has Auth:', !!testConfig.exporter.headers.Authorization);
        console.log('   Dataset:', testConfig.exporter.headers['X-Axiom-Dataset']);
        
    } catch (error) {
        console.log('❌ OpenTelemetry 测试失败:', error.message);
    }
}

// 测试 Native Log Ingest
async function testNativeLogIngest() {
    if (!process.env.AXIOM_TOKEN || !process.env.AXIOM_DATASET) {
        console.log('❌ 缺少 Axiom 配置，跳过 Native Log Ingest 测试');
        return;
    }

    console.log('\n📡 测试 Native Log Ingest...');
    
    try {
        const logs = [
            {
                level: 'info',
                message: 'Native log ingest test',
                timestamp: new Date().toISOString(),
                service: 'lb-worker-js',
                'service.instance.id': 'load_balancing',
                env: 'development',
                test: true,
                metadata: {
                    environment: process.env.NODE_ENV,
                    timestamp: Date.now()
                }
            },
            {
                level: 'warn',
                message: 'Test warning log',
                timestamp: new Date().toISOString(),
                service: 'lb-worker-js',
                'service.instance.id': 'load_balancing',
                env: 'development',
                test: true
            }
        ];

        const url = `https://api.axiom.co/v1/datasets/${process.env.AXIOM_DATASET}/ingest`;
        const headers = {
            'Authorization': `Bearer ${process.env.AXIOM_TOKEN}`,
            'Content-Type': 'application/json',
            'X-Axiom-Org-Id': process.env.AXIOM_ORG_ID || ''
        };

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(logs)
        });

        if (response.ok) {
            console.log('✅ Native log ingest 成功');
            
            // 等待数据到达
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // 查询验证
            const query = {
                startTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
                endTime: new Date().toISOString(),
                query: `level=info | limit 5`
            };

            const queryResponse = await fetch(`https://api.axiom.co/v1/datasets/${process.env.AXIOM_DATASET}/query`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.AXIOM_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(query)
            });

            if (queryResponse.ok) {
                const data = await queryResponse.json();
                console.log('📊 查询日志数据成功');
                if (data.buckets && data.buckets.length > 0) {
                    const events = data.buckets.flatMap(b => b.events);
                    const testLogs = events.filter(e => e.test === true);
                    console.log(`   找到 ${testLogs.length} 条测试日志`);
                    if (testLogs.length > 0) {
                        console.log(`   示例: ${JSON.stringify(testLogs[0]).substring(0, 150)}...`);
                    }
                } else {
                    console.log('⚠️  未找到日志数据 (可能需要等待)');
                }
            } else {
                const err = await queryResponse.text();
                console.log('❌ 查询失败:', queryResponse.status, err);
            }
        } else {
            const err = await response.text();
            console.log('❌ Native log ingest 失败:', response.status, err);
        }
    } catch (error) {
        console.log('❌ Native log ingest 测试失败:', error.message);
    }
}

// 主测试函数
async function main() {
    console.log('开始测试...\n');
    
    await testDirectAxiomLog();
    await testOpenTelemetryConfig();
    await testNativeLogIngest();
    
    console.log('\n========================');
    console.log('测试完成');
}

main().catch(console.error);