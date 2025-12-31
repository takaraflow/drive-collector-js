#!/usr/bin/env node

/**
 * 检查 Axiom 中的 trace 数据
 */

import fetch from 'node-fetch';

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET;

async function checkTraces() {
  console.log('🔍 检查 Axiom trace 数据...\n');
  
  // 尝试不同的查询方式
  const queries = [
    {
      name: '简单 trace 查询',
      body: {
        startTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        endTime: new Date().toISOString(),
        query: 'trace'
      }
    },
    {
      name: '所有数据',
      body: {
        startTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        endTime: new Date().toISOString(),
        query: '*'
      }
    },
    {
      name: '最近数据',
      body: {
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        endTime: new Date().toISOString(),
        query: 'where timestamp > now() - 1h | limit 20'
      }
    }
  ];

  for (const q of queries) {
    console.log(`尝试: ${q.name}`);
    
    try {
      const response = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${AXIOM_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(q.body)
      });

      console.log(`  状态: ${response.status}`);
      
      if (response.ok) {
        const data = await response.json();
        console.log('  ✅ 成功');
        
        if (data.buckets && data.buckets.length > 0) {
          console.log(`  📊 找到 ${data.buckets.length} 个数据桶`);
          data.buckets.forEach((bucket, i) => {
            console.log(`    桶 ${i + 1}: ${bucket.events.length} 个事件`);
            if (bucket.events.length > 0) {
              // 显示第一个事件的部分信息
              const firstEvent = bucket.events[0];
              const keys = Object.keys(firstEvent).slice(0, 5);
              console.log(`      字段: ${keys.join(', ')}`);
              if (firstEvent.traceId) {
                console.log(`      Trace ID: ${firstEvent.traceId}`);
              }
              if (firstEvent.name) {
                console.log(`      Span 名称: ${firstEvent.name}`);
              }
            }
          });
        } else {
          console.log('  ⚠️  没有数据');
        }
      } else {
        const error = await response.text();
        console.log(`  ❌ 失败: ${error.substring(0, 200)}`);
      }
    } catch (error) {
      console.log(`  ❌ 错误: ${error.message}`);
    }
    
    console.log('');
  }

  // 尝试使用 AQL 直接查询
  console.log('尝试 AQL 直接查询...');
  try {
    const aqlResponse = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: 'trace | limit 10'
      })
    });

    console.log(`  状态: ${aqlResponse.status}`);
    
    if (aqlResponse.ok) {
      const data = await aqlResponse.json();
      console.log('  ✅ AQL 成功');
      console.log('  数据:', JSON.stringify(data, null, 2).substring(0, 500));
    } else {
      const error = await aqlResponse.text();
      console.log(`  ❌ AQL 失败: ${error.substring(0, 200)}`);
    }
  } catch (error) {
    console.log(`  ❌ AQL 错误: ${error.message}`);
  }
}

checkTraces();