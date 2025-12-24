import { execSync } from 'child_process';

/**
 * 执行发布准备工作
 * @param {Object} options - 选项
 * @param {Function} options.execSync - execSync 函数 (用于测试时注入mock)
 * @param {Function} options.exit - process.exit 函数 (用于测试时注入mock)
 * @param {Object} options.console - console 对象 (用于测试时注入mock)
 * @returns {Promise<void>}
 */
export async function prepareRelease(options = {}) {
  const {
    execSync: execSyncFn = execSync,
    exit = process.exit,
    console: consoleObj = console
  } = options;

  try {
    // 1. 预检：确保当前没有未提交的代码，防止污染发布 Commit
    const status = execSyncFn('git status --porcelain').toString();
    if (status) {
      consoleObj.error('❌ 错误: 请先提交或 stash 当前改动后再发版。');
      exit(1);
      return; // 确保函数在这里返回，不继续执行
    }

    consoleObj.log('🔍 正在准备版本文件 (不触发提交)...');

    /**
     * 2. 执行 standard-version 但跳过 commit 和 tag
     * 这样它只会修改 package.json 和生成 CHANGELOG.md (此时是英文)
     */
    execSyncFn('npx standard-version --skip.commit --skip.tag', { stdio: 'inherit' });

    consoleObj.log('\n✅ 文件更新完成。');
    consoleObj.log('🤖 [AI 任务]: 请现在读取 CHANGELOG.md，将最新的英文部分润色为中文。');
    consoleObj.log('🤖 [AI 任务]: 润色完成后，请获取新版本号并执行原子化提交指令。');

  } catch (error) {
    consoleObj.error('❌ 脚本执行失败:', error.message);
    exit(1);
  }
}

// 如果直接运行此脚本，则执行main函数
if (import.meta.url === `file://${process.argv[1]}`) {
  prepareRelease();
}