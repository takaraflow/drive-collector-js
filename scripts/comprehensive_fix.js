import fs from 'fs';
import path from 'path';

// 需要处理的测试文件目录
const testDir = '__tests__';

// 修复 RedisCache.test.js 中的 mockRedisConstructor 问题
function fixRedisCacheTest(content, filePath) {
  if (filePath.includes('RedisCache.test.js')) {
    // 替换 mockRedisConstructor.mock.calls = [] 为 mockRedisConstructor.mockClear()
    content = content.replace(
      /mockRedisConstructor\.mock\.calls\s*=\s*\[\];/g,
      'mockRedisConstructor.mockClear();'
    );
    
    // 确保 mockRedisConstructor 有 mockClear 方法
    if (!content.includes('mockRedisConstructor.mockClear')) {
      content = content.replace(
        /const resetRedisClientMocks = \(\) => {/,
        `const resetRedisClientMocks = () => {
  if (mockRedisConstructor.mock) {
    mockRedisConstructor.mockClear();
  }`
      );
    }
  }
  return content;
}

// 修复 Logger Mock 缺少 withModule 和 withContext 的问题
function fixLoggerMockMethods(content) {
  // 查找 Logger Mock 定义
  const loggerMockPattern = /vi\.(doMock|mock)\(['"]\.\.\/\.\.\/src\/services\/logger\.js['"],\s*\(\)\s*=>\s*\(([^)]+)\)\s*\)/g;
  
  content = content.replace(loggerMockPattern, (match, mockType, inner) => {
    // 检查是否包含 withModule 和 withContext
    if (!inner.includes('withModule') || !inner.includes('withContext')) {
      // 添加缺失的方法
      let updatedInner = inner;
      
      // 处理 logger 对象
      if (updatedInner.includes('logger:')) {
        updatedInner = updatedInner.replace(
          /logger:\s*\{([^}]+)\}/,
          (loggerMatch, loggerContent) => {
            // 检查是否已有这些方法
            const hasWithModule = loggerContent.includes('withModule');
            const hasWithContext = loggerContent.includes('withContext');
            
            if (!hasWithModule || !hasWithContext) {
              let newContent = loggerContent;
              if (!hasWithModule) {
                newContent += ', withModule: vi.fn().mockReturnThis()';
              }
              if (!hasWithContext) {
                newContent += ', withContext: vi.fn().mockReturnThis()';
              }
              return `logger: {${newContent}}`;
            }
            return loggerMatch;
          }
        );
      }
      
      // 处理 default 对象
      if (updatedInner.includes('default:')) {
        updatedInner = updatedInner.replace(
          /default:\s*\{([^}]+)\}/,
          (defaultMatch, defaultContent) => {
            const hasWithModule = defaultContent.includes('withModule');
            const hasWithContext = defaultContent.includes('withContext');
            
            if (!hasWithModule || !hasWithContext) {
              let newContent = defaultContent;
              if (!hasWithModule) {
                newContent += ', withModule: vi.fn().mockReturnThis()';
              }
              if (!hasWithContext) {
                newContent += ', withContext: vi.fn().mockReturnThis()';
              }
              return `default: {${newContent}}`;
            }
            return defaultMatch;
          }
        );
      }
      
      return `vi.${mockType}('../../src/services/logger.js', () => (${updatedInner}))`;
    }
    return match;
  });
  
  // 处理使用对象字面量的模式
  const loggerObjectPattern = /vi\.(doMock|mock)\(['"]\.\.\/\.\.\/src\/services\/logger\.js['"],\s*\(\)\s*=>\s*\{([^}]+)\}\s*\)/g;
  
  content = content.replace(loggerObjectPattern, (match, mockType, inner) => {
    if (inner.includes('logger:') && (!inner.includes('withModule') || !inner.includes('withContext'))) {
      // 添加缺失的方法到 logger 对象
      return `vi.${mockType}('../../src/services/logger.js', () => {
${inner.replace(
  /logger:\s*\{([^}]+)\}/,
  (loggerMatch, loggerContent) => {
    const hasWithModule = loggerContent.includes('withModule');
    const hasWithContext = loggerContent.includes('withContext');
    
    if (!hasWithModule || !hasWithContext) {
      let newContent = loggerContent;
      if (!hasWithModule) {
        newContent += ', withModule: vi.fn().mockReturnThis()';
      }
      if (!hasWithContext) {
        newContent += ', withContext: vi.fn().mockReturnThis()';
      }
      return `logger: {${newContent}}`;
    }
    return loggerMatch;
  }
)})`;
    }
    return match;
  });
  
  return content;
}

// 修复 StringSession 构造函数问题
function fixStringSessionMock(content) {
  // 查找 StringSession mock
  const stringSessionPattern = /vi\.mock\(['"]telegram\/sessions\/index\.js['"],\s*\(\)\s*=>\s*\(([^)]+)\)\s*\)/g;
  
  content = content.replace(stringSessionPattern, (match, inner) => {
    if (inner.includes('StringSession:')) {
      // 确保 StringSession 是构造函数
      return match.replace(
        /StringSession:\s*vi\.fn\(\)\.mockImplementation\(\(sessionString\) => \(([^)]+)\)\)/,
        (fnMatch, objContent) => {
          // 改为返回一个可实例化的对象
          return `StringSession: vi.fn().mockImplementation(function(sessionString) {
            return {
              save: vi.fn().mockReturnValue(sessionString || "mock_session"),
              setDC: vi.fn()
            };
          })`;
        }
      );
    }
    return match;
  });
  
  // 处理使用箭头函数返回对象的模式
  content = content.replace(
    /StringSession:\s*vi\.fn\(\)\.mockImplementation\(\(sessionString\) => \(\{[^}]+\}\)\)/g,
    `StringSession: vi.fn().mockImplementation(function(sessionString) {
      return {
        save: vi.fn().mockReturnValue(sessionString || "mock_session"),
        setDC: vi.fn()
      };
    })`
  );
  
  return content;
}

// 修复 UploadMock 问题
function fixUploadMock(content) {
  // 查找 Upload mock
  const uploadPattern = /const \{ Upload: UploadMock \} = await import\('@aws-sdk\/lib-storage'\);[\s\S]*?UploadMock\.mockReturnValue\(mockUpload\);/;
  
  if (uploadPattern.test(content)) {
    content = content.replace(
      uploadPattern,
      `const { Upload: UploadMock } = await import('@aws-sdk/lib-storage');
    // UploadMock is already a mock function from external-mocks.js
    // Just ensure it returns our mock
    if (typeof UploadMock.mockReturnValue === 'function') {
      UploadMock.mockReturnValue(mockUpload);
    }`
    );
  }
  
  return content;
}

// 修复 fs mock 缺少 default 导出的问题
function fixFsMock(content) {
  // 查找 fs mock
  const fsPattern = /vi\.mock\(['"]fs['"],\s*\(\)\s*=>\s*\(([^)]+)\)\s*\)/g;
  
  content = content.replace(fsPattern, (match, inner) => {
    if (!inner.includes('default:')) {
      // 添加 default 导出
      return match.replace(
        /\)\s*\)/,
        `, default: ${inner.replace(/^\s*\(/, '').replace(/\)\s*$/, '')} })`
      );
    }
    return match;
  });
  
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
  
  // 应用所有修复
  content = fixRedisCacheTest(content, filePath);
  content = fixLoggerMockMethods(content);
  content = fixStringSessionMock(content);
  content = fixUploadMock(content);
  content = fixFsMock(content);
  
  if (content !== originalContent) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`✅ Fixed: ${filePath}`);
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
  
  console.log(`\n🎉 Completed! Fixed ${processedCount} files.`);
}

main().catch(console.error);