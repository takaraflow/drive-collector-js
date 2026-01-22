#!/usr/bin/env node

/**
 * Changed Packages Detector
 * 检测变更的包/模块，用于决定需要运行哪些测试
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

class ChangedPackagesDetector {
  constructor() {
    this.projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    this.changedPackages = new Set();
    this.changedFiles = [];
  }

  /**
   * 获取变更的文件列表
   */
  getChangedFiles() {
    console.log('🔍 获取变更文件列表...');
    
    try {
      // 获取变更的文件列表
      const files = execSync('git diff --name-only HEAD~1 HEAD', {
        encoding: 'utf8',
        cwd: this.projectRoot
      }).split('\n').filter(f => f.trim());

      console.log(`   找到 ${files.length} 个变更文件`);
      this.changedFiles = files;
      return files;
    } catch (error) {
      console.log('   ⚠️ 无法获取变更文件，使用全量构建');
      return [];
    }
  }

  /**
   * 分析变更的包
   */
  analyzePackages() {
    console.log('📦 分析变更的包...');
    
    const packageMap = {
      'src/services/': 'services',
      'src/repositories/': 'repositories',
      'src/modules/': 'modules',
      'src/utils/': 'utils',
      'src/config/': 'config',
      '__tests__/services/': 'services',
      '__tests__/repositories/': 'repositories',
      '__tests__/modules/': 'modules',
      '__tests__/utils/': 'utils',
      '__tests__/integration/': 'integration',
      'scripts/': 'scripts'
    };

    for (const file of this.changedFiles) {
      for (const [prefix, pkg] of Object.entries(packageMap)) {
        if (file.startsWith(prefix)) {
          this.changedPackages.add(pkg);
          break;
        }
      }
    }

    console.log(`   识别到 ${this.changedPackages.size} 个变更包`);
    return Array.from(this.changedPackages);
  }

  /**
   * 生成测试策略
   */
  generateTestStrategy() {
    console.log('🎯 生成测试策略...');
    
    const packages = this.analyzePackages();
    const strategy = {
      runUnitTests: true,
      runIntegrationTests: false,
      runPerformanceTests: false,
      runSpecificTests: [],
      affectedPackages: packages
    };

    // 如果有源码变更，运行集成测试
    if (packages.length > 0) {
      strategy.runIntegrationTests = true;
    }

    // 如果有性能相关变更，运行性能测试
    const hasPerfChanges = this.changedFiles.some(f => 
      f.includes('performance') || 
      f.includes('limiter') || 
      f.includes('queue')
    );
    if (hasPerfChanges) {
      strategy.runPerformanceTests = true;
    }

    // 生成特定测试文件列表
    for (const pkg of packages) {
      const testFiles = this.findTestFilesForPackage(pkg);
      strategy.runSpecificTests.push(...testFiles);
    }

    console.log('   测试策略:');
    console.log(`     - 单元测试: ${strategy.runUnitTests ? '✅' : '❌'}`);
    console.log(`     - 集成测试: ${strategy.runIntegrationTests ? '✅' : '❌'}`);
    console.log(`     - 性能测试: ${strategy.runPerformanceTests ? '✅' : '❌'}`);
    console.log(`     - 变更包数: ${strategy.affectedPackages.length}`);

    return strategy;
  }

  /**
   * 查找包对应的测试文件
   */
  findTestFilesForPackage(pkg) {
    const testMap = {
      'services': '__tests__/services/',
      'repositories': '__tests__/repositories/',
      'modules': '__tests__/modules/',
      'utils': '__tests__/utils/',
      'integration': '__tests__/integration/',
      'scripts': '__tests__/scripts/',
      'config': '__tests__/config/'
    };

    const testDir = testMap[pkg];
    if (!testDir) return [];

    try {
      const files = execSync(`find ${testDir} -name "*.test.js" -o -name "*.spec.js" 2>/dev/null`, {
        encoding: 'utf8',
        cwd: this.projectRoot
      }).split('\n').filter(f => f.trim());

      return files;
    } catch (error) {
      return [];
    }
  }

  /**
   * 输出为 GitHub Actions 格式
   */
  outputForGitHub() {
    const strategy = this.generateTestStrategy();
    
    const output = {
      run_unit_tests: strategy.runUnitTests,
      run_integration_tests: strategy.runIntegrationTests,
      run_performance_tests: strategy.runPerformanceTests,
      affected_packages: strategy.affectedPackages,
      specific_tests: strategy.runSpecificTests
    };

    const json = JSON.stringify(output, null, 2);
    console.log('\n📋 策略 JSON 输出:');
    console.log(json);
    
    return output;
  }
}

// CLI 接口
const main = async () => {
  console.log('🔧 Changed Packages Detector 启动...\n');
  
  const detector = new ChangedPackagesDetector();
  const command = process.argv[2] || 'detect';
  
  try {
    switch (command) {
      case 'detect':
        console.log('🚀 检测变更包...');
        const output = detector.outputForGitHub();
        process.exit(0);
        
      case 'files':
        console.log('🔍 获取变更文件...');
        const files = detector.getChangedFiles();
        console.log('\n变更文件:', files);
        process.exit(0);
        
      case 'strategy':
        console.log('🎯 生成测试策略...');
        const strategy = detector.generateTestStrategy();
        console.log('\n测试策略:', JSON.stringify(strategy, null, 2));
        process.exit(0);
        
      default:
        console.log(`❌ 未知命令: ${command}`);
        console.log(`
用法: node scripts/ci/changed-packages.mjs <command>

命令:
  detect    检测变更包（GitHub Actions 格式）
  files     仅获取变更文件
  strategy  生成测试策略

示例:
  node scripts/ci/changed-packages.mjs detect
  node scripts/ci/changed-packages.mjs files
  node scripts/ci/changed-packages.mjs strategy
        `);
        process.exit(1);
    }
  } catch (error) {
    console.error('❌ 执行失败:', error.message);
    process.exit(1);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('脚本执行错误:', error);
    process.exit(1);
  });
}

export default ChangedPackagesDetector;