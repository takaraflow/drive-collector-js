#!/usr/bin/env node

/**
 * 检查 Axiom 数据
 */

import fetch from 'node-fetch';

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET;

if (!AXIOM_TOKEN || !AXIOM_DATASET) {
  console.error('❌ 缺少环境变量');
  process.exit(1);
}

async function checkAxiom() {
  console.log('🔍 检查 Axiom 数据集...\n');
  
  try {
    // 使用 AQL 查询 (JSON 格式)
    const query = {
      startTime: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      endTime: new Date().toISOString(),
      query: `trace | where timestamp > now() - 10m | limit 10`
    };
    
    const response = await fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AXIOM_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(query)
    });

    console.log(`状态码: ${response.status}`);
    
    if (response.ok) {
      const data = await response.json();
      console.log('✅ 查询成功');
      console.log('数据:', JSON.stringify(data, null, 2));
    } else {
      const text = await response.text();
      console.log('❌ 查询失败:', response.status, text);
    }
  } catch (error) {
    console.error('❌ 错误:', error.message);
  }
}

checkAxiom();