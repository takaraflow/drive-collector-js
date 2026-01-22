#!/usr/bin/env node

/**
 * CI Matrix Generator
 * 生成动态的 CI 矩阵配置
 * 支持根据变更范围、环境、分支等条件生成不同的测试/构建策略
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

class MatrixGenerator {
  constructor() {
    this.projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    this.matrix = {
      include: []
    };
  }

  /**
   * 检测变更范围
   */
  detectChanges() {
    console.log('🔍 检测代码变更...');
    
    try {
      // 获取变更的文件列表
      const changedFiles = execSync('git diff --name-only HEAD~1 HEAD', {
        encoding: 'utf8',
        cwd: this.projectRoot
      }).split('\n').filter(f => f.trim());

      console.log(`   变更文件数: ${changedFiles.length}`);
      
      // 分析变更类型
      const changes = {
        hasSrcChanges: changedFiles.some(f => f.startsWith('src/')),
        hasTestChanges: changedFiles.some(f => f.startsWith('__tests__/')),
        hasConfigChanges: changedFiles.some(f => f.startsWith('config/') || f === 'package.json'),
        hasDockerChanges: changedFiles.some(f => f === 'Dockerfile' || f === 'docker-compose.yml'),
        hasWorkflowChanges: changedFiles.some(f => f.startsWith('.github/workflows/'))
      };

      return changes;
    } catch (error) {
      console.log('   ⚠️ 无法检测变更，使用全量构建');
      return {
        hasSrcChanges: true,
        hasTestChanges: true,
        hasConfigChanges: true,
        hasDockerChanges: true,
        hasWorkflowChanges: true
      };
    }
  }

  /**
   * 生成测试矩阵
   */
  generateTestMatrix(changes) {
    console.log('🧪 生成测试矩阵...');
    
    const tests = [];

    // 基础测试
    tests.push({
      name: 'unit-tests',
      description: '运行单元测试',
      command: 'npm run test:unit',
      timeout: 300
    });

    // 集成测试（如果有源码变更）
    if (changes.hasSrcChanges) {
      tests.push({
        name: 'integration-tests',
        description: '运行集成测试',
        command: 'npm run test:integration',
        timeout: 600
      });
    }

    // 性能测试（如果有源码变更）
    if (changes.hasSrcChanges) {
      tests.push({
        name: 'performance-tests',
        description: '运行性能测试',
        command: 'npm run test:perf',
        timeout: 120
      });
    }

    // 代码质量检查
    tests.push({
      name: 'lint',
      description: '运行代码质量检查',
      command: 'npm run lint',
      timeout: 60
    });

    console.log(`   生成 ${tests.length} 个测试任务`);
    return tests;
  }

  /**
   * 生成构建矩阵
   */
  generateBuildMatrix(changes) {
    console.log('🐳 生成构建矩阵...');
    
    const builds = [];

    // 开发环境构建
    builds.push({
      name: 'build-dev',
      description: '构建开发环境镜像',
      environment: 'dev',
      timeout: 600
    });

    // 预发布环境构建（如果有源码变更）
    if (changes.hasSrcChanges) {
      builds.push({
        name: 'build-pre',
        description: '构建预发布环境镜像',
        environment: 'pre',
        timeout: 600
      });
    }

    // 生产环境构建（如果有源码变更）
    if (changes.hasSrcChanges) {
      builds.push({
        name: 'build-prod',
        description: '构建生产环境镜像',
        environment: 'prod',
        timeout: 600
      });
    }

    console.log(`   生成 ${builds.length} 个构建任务`);
    return builds;
  }

  /**
   * 生成验证矩阵
   */
  generateValidationMatrix() {
    console.log('📋 生成验证矩阵...');
    
    const validations = [
      {
        name: 'validate-manifest',
        description: '验证 manifest 文件',
        command: 'npm run ci:validate',
        timeout: 30
      },
      {
        name: 'validate-dependencies',
        description: '验证依赖版本',
        command: 'npm run check:env',
        timeout: 30
      }
    ];

    console.log(`   生成 ${validations.length} 个验证任务`);
    return validations;
  }

  /**
   * 生成完整的矩阵
   */
  generate() {
    console.log('🚀 开始生成 CI 矩阵...\n');

    // 检测变更
    const changes = this.detectChanges();

    // 生成各个阶段的矩阵
    const validations = this.generateValidationMatrix();
    const tests = this.generateTestMatrix(changes);
    const builds = this.generateBuildMatrix(changes);

    // 合并到主矩阵
    this.matrix.include = [
      ...validations.map(v => ({ stage: 'validation', ...v })),
      ...tests.map(t => ({ stage: 'test', ...t })),
      ...builds.map(b => ({ stage: 'build', ...b }))
    ];

    // 添加元数据
    this.matrix.metadata = {
      totalJobs: this.matrix.include.length,
      stages: {
        validation: validations.length,
        test: tests.length,
        build: builds.length
      },
      changes
    };

    console.log('\n📊 矩阵生成完成:');
    console.log(`   总任务数: ${this.matrix.metadata.totalJobs}`);
    console.log(`   验证阶段: ${this.matrix.metadata.stages.validation}`);
    console.log(`   测试阶段: ${this.matrix.metadata.stages.test}`);
    console.log(`   构建阶段: ${this.matrix.metadata.stages.build}`);

    return this.matrix;
  }

  /**
   * 输出矩阵（供 GitHub Actions 使用）
   */
  outputForGitHub() {
    const matrix = this.generate();
    
    // 输出为 JSON
    const json = JSON.stringify(matrix, null, 2);
    console.log('\n📋 矩阵 JSON 输出:');
    console.log(json);
    
    // 输出为 GitHub Actions 格式
    const githubOutput = `matrix=${json}`;
    console.log('\n📤 GitHub Actions 输出:');
    console.log(githubOutput);
    
    return matrix;
  }
}

// CLI 接口
const main = async () => {
  console.log('🔧 CI Matrix Generator 启动...\n');
  
  const generator = new MatrixGenerator();
  const command = process.argv[2] || 'generate';
  
  try {
    switch (command) {
      case 'generate':
        console.log('🚀 生成矩阵...');
        const matrix = generator.outputForGitHub();
        process.exit(0);
        
      case 'test':
        console.log('🧪 测试模式...');
        const testMatrix = generator.generate();
        console.log('\n测试矩阵:', JSON.stringify(testMatrix, null, 2));
        process.exit(0);
        
      case 'changes':
        console.log('🔍 检测变更...');
        const changes = generator.detectChanges();
        console.log('\n变更检测结果:', JSON.stringify(changes, null, 2));
        process.exit(0);
        
      default:
        console.log(`❌ 未知命令: ${command}`);
        console.log(`
用法: node scripts/ci/matrix.mjs <command>

命令:
  generate  生成矩阵（GitHub Actions 格式）
  test      测试模式（输出完整矩阵）
  changes   仅检测变更

示例:
  node scripts/ci/matrix.mjs generate
  node scripts/ci/matrix.mjs test
  node scripts/ci/matrix.mjs changes
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

export default MatrixGenerator;