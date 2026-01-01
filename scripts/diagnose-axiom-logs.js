/**
 * Axiom 日志诊断脚本
 * 
 * 用法:
 *   node scripts/diagnose-axiom-logs.js --env-file=.env [options]
 * 
 * 参数:
 *   --hours=N      查询最近 N 小时的日志 (默认 1)
 *   --dataset=NAME Axiom 数据集名称 (默认从环境变量 AXIOM_DATASET 获取)
 *   --env-file=PATH 指定 .env 文件路径
 * 
 * 功能:
 *   1. 查询最近 N 小时的日志，过滤 cache fallback 相关信息。
 *   2. 统计 NF 成功率、fallback 次数、平均响应时间、Top 错误码。
 *   3. 输出诊断报告。
 */

import { Axiom } from '@axiomhq/js';
import dotenv from 'dotenv';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import * as fs from 'fs';

// 解析命令行参数
export function parseArgs(args) {
  return yargs(hideBin(args))
    .option('hours', {
      type: 'number',
      description: '查询最近 N 小时的日志',
      default: 1
    })
    .option('dataset', {
      type: 'string',
      description: 'Axiom 数据集名称'
    })
    .option('env-file', {
      type: 'string',
      description: '指定的 .env 文件路径',
      default: '.env'
    })
    .help()
    .parseSync();
}

export async function runDiagnosis(options = {}) {
  const {
    argv = parseArgs(process.argv),
    env = process.env,
    axiomClient
  } = options;

  // 加载环境变量
  if (fs.existsSync(argv['env-file'])) {
    dotenv.config({ path: argv['env-file'] });
  } else if (argv['env-file'] === '.env') {
    dotenv.config(); // 尝试默认 .env
  }

  const AXIOM_TOKEN = env.AXIOM_TOKEN || process.env.AXIOM_TOKEN;
  const AXIOM_ORG_ID = env.AXIOM_ORG_ID || process.env.AXIOM_ORG_ID;
  const DATASET = argv.dataset || env.AXIOM_DATASET || process.env.AXIOM_DATASET;

  if (!AXIOM_TOKEN || !DATASET) {
    console.error('❌ Error: AXIOM_TOKEN and AXIOM_DATASET must be provided via .env or arguments.');
    if (process.env.NODE_ENV !== 'test') process.exit(1);
    throw new Error('Missing AXIOM_TOKEN or DATASET');
  }

  const axiom = axiomClient || new Axiom({
    token: AXIOM_TOKEN,
    orgId: AXIOM_ORG_ID,
  });

  const hours = argv.hours;
  const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  
  console.log(`🔍 Querying logs from ${startTime} (last ${hours}h) in dataset "${DATASET}"...`);

  try {
    // 这里的 APL (Axiom Processing Language) 查询
    // 过滤条件: 包含 cache, fallback, NF, Redis, KV, quota 等关键字
    // 假设日志中有 level, message, duration, status 等字段，以及自定义的 cache_status, fallback_reason 等
    const query = `
      ['${DATASET}']
      | where _time > datetime(${startTime})
      | extend has_cache = case(
          message contains 'cache' or message contains 'NF' or message contains 'Redis' or message contains 'KV' or message contains 'quota', true,
          false
        )
      | where has_cache == true
      | project _time, message, duration, status, level
      | order by _time desc
      | limit 1000
    `;

    const res = await axiom.query(query);

    if (!res.matches || res.matches.length === 0) {
      console.log('✅ No relevant logs found in the specified period.');
      console.log('💡 Hint: Check Worker initialization logs first. If the worker fails to start or initialize Axiom, no logs will be sent.');
      return;
    }

    const logs = res.matches;
    const totalLogs = logs.length;

    // 统计逻辑
    let nfSuccess = 0;
    let nfTotal = 0;
    let fallbackCount = 0;
    let kvQuotaExceeded = 0;
    let totalDuration = 0;
    let durationCount = 0;
    const errorCodes = {};

    logs.forEach(match => {
      const msg = match.data.message || '';
      const status = match.data.status;
      const duration = match.data.duration;

      // NF 成功率统计 (假设 message 包含 'NF Redis hit' 或类似信息)
      if (msg.includes('NF')) {
        nfTotal++;
        if (msg.includes('hit') || !msg.toLowerCase().includes('fail')) {
          nfSuccess++;
        }
      }

      // Fallback 统计
      if (msg.toLowerCase().includes('fallback')) {
        fallbackCount++;
      }

      // KV Quota 统计
      if (msg.includes('KV') && msg.includes('quota')) {
        kvQuotaExceeded++;
      }

      // Duration 统计
      if (typeof duration === 'number') {
        totalDuration += duration;
        durationCount++;
      }

      // 错误码统计
      if (status && (status >= 400)) {
        errorCodes[status] = (errorCodes[status] || 0) + 1;
      }
    });

    // 输出报告
    console.log('\n--- 📋 Axiom Diagnosis Report ---');
    console.log(`Total Relevant Logs: ${totalLogs}`);
    
    if (nfTotal > 0) {
      const nfHitRate = ((nfSuccess / nfTotal) * 100).toFixed(2);
      console.log(`NF Success Rate: ${nfHitRate}% (${nfSuccess}/${nfTotal})`);
    } else {
      console.log('NF Success Rate: N/A (No NF logs found)');
    }

    console.log(`Fallback Occurrences: ${fallbackCount}`);
    console.log(`CF KV Quota Exceeded: ${kvQuotaExceeded}`);

    if (durationCount > 0) {
      console.log(`Average Duration: ${(totalDuration / durationCount).toFixed(2)}ms`);
    }

    const topErrors = Object.entries(errorCodes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    if (topErrors.length > 0) {
      console.log('Top Error Codes:');
      topErrors.forEach(([code, count]) => {
        console.log(`  - ${code}: ${count}x`);
      });
    }

    console.log('----------------------------------\n');

  } catch (error) {
    console.error('❌ Error querying Axiom:', error.message);
    if (error.response) {
      console.error('Response details:', error.response.data);
    }
    if (process.env.NODE_ENV !== 'test') process.exit(1);
    throw error;
  }
}

// 只有在直接运行时执行
if (process.argv[1] && (process.argv[1].endsWith('diagnose-axiom-logs.js') || process.argv[1] === 'diagnose:axiom')) {
  runDiagnosis().catch(() => {});
}
