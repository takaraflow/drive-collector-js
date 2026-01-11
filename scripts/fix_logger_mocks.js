import fs from 'fs';
import path from 'path';

// 需要处理的测试文件目录
const testDir = '__tests__';

// 完善 Logger Mock 的函数
function fixLoggerMock(content) {
  // 查找 Logger Mock 的模式
  const loggerMockPattern = /vi\.mock\(['"]\.\.\/\.\.\/src\/services\/logger\.js['"],\s*\(\)\s*=>\s*\{([^}]+)\}\s*\)/g;
  
  // 查找包含 logger 对象的 mock
  const loggerObjectPattern = /logger:\s*\{[^}]+\}/g;
  
  // 检查是否需要添加 withModule 和 withContext
  const needsWithModule = !content.includes('withModule');
  const needsWithContext = !content.includes('withContext');
  
  if (needsWithModule || needsWithContext) {
    // 替换 Logger Mock 以包含完整的方法
    content = content.replace(
      /vi\.mock\(['"]\.\.\/\.\.\/src\/services\/logger\.js['"],\s*\(\)\s*=>\s*\{([^}]+)\}\s*\)/g,
      (match, innerContent) => {
        // 检查是否已经有 logger 对象
        if (innerContent.includes('logger:')) {
          // 添加缺失的方法
          let updatedContent = innerContent;
          
          if (needsWithModule && !innerContent.includes('withModule')) {
            updatedContent = updatedContent.replace(
              /logger:\s*\{([^}]+)\}/,
              (loggerMatch, loggerContent) => {
                const hasComma = loggerContent.trim().endsWith(',');
                return `logger: {${loggerContent}${hasComma ? '' : ','} withModule: vi.fn().mockReturnThis(), withContext: vi.fn().mockReturnThis() }`;
              }
            );
          }
          
          if (needsWithContext && !innerContent.includes('withContext')) {
            // 确保 withContext 也存在
            if (!updatedContent.includes('withContext')) {
              updatedContent = updatedContent.replace(
                /withModule:\s*vi\.fn\(\)\.mockReturnThis\(\)/,
                'withModule: vi.fn().mockReturnThis(), withContext: vi.fn().mockReturnThis()'
              );
            }
          }
          
          return `vi.mock('../../src/services/logger.js', () => {${updatedContent}})`;
        }
        
        // 如果没有 logger 对象，创建完整的 mock
        return `vi.mock('../../src/services/logger.js', () => ({
          logger: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            configure: vi.fn(),
            isInitialized: vi.fn(() => true),
            canSend: vi.fn(() => true),
            withModule: vi.fn().mockReturnThis(),
            withContext: vi.fn().mockReturnThis()
          },
          default: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            configure: vi.fn(),
            isInitialized: vi.fn(() => true),
            canSend: vi.fn(() => true),
            withModule: vi.fn().mockReturnThis(),
            withContext: vi.fn().mockReturnThis()
          }
        }))`;
      }
    );
  }
  
  // 处理使用 default 导出的模式
  if (content.includes("default: mockLogger") && needsWithModule) {
    // 查找 mockLogger 定义
    const mockLoggerPattern = /const mockLogger = \{([^}]+)\}/g;
    content = content.replace(mockLoggerPattern, (match, inner) => {
      const hasWithModule = inner.includes('withModule');
      const hasWithContext = inner.includes('withContext');
      
      if (!hasWithModule || !hasWithContext) {
        let updatedInner = inner;
        if (!hasWithModule) {
          updatedInner += ', withModule: vi.fn().mockReturnThis()';
        }
        if (!hasWithContext) {
          updatedInner += ', withContext: vi.fn().mockReturnThis()';
        }
        return `const mockLogger = {${updatedInner}}`;
      }
      return match;
    });
  }
  
  // 处理 logger 对象直接定义的模式
  const loggerDirectPattern = /const mockLogger = \{[^}]+\}/;
  if (loggerDirectPattern.test(content)) {
    content = content.replace(loggerDirectPattern, (match) => {
      if (!match.includes('withModule')) {
        const inner = match.replace('const mockLogger = {', '').replace('}', '');
        return `const mockLogger = {${inner}, withModule: vi.fn().mockReturnThis(), withContext: vi.fn().mockReturnThis() }`;
      }
      return match;
    });
  }
  
  // 处理 vi.mock 中直接定义 logger 对象的模式
  content = content.replace(
    /vi\.mock\(['"]\.\.\/\.\.\/src\/services\/logger\.js['"],\s*\(\)\s*=>\s*\(([^)]+)\)\s*\)/g,
    (match, inner) => {
      if (inner.includes('logger:') && !inner.includes('withModule')) {
        return match.replace(
          /logger:\s*\{([^}]+)\}/,
          (loggerMatch, loggerContent) => {
            const hasComma = loggerContent.trim().endsWith(',');
            return `logger: {${loggerContent}${hasComma ? '' : ','} withModule: vi.fn().mockReturnThis(), withContext: vi.fn().mockReturnThis() }`;
          }
        );
      }
      return match;
    }
  );
  
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
  
  content = fixLoggerMock(content);
  
  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Fixed Logger Mock: ${filePath}`);
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
  
  console.log(`\n🎉 Completed! Fixed Logger Mock in ${processedCount} files.`);
}

main().catch(console.error);