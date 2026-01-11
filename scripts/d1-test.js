#!/usr/bin/env node
import { d1 } from '../src/services/d1.js';
import { logger } from '../src/services/logger/index.js';

async function main() {
  console.log('🔍 D1 诊断脚本');
  
  // 1. 检查配置
  console.log('1. 检查配置...');
  if (!d1.accountId || !d1.databaseId || !d1.token) {
    console.error('❌ 配置缺失');
    console.error(`   Account ID: ${d1.accountId ? 'OK' : 'MISSING'}`);
    console.error(`   Database ID: ${d1.databaseId ? 'OK' : 'MISSING'}`);
    console.error(`   Token: ${d1.token ? 'OK' : 'MISSING'}`);
    process.exit(1);
  }
  console.log('✅ 配置完整');
  
  // 2. 健康检查
  console.log('\n2. 连通性检查 (SELECT 1)...');
  try {
    await d1.healthCheck();
    console.log('✅ API 连通性 OK');
  } catch (e) {
    console.error('❌ API 失败:', e.message);
    // 这里不退出，尝试后续步骤可能提供更多线索
  }
  
  // 3. 测试 drives 表
  console.log('\n3. 表结构检查 (drives)...');
  try {
    const drives = await d1.fetchAll('SELECT COUNT(*) as count FROM drives');
    console.log('✅ drives 表 OK, 记录数:', drives[0]?.count || 0);
  } catch (e) {
    console.error('❌ drives 表问题:', e.message);
    if (e.message.includes('no such table')) {
        console.error('   提示: 请确认数据库迁移是否已执行 (npm run db:migrate)');
    }
  }
  
  // 4. 重现错误 SQL (模拟查询)
  console.log('\n4. 模拟业务查询 (findByUserId)...');
  try {
    // 使用一个肯定不存在的用户 ID，只测试 SQL 语法和权限
    await d1.fetchOne('SELECT * FROM drives WHERE user_id = ? AND status = \'active\' LIMIT 1', ['test-diagnostic-user']);
    console.log('✅ 示例查询执行成功 (无结果返回是正常的)');
  } catch (e) {
    console.error('❌ 查询执行失败:', e.message);
  }

  // 5. 模拟 400 错误 (如果使用了 --mock 参数或者手动构造错误查询)
  if (process.argv.includes('--test-400')) {
      console.log('\n5. 强制触发 400 错误 (测试错误解析)...');
      try {
          // 故意构造错误 SQL
          await d1.fetchOne('SELECT * FROM non_existent_table');
      } catch (e) {
          console.log('✅ 捕获到错误 (预期):');
          console.log(`   Message: ${e.message}`);
      }
  }
}

main().catch(error => {
    console.error('❌ 脚本执行异常:', error);
    process.exit(1);
});
