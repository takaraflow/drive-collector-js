import fs from 'fs';
import path from 'path';

// 需要清理的测试文件目录
const testDir = '__tests__';

// 需要移除的导入模式
const importPatterns = [
  /import \{.*\b(describe|test|expect|vi|it|beforeEach|afterEach|beforeAll|afterAll)\b.*\} from ["']vitest["'];?\s*\n?/g,
  /import \{.*\b(describe|test|expect|vi|it|beforeEach|afterEach|beforeAll|afterAll)\b.*\} from ['"]vitest['"];?\s*\n?/g,
];

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

// 清理单个文件的导入
function cleanImports(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const originalContent = content;
  
  // 移除冗余的 vitest 导入
  importPatterns.forEach(pattern => {
    content = content.replace(pattern, '');
  });
  
  // 如果文件内容有变化，写入文件
  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Cleaned imports: ${filePath}`);
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
  
  let cleanedCount = 0;
  testFiles.forEach(file => {
    if (cleanImports(file)) {
      cleanedCount++;
    }
  });
  
  console.log(`\n🎉 Completed! Cleaned ${cleanedCount} files.`);
}

main().catch(console.error);