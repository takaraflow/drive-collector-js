import fs from 'fs';
import path from 'path';

// 需要处理的测试文件目录
const testDir = '__tests__';

// 替换规则
function replaceMockModules(content) {
  // 1. 将顶层的 vi.unstable_mockModule 替换为 vi.mock
  // 2. 将 await vi.unstable_mockModule 替换为 await vi.doMock
  // 3. 保持其他逻辑不变
  
  // 匹配顶层的 vi.unstable_mockModule（没有 await）
  const topLevelPattern = /(^|\n)vi\.unstable_mockModule\(/gm;
  content = content.replace(topLevelPattern, '$1vi.mock(');
  
  // 匹配 await vi.unstable_mockModule
  const awaitPattern = /await vi\.unstable_mockModule\(/g;
  content = content.replace(awaitPattern, 'await vi.doMock(');
  
  return content;
}

// 递归查找所有测试文件
function findTestFiles(dir, files = []) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      findTestFiles(fullPath, files);
    } else if (item.isFile() && item.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  
  return files;
}

// 处理单个文件
function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const originalContent = content;
  
  content = replaceMockModules(content);
  
  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Replaced mock modules: ${filePath}`);
    return true;
  } else {
    console.log(`ℹ️  No changes needed: ${filePath}`);
    return false;
  }
}

// 主函数
function main() {
  console.log('🔍 Finding test files...');
  const testFiles = findTestFiles(testDir);
  console.log(`Found ${testFiles.length} test files\n`);
  
  let processedCount = 0;
  testFiles.forEach(file => {
    if (processFile(file)) {
      processedCount++;
    }
  });
  
  console.log(`\n🎉 Completed! Processed ${processedCount} files.`);
}

main().catch(console.error);