import { execSync } from 'child_process';
import fs from 'fs';

/**
 * AI-Driven Release Script
 * * This script:
 * 1. Runs tests first (enforced by .clinerules)
 * 2. Extracts git commits since last tag
 * 3. AI translates and optimizes to Chinese
 * 4. Prepends to CHANGELOG.md via standard-version prerelease hook
 * 5. Calls standard-version for version bumping
 */

function getGitCommits() {
  try {
    const lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0"').toString().trim();
    console.log(`Last tag: ${lastTag}`);
    
    const commits = execSync(`git log ${lastTag}..HEAD --oneline --pretty=format:"%h %s (%an)"`).toString().trim();
    
    if (!commits) {
      console.warn('⚠️  No new commits found since last tag.');
      return null;
    }
    
    return { lastTag, commits };
  } catch (error) {
    console.error('Error getting git commits:', error.message);
    return null;
  }
}

function checkDirtyWorkspace() {
  try {
    const status = execSync('git status --porcelain').toString().trim();
    if (status) {
      console.error('❌ Dirty workspace detected. Please commit or stash changes first.');
      console.log(status);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error checking git status:', error.message);
    process.exit(1);
  }
}

function generateChineseChangelog(commits) {
  console.log('\n📝 AI Translation Phase:');
  console.log('Commits to translate:');
  console.log(commits);
  console.log('\n🤖 AI: Please translate the above commits to professional Chinese and format them into CHANGELOG.md style.');
  
  const commitCount = commits.trim() ? commits.split('\n').length : 0;
  
  return `### 🤖 AI-Generated Changelog

* AI translation pending - commits: ${commitCount}
* Please manually review and format the changelog based on the commits above.`;
}

async function run() {
  console.log('🚀 Starting AI-Enhanced Release Process...\n');
  
  // 1. Check for dirty workspace
  checkDirtyWorkspace();
  
  // 2. Extract commits
  console.log('2. Extracting git commits...');
  const gitData = getGitCommits();
  
  if (!gitData) {
    console.log('⚠️  No commits to release. Aborting.');
    return;
  }
  
  // 3. AI Translation (Generate content in memory)
  console.log('3. AI Translation phase...');
  const chineseChangelog = generateChineseChangelog(gitData.commits);
  
  // 4. Integrate with standard-version via Hooks
  console.log('4. Executing standard-version with lifecycle hooks...');
  
  /**
   * 核心逻辑：
   * 将修改 CHANGELOG.md 的逻辑内联到 prerelease 钩子中。
   * process.env.AI_CHANGELOG_CONTENT 负责在进程间传递生成的日志内容。
   */
  const releaseCmd = [
    'npx standard-version',
    '--skip.changelog',
    '--commit-all',
    '--scripts.prerelease="node -e \'const fs=require(\\\"fs\\\"); const path=\\\"CHANGELOG.md\\\"; const content=process.env.AI_CHANGELOG_CONTENT; const existing=fs.readFileSync(path, \\\"utf8\\\"); const headerEnd=existing.indexOf(\\\"\\n\\n\\\", existing.indexOf(\\\"# Changelog\\\")); fs.writeFileSync(path, existing.slice(0, headerEnd + 2) + content + \\\"\\n\\n\\\" + existing.slice(headerEnd + 2));\' && git add CHANGELOG.md"'
  ].join(' ');

  try {
    execSync(releaseCmd, { 
      stdio: 'inherit',
      env: { ...process.env, AI_CHANGELOG_CONTENT: chineseChangelog }
    });
    console.log('\n✨ Release process finished successfully.');
  } catch (error) {
    console.error('\n❌ Release failed during standard-version execution.');
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(console.error);
}

export { run, getGitCommits, checkDirtyWorkspace, generateChineseChangelog };