#!/usr/bin/env node

/**
 * 简单检查 Axiom 数据集状态
 */

import fetch from 'node-fetch';

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET;

if (!AXIOM_TOKEN || !AXIOM_DATASET) {
  console.error('❌ 缺少环境变量');
  process.exit(1);
}

async function checkDataset() {
  console.log('🔍 检查 Axiom 数据集状态...\n');
  
  try {
    // 1. 检查数据集是否存在
    const datasetsResponse = await fetch(`https://api.axiom.co/v1/datasets`, {
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Accept': 'application/json'
      }
    });

    console.log('1. 获取数据集列表...');
    if (datasetsResponse.ok) {
      const datasets = await datasetsResponse.json();
      console.log('✅ 数据集列表:', JSON.stringify(datasets, null, 2));
      
      const targetDataset = datasets.find(d => d.id === AXIOM_DATASET || d.name === AXIOM_DATASET);
      if (targetDataset) {
        console.log('✅ 找到目标数据集:', targetDataset);
      } else {
        console.log('❌ 未找到目标数据集:', AXIOM_DATASET);
      }
    } else {
      console.log('❌ 获取数据集失败:', datasetsResponse.status);
    }

    // 2. 尝试发送一个简单的日志
    console.log('\n2. 发送测试日志...');
    const testLog = {
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'Test log from check script',
      service: 'lb-worker-js-test'
    };

    const ingestResponse = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/ingest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([testLog])
    });

    if (ingestResponse.ok) {
      const result = await ingestResponse.json();
      console.log('✅ 测试日志发送成功:', result);
    } else {
      const error = await ingestResponse.text();
      console.log('❌ 测试日志发送失败:', ingestResponse.status, error);
    }

    // 3. 等待一下，然后查询
    console.log('\n3. 等待5秒后查询...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 4. 简单查询
    console.log('\n4. 查询最近日志...');
    const queryResponse = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 最近1小时
        endTime: new Date().toISOString(),
        query: `* | limit 10`
      })
    });

    if (queryResponse.ok) {
      const data = await queryResponse.json();
      console.log('✅ 查询成功:', JSON.stringify(data, null, 2));
    } else {
      const error = await queryResponse.text();
      console.log('❌ 查询失败:', queryResponse.status, error);
    }

  } catch (error) {
    console.error('❌ 错误:', error.message);
  }
}

checkDataset();