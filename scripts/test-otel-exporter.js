#!/usr/bin/env node

/**
 * 测试 OpenTelemetry OTLP 导出器
 */

import { trace } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET;

console.log('🧪 OpenTelemetry OTLP 导出器测试\n');

// 1. 测试不同的导出器配置
async function testExporterConfig() {
  console.log('1. 测试 OTLP 导出器配置...\n');

  // 配置1: 标准 OTLP
  const exporter1 = new OTLPTraceExporter({
    url: 'https://api.axiom.co/v1/traces',
    headers: {
      'Authorization': `Bearer ${AXIOM_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });

  console.log('配置1 - 标准 OTLP:');
  console.log('  URL:', exporter1.url);
  console.log('  Headers:', { ...exporter1.headers, Authorization: '***' });
  console.log('');

  // 配置2: 包含数据集信息
  const exporter2 = new OTLPTraceExporter({
    url: 'https://api.axiom.co/v1/traces',
    headers: {
      'Authorization': `Bearer ${AXIOM_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Axiom-Dataset': AXIOM_DATASET
    }
  });

  console.log('配置2 - 带数据集头:');
  console.log('  URL:', exporter2.url);
  console.log('  Headers:', { ...exporter2.headers, Authorization: '***' });
  console.log('');

  // 配置3: 使用 Axiom 的 OTLP 端点
  const exporter3 = new OTLPTraceExporter({
    url: `https://api.axiom.co/v1/traces`,
    headers: {
      'Authorization': `Bearer ${AXIOM_TOKEN}`,
      'X-Axiom-Dataset': AXIOM_DATASET
    }
  });

  console.log('配置3 - Axiom 特定:');
  console.log('  URL:', exporter3.url);
  console.log('  Headers:', { ...exporter3.headers, Authorization: '***' });
  console.log('');

  return [exporter1, exporter2, exporter3];
}

// 2. 测试每个导出器
async function testExporters(exporters) {
  console.log('2. 测试每个导出器...\n');

  for (let i = 0; i < exporters.length; i++) {
    console.log(`测试导出器 ${i + 1}:`);
    
    const provider = new BasicTracerProvider({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: `test-exporter-${i + 1}`,
        [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0'
      })
    });

    provider.addSpanProcessor(new SimpleSpanProcessor(exporters[i]));
    provider.register();

    const tracer = trace.getTracer(`test-${i + 1}`);

    try {
      await tracer.startActiveSpan(`test-span-${i + 1}`, async (span) => {
        span.setAttribute('test.exporter', `exporter-${i + 1}`);
        span.setAttribute('test.timestamp', Date.now());
        
        console.log(`  ✅ Span 创建: ${span.spanContext().spanId}`);
        
        // 等待一点时间让导出器发送
        await new Promise(resolve => setTimeout(resolve, 100));
        
        span.end();
        console.log(`  ✅ Span 结束`);
      });

      // 等待导出完成
      await new Promise(resolve => setTimeout(resolve, 500));
      
      console.log(`  ✅ 导出器 ${i + 1} 测试完成\n`);

    } catch (error) {
      console.log(`  ❌ 导出器 ${i + 1} 失败: ${error.message}\n`);
    }

    // 清理
    trace.disable();
  }
}

// 3. 检查 Axiom 中是否有数据
async function checkAxiomForTraces() {
  console.log('3. 检查 Axiom 中是否有 trace 数据...\n');

  await new Promise(resolve => setTimeout(resolve, 2000)); // 等待数据到达

  try {
    const query = {
      startTime: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      endTime: new Date().toISOString(),
      query: `trace | limit 5`
    };

    const response = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(query)
    });

    if (response.ok) {
      const data = await response.json();
      console.log('✅ 查询成功');
      if (data.buckets && data.buckets.length > 0) {
        console.log('📊 找到 trace 数据:');
        data.buckets.forEach((bucket, i) => {
          console.log(`  桶 ${i + 1}: ${bucket.events.length} 个事件`);
          if (bucket.events.length > 0) {
            console.log(`    示例: ${JSON.stringify(bucket.events[0]).substring(0, 100)}...`);
          }
        });
      } else {
        console.log('⚠️  没有找到 trace 数据');
      }
    } else {
      const error = await response.text();
      console.log('❌ 查询失败:', response.status, error);
    }
  } catch (error) {
    console.log('❌ 查询错误:', error.message);
  }
}

// 运行测试
async function run() {
  const exporters = await testExporterConfig();
  await testExporters(exporters);
  await checkAxiomForTraces();
  
  console.log('\n✅ 测试完成');
}

run();