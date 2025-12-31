#!/usr/bin/env node

/**
 * 最终解决方案测试
 * 验证 OpenTelemetry + Axiom 集成
 */

import { trace } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import fetch from 'node-fetch';

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET;

console.log('🧪 最终解决方案测试\n');
console.log('环境配置:');
console.log('  AXIOM_TOKEN:', AXIOM_TOKEN ? '✅ 已设置' : '❌ 缺失');
console.log('  AXIOM_DATASET:', AXIOM_DATASET || '❌ 缺失');
console.log('');

async function testSolution() {
  // 1. 配置 OpenTelemetry
  console.log('1. 配置 OpenTelemetry...');
  
  const exporter = new OTLPTraceExporter({
    url: 'https://api.axiom.co/v1/traces',
    headers: {
      'Authorization': `Bearer ${AXIOM_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Axiom-Dataset': AXIOM_DATASET
    }
  });

  const provider = new BasicTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: 'lb-worker-js-final',
      [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0'
    })
  });

  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  provider.register();
  trace.setGlobalTracerProvider(provider);

  console.log('   ✅ OpenTelemetry 配置完成');

  // 2. 创建并发送 trace
  console.log('\n2. 创建并发送 trace...');
  
  const tracer = trace.getTracer('final-test');
  
  await tracer.startActiveSpan('webhook-handler', async (span) => {
    span.setAttribute('http.method', 'POST');
    span.setAttribute('http.url', 'http://localhost:8787/api/webhook');
    span.setAttribute('http.status_code', 200);
    span.setAttribute('custom.field', 'test-value');
    
    console.log(`   ✅ Span 创建: ${span.spanContext().spanId}`);
    
    // 模拟处理时间
    await new Promise(resolve => setTimeout(resolve, 100));
    
    span.end();
    console.log('   ✅ Span 已结束');
  });

  // 3. 发送普通日志作为备份
  console.log('\n3. 发送普通日志作为备份...');
  
  const logData = [
    {
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'Final solution test - webhook handler',
      service: 'lb-worker-js-final',
      traceId: 'final-' + Date.now(),
      http: {
        method: 'POST',
        url: 'http://localhost:8787/api/webhook',
        status: 200
      }
    }
  ];

  try {
    const response = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/ingest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(logData)
    });

    if (response.ok) {
      const result = await response.json();
      console.log('   ✅ 普通日志发送成功:', result.ingested, '条');
    } else {
      console.log('   ⚠️ 普通日志发送失败:', response.status);
    }
  } catch (error) {
    console.log('   ⚠️ 普通日志发送错误:', error.message);
  }

  // 4. 等待数据处理
  console.log('\n4. 等待数据处理 (3秒)...');
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 5. 验证结果
  console.log('\n5. 验证结果...');
  console.log('   请手动检查 Axiom 控制台:');
  console.log('   - 数据集:', AXIOM_DATASET);
  console.log('   - 时间范围: 最近 10 分钟');
  console.log('   - 查询: trace 或 service = "lb-worker-js-final"');
  console.log('');
  console.log('📊 如果在 Axiom 中看到数据，说明集成成功！');

  // 6. 提供调试信息
  console.log('\n6. 调试信息:');
  console.log('   如果没有数据，请检查:');
  console.log('   1. AXIOM_TOKEN 是否正确');
  console.log('   2. AXIOM_DATASET 是否存在');
  console.log('   3. 网络连接是否正常');
  console.log('   4. Axiom API 是否有临时问题');
  console.log('');
  console.log('✅ 测试完成！');
}

// 运行测试
if (!AXIOM_TOKEN || !AXIOM_DATASET) {
  console.log('❌ 缺少必需的环境变量');
  process.exit(1);
}

testSolution().catch(error => {
  console.error('❌ 测试失败:', error);
  process.exit(1);
});