#!/usr/bin/env node

/**
 * 验证 Axiom 中是否有数据
 * 通过 Axiom API 查询最近的日志
 */

import fetch from 'node-fetch';

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET;

if (!AXIOM_TOKEN || !AXIOM_DATASET) {
  console.error('❌ 缺少环境变量');
  process.exit(1);
}

async function queryAxiom() {
  console.log('🔍 查询 Axiom 数据集...\n');
  
  try {
    // 方法1: 查询最近的 traces
    const query = {
      "startTime": new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 最近10分钟
      "endTime": new Date().toISOString(),
      "query": "trace"
    };

    const response = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(query)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ 查询失败:', response.status, errorText);
      return;
    }

    const data = await response.json();
    
    console.log('📊 查询结果:');
    console.log('='.repeat(50));
    
    if (data && data.buckets && data.buckets.length > 0) {
      console.log(`✅ 找到 ${data.buckets.length} 个数据桶`);
      
      data.buckets.forEach((bucket, index) => {
        console.log(`\n桶 ${index + 1}:`);
        console.log(`  时间: ${bucket.start}`);
        console.log(`  数量: ${bucket.events.length}`);
        
        if (bucket.events.length > 0) {
          console.log('  示例事件:');
          bucket.events.slice(0, 2).forEach((event, i) => {
            console.log(`    ${i + 1}. ${JSON.stringify(event, null, 2).substring(0, 200)}...`);
          });
        }
      });
    } else {
      console.log('⚠️  没有找到最近的数据');
      console.log('可能的原因:');
      console.log('  1. 数据还在传输中 (可能需要等待1-2分钟)');
      console.log('  2. OpenTelemetry 配置有问题');
      console.log('  3. 网络连接问题');
    }

    // 方法2: 获取数据集统计信息
    console.log('\n📊 数据集统计信息:');
    const statsResponse = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/stats`, {
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Accept': 'application/json'
      }
    });

    if (statsResponse.ok) {
      const stats = await statsResponse.json();
      console.log(`  总事件数: ${stats.numEvents || 0}`);
      console.log(`  总字节数: ${stats.numBytes || 0}`);
      console.log(`  创建时间: ${stats.created || 'N/A'}`);
    }

  } catch (error) {
    console.error('❌ 查询出错:', error.message);
  }
}

// 方法3: 检查特定的 trace ID
async function checkSpecificTrace() {
  console.log('\n🔍 检查特定 trace (如果之前测试运行过)...');
  
  // 这里可以添加具体的 trace ID 查询
  // 但我们需要先知道 trace ID
}

queryAxiom().then(() => {
  console.log('\n✅ 查询完成');
  console.log('\n💡 提示: 如果没有看到数据，请等待1-2分钟后再次运行此脚本');
});