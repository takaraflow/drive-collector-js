import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * AI 版本发布助手
 * 逻辑：
 * 1. 检查当前版本
 * 2. 执行 standard-version
 * 3. 获取新增的 Changelog
 * 4. 如果是大版本变更，或者需要 AI 润色，提示 AI 处理
 */

const exec = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

async function main() {
  try {
    // 1. 检查 Git 状态
    const status = exec('git status --porcelain');
    if (status) {
      console.log('⚠️ 发现未提交的更改，请先提交或 stash。');
      // 这里不强制退出，由 AI 决定是否继续，但在脚本中建议先 commit
    }

    // 2. 获取旧版本号
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const oldVersion = pkg.version;
    console.log(`Current version: ${oldVersion}`);

    // 3. 执行 standard-version
    // 注意：这里我们只生成，不自动 commit，以便 AI 可以修改 CHANGELOG
    console.log('🚀 Running standard-version...');
    // 如果用户手动改了 package.json 的大版本号，standard-version 会识别并更新 tag
    exec('npx standard-version');

    // 4. 获取更新后的版本号
    const newPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const newVersion = newPkg.version;
    console.log(`New version: ${newVersion}`);

    // 5. 判断是否是大版本变更
    const isMajor = oldVersion.split('.')[0] !== newVersion.split('.')[0];
    
    console.log('\n--- 📝 Changelog 已更新 ---');
    console.log('请 Cline (AI) 执行以下操作：');
    if (isMajor) {
      console.log('🚩 检测到【大版本】变更！');
      console.log('请 AI 重新扫描本次大版本周期内的 Git Log，并将琐碎的小版本记录合并为模块化的中文功能点。');
    } else {
      console.log('✨ 检测到小版本/补丁变更。');
      console.log('请 AI 润色 CHANGELOG.md 中新增的条目，确保其为通俗易懂的中文业务描述。');
    }

    console.log('\n完成后，请手动或由 AI 执行: git add . && git commit --amend --no-edit && git tag -f v' + newVersion);
    
  } catch (error) {
    console.error('❌ Release 失败:', error.message);
    process.exit(1);
  }
}

main();