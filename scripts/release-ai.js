import { execSync } from 'child_process';
import fs from 'fs';

/**
 * AI-Driven Release Script
 * * This script:
 * 1. Runs npm test to ensure quality
 * 2. Checks workspace status
 * 3. Extracts commits and generates AI changelog
 * 4. Uses standard-version to bump version WITHOUT committing
 * 5. Syncs version to manifest.json
 * 6. Manually creates a single atomic commit with version bump and AI changelog
 */

function getGitCommits() {
  try {
    const lastTag = execSync('git describe --tags --abbrev=0 2>/dev/null || echo "v0.0.0"').toString().trim();
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
      process.exit(1);
    }
  } catch (error) {
    process.exit(1);
  }
}

function generateChineseChangelog(commits) {
  console.log('\n📝 AI Translation Phase...');
  const commitCount = commits.trim() ? commits.split('\n').length : 0;
  return `### 🤖 AI-Generated Changelog\n\n* AI translation pending - commits: ${commitCount}\n* (This content should be replaced by Roo AI)`;
}

function prependToChangelog(changelogContent) {
  const changelogPath = 'CHANGELOG.md';
  if (!fs.existsSync(changelogPath)) return;
  
  const existingContent = fs.readFileSync(changelogPath, 'utf8');
  const headerEnd = existingContent.indexOf('\n\n', existingContent.indexOf('# Changelog'));
  
  if (headerEnd !== -1) {
    const newContent = existingContent.slice(0, headerEnd + 2) + 
                      changelogContent + '\n\n' + 
                      existingContent.slice(headerEnd + 2);
    fs.writeFileSync(changelogPath, newContent);
  }
}

function getFilesToAddFromVersionrc() {
  try {
    const versionrc = JSON.parse(fs.readFileSync('.versionrc.json', 'utf8'));
    const bumpFiles = versionrc.bumpFiles.map(f => f.filename);
    // Always include CHANGELOG.md
    bumpFiles.push('CHANGELOG.md');
    return bumpFiles;
  } catch (error) {
    // Fallback to default files if .versionrc.json is missing or invalid
    console.warn('⚠️  Could not read .versionrc.json, using default files.');
    return ['package.json', 'package-lock.json', 'manifest.json', 'CHANGELOG.md'];
  }
}

function syncManifestVersion() {
  try {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const manifestJson = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
    
    if (manifestJson.version !== packageJson.version) {
      manifestJson.version = packageJson.version;
      fs.writeFileSync('manifest.json', JSON.stringify(manifestJson, null, 2) + '\n');
      console.log(`   ✓ Synced manifest.json to v${packageJson.version}`);
    }
  } catch (error) {
    console.error('❌ Failed to sync manifest.json:', error.message);
    process.exit(1);
  }
}

async function run() {
  console.log('🚀 Starting AI-Enhanced Release Process...\n');
  
  // 1. Run npm test first
  console.log('1. Running npm test...');
  try {
    execSync('npm test', { stdio: 'inherit' });
  } catch (error) {
    console.error('\n❌ Tests failed. Aborting release.');
    process.exit(1);
  }
  
  // 2. Check workspace status
  checkDirtyWorkspace();
  
  // 3. Get git commits
  const gitData = getGitCommits();
  if (!gitData) return;

  // 4. Generate AI changelog
  const chineseChangelog = generateChineseChangelog(gitData.commits);

  // 5. Bump version using standard-version (skip changelog, commit, and tag)
  console.log('\n2. Bumping version via standard-version...');
  execSync('npx standard-version --skip.changelog --skip.commit --skip.tag', { stdio: 'inherit' });

  // 6. Sync manifest.json version
  console.log('3. Syncing manifest.json version...');
  syncManifestVersion();

  // 7. Update CHANGELOG.md with AI-generated content
  console.log('4. Updating CHANGELOG.md with AI changelog...');
  prependToChangelog(chineseChangelog);

  // 8. Get new version for commit message
  const newVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;

  // 9. Get files to add from .versionrc.json
  const filesToAdd = getFilesToAddFromVersionrc();

  // 10. Create atomic commit with AI changelog
  console.log(`5. Creating atomic commit for version v${newVersion}...`);
  try {
    // Add all version-controlled files
    execSync(`git add ${filesToAdd.join(' ')}`);
    
    // Create commit with AI changelog in body
    const commitMsg = `chore(release): ${newVersion}\n\n${chineseChangelog}`;
    fs.writeFileSync('.commit_msg', commitMsg);
    execSync('git commit -F .commit_msg');
    fs.unlinkSync('.commit_msg');
    
    // Create tag
    execSync(`git tag -a v${newVersion} -m "chore(release): ${newVersion}"`);
    
    console.log(`\n✅ Successfully released v${newVersion} with AI changelog!`);
    console.log(`\n📝 Files committed:`);
    filesToAdd.forEach(file => console.log(`   - ${file}`));
  } catch (error) {
    console.error('\n❌ Failed to create git commit or tag.');
    console.error('   Rolling back changes...');
    try {
      execSync('git reset --hard HEAD');
    } catch (rollbackError) {
      console.error('   Rollback failed:', rollbackError.message);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch(console.error);
}

export { run, getGitCommits, checkDirtyWorkspace, generateChineseChangelog };