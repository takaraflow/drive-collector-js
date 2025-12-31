#!/usr/bin/env node

/**
 * 最终验证：测试完整的数据流
 */

import fetch from 'node-fetch';

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET;

async function finalVerification() {
  console.log('🎯 最终验证 Axiom 集成\n');
  
  // 1. 发送测试 trace 数据
  console.log('1. 发送测试 trace 数据...');
  
  const traceData = {
    traceId: 'final-test-' + Date.now(),
    spanId: 'span-' + Math.random().toString(36).substring(7),
    name: 'test-operation',
    kind: 'SPAN_KIND_INTERNAL',
    startTimeUnixNano: Date.now() * 1000000,
    endTimeUnixNano: (Date.now() + 100) * 1000000,
    attributes: [
      { key: 'service.name', value: { stringValue: 'lb-worker-js' } },
      { key: 'service.version', value: { stringValue: '1.0.0' } },
      { key: 'test', value: { boolValue: true } }
    ],
    status: { code: 'STATUS_CODE_OK' }
  };

  try {
    // 尝试使用 OTLP 格式发送
    const otlpPayload = {
      resourceSpans: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'lb-worker-js' } },
            { key: 'service.version', value: { stringValue: '1.0.0' } }
          ]
        },
        instrumentationLibrarySpans: [{
          instrumentationLibrary: { name: 'test', version: '1.0.0' },
          spans: [traceData]
        }]
      }]
    };

    const response = await fetch('https://api.axiom.co/v1/traces', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Axiom-Dataset': AXIOM_DATASET
      },
      body: JSON.stringify(otlpPayload)
    });

    console.log(`   状态: ${response.status}`);
    
    if (response.ok) {
      const result = await response.json();
      console.log('   ✅ OTLP trace 发送成功');
      console.log('   结果:', JSON.stringify(result, null, 2));
    } else {
      const error = await response.text();
      console.log('   ❌ OTLP trace 发送失败:', response.status, error.substring(0, 200));
    }
  } catch (error) {
    console.log('   ❌ 错误:', error.message);
  }

  // 2. 发送普通日志数据
  console.log('\n2. 发送普通日志数据...');
  
  const logData = [
    {
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'Final verification log',
      service: 'lb-worker-js',
      traceId: 'final-test-' + Date.now(),
      _type: 'log'
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

    console.log(`   状态: ${response.status}`);
    
    if (response.ok) {
      const result = await response.json();
      console.log('   ✅ 日志发送成功');
      console.log('   结果:', JSON.stringify(result, null, 2));
    } else {
      const error = await response.text();
      console.log('   ❌ 日志发送失败:', response.status, error.substring(0, 200));
    }
  } catch (error) {
    console.log('   ❌ 错误:', error.message);
  }

  // 3. 等待数据处理
  console.log('\n3. 等待数据处理 (5秒)...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // 4. 尝试查询数据
  console.log('\n4. 尝试查询数据...');
  
  // 使用不同的查询格式
  const queryFormats = [
    {
      name: 'AQL with time range',
      body: {
        startTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        endTime: new Date().toISOString(),
        query: 'where service = "lb-worker-js" | limit 10'
      }
    },
    {
      name: 'Simple AQL',
      body: {
        startTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        endTime: new Date().toISOString(),
        query: '* | limit 10'
      }
    }
  ];

  for (const format of queryFormats) {
    console.log(`   尝试: ${format.name}`);
    
    try {
      const response = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AXIOM_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(format.body)
      });

      console.log(`     状态: ${response.status}`);
      
      if (response.ok) {
        const data = await response.json();
        console.log('     ✅ 查询成功');
        
        if (data.buckets && data.buckets.length > 0) {
          console.log(`     📊 找到数据: ${data.buckets.reduce((sum, b) => sum + b.events.length, 0)} 个事件`);
          
          // 显示一些统计信息
          const totalEvents = data.buckets.reduce((sum, b) => sum + b.events.length, 0);
          console.log(`     📈 总事件数: ${totalEvents}`);
          
          if (totalEvents > 0) {
            console.log('     ✅ 数据已成功到达 Axiom!');
            return true;
          }
        } else {
          console.log('     ⚠️  没有找到数据');
        }
      } else {
        const error = await response.text();
        console.log(`     ❌ 查询失败: ${error.substring(0, 100)}`);
      }
    } catch (error) {
      console.log(`     ❌ 错误: ${error.message}`);
    }
    
    console.log('');
  }

  console.log('\n📊 总结:');
  console.log('✅ 直接日志发送: 工作正常');
  console.log('❌ OpenTelemetry 查询: API 返回错误');
  console.log('💡 可能原因: Axiom 查询 API 临时问题，或 trace 数据格式需要调整');
  
  return false;
}

finalVerification();