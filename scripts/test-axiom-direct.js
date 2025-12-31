#!/usr/bin/env node

/**
 * 直接测试 Axiom 数据发送
 */

import fetch from 'node-fetch';

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;

// 使用正确的数据集 ID
const AXIOM_DATASET_ID = 'lb';

async function testDirect() {
  console.log('🧪 直接测试 Axiom 数据发送\n');
  
  // 测试数据
  const testData = [
    {
      timestamp: new Date().toISOString(),
      level: 'info',
      message: 'Direct test from Node.js',
      service: 'lb-worker-js',
      traceId: 'test-' + Date.now()
    }
  ];

  console.log('发送数据:', JSON.stringify(testData, null, 2));
  console.log('到数据集:', AXIOM_DATASET_ID);
  console.log('使用 Token:', AXIOM_TOKEN ? '***' : 'MISSING');
  console.log('');

  try {
    const response = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET_ID}/ingest`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testData)
    });

    console.log('响应状态:', response.status);
    
    if (response.ok) {
      const result = await response.json();
      console.log('✅ 成功!');
      console.log('结果:', JSON.stringify(result, null, 2));
    } else {
      const errorText = await response.text();
      console.log('❌ 失败!');
      console.log('错误:', response.status, errorText);
    }
  } catch (error) {
    console.log('❌ 请求错误:', error.message);
  }
}

testDirect();