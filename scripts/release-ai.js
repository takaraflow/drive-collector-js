import { execSync } from 'child_process';
import fs from 'fs';

/**
 * AI-Driven Release Script
 * 
 * This script:
 * 1. Runs tests first (enforced by .clinerules)
 * 2. Extracts git commits since last tag
 * 3. AI translates and optimizes to Chinese
 * 4. Prepends to CHANGELOG.md
 * 5. Calls standard-version --skip.changelog for version bumping
 */

function getGitCommits() {
  try {
    // Get the last tag
    const lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0"').toString().trim();
    console.log(`Last tag: ${lastTag}`);
    
    // Get commits since last tag
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
  // AI will be triggered by Roo to generate Chinese changelog
  // This function serves as a placeholder for the AI translation logic
  // Roo AI should read the commits and generate professional Chinese changelog
  
  console.log('\n📝 AI Translation Phase:');
  console.log('Commits to translate:');
  console.log(commits);
  console.log('\n🤖 AI: Please translate the above commits to professional Chinese and format them into CHANGELOG.md style.');
  console.log('   Group by type: ✨ Features, 🐛 Bug Fixes, 🔧 Maintenance, 📝 Docs, 🚀 Performance, ✅ Testing');
  
  // Count commits (handle empty string)
  const commitCount = commits.trim() ? commits.split('\n').length : 0;
  
  // For now, return a placeholder that will be replaced by AI
  return `### 🤖 AI-Generated Changelog

* AI translation pending - commits: ${commitCount}
* Please manually review and format the changelog based on the commits above.`;
}

function prependToChangelog(changelogContent) {
  const changelogPath = 'CHANGELOG.md';
  
  if (!fs.existsSync(changelogPath)) {
    console.error('❌ CHANGELOG.md not found');
    process.exit(1);
  }
  
  const existingContent = fs.readFileSync(changelogPath, 'utf8');
  
  // Find the header position
  const headerEnd = existingContent.indexOf('\n\n', existingContent.indexOf('# Changelog'));
  
  if (headerEnd === -1) {
    console.error('❌ Could not find CHANGELOG.md header');
    process.exit(1);
  }
  
  // Insert after header
  const newContent = existingContent.slice(0, headerEnd + 2) + 
                    changelogContent + '\n\n' + 
                    existingContent.slice(headerEnd + 2);
  
  fs.writeFileSync(changelogPath, newContent);
  console.log('✅ CHANGELOG.md updated with AI-generated content');
}

async function run() {
  console.log('🚀 Starting AI-Enhanced Release Process...\n');
  
  // 1. Check for dirty workspace
  console.log('1. Checking workspace status...');
  checkDirtyWorkspace();
  
  // 2. Run tests (already handled by package.json script)
  console.log('2. Tests will be run by npm script...');
  
  // 3. Extract commits
  console.log('3. Extracting git commits...');
  const gitData = getGitCommits();
  
  if (!gitData) {
    console.log('⚠️  No commits to release. Aborting.');
    return;
  }
  
  // 4. AI Translation (Roo will handle this)
  console.log('4. AI Translation phase...');
  const chineseChangelog = generateChineseChangelog(gitData.commits);
  
  // 5. Update CHANGELOG.md
  console.log('5. Updating CHANGELOG.md...');
  prependToChangelog(chineseChangelog);
  
  console.log('\n✅ AI changelog generation completed!');
  console.log('6. Staging CHANGELOG.md and committing via standard-version...');
  
  // 先 add，然后调用不带 --skip.changelog 的 standard-version
  // standard-version 会自动 commit 暂存区的内容并更新 package.json
  execSync('git add CHANGELOG.md'); 
  execSync('npx standard-version --commit-all', { stdio: 'inherit' }); 
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(console.error);
}

export { run, getGitCommits, checkDirtyWorkspace, generateChineseChangelog, prependToChangelog };