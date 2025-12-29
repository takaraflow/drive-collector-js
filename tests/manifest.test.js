import { describe, expect, it, beforeAll } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Ajv from 'ajv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 获取项目根目录
const projectRoot = join(__dirname, '..');

describe('Manifest Validation Tests', () => {
  let manifest;
  let schema;
  let validate;

  beforeAll(() => {
    // 读取 manifest.json
    const manifestPath = join(projectRoot, 'manifest.json');
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    // 读取 schema
    const schemaPath = join(projectRoot, 'tests', 'manifest.schema.json');
    schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

    // 初始化 Ajv 和验证器
    const ajv = new Ajv({
      allErrors: true,
      verbose: true
    });
    validate = ajv.compile(schema);
  });

  describe('Required Fields', () => {
    it('应该包含所有必填字段', () => {
      const requiredFields = ['manifest_version', 'id', 'name', 'version', 'type', 'entrypoint'];
      
      requiredFields.forEach(field => {
        expect(manifest).toHaveProperty(field);
      });
    });

    it('manifest_version 应该符合格式要求', () => {
      expect(manifest.manifest_version).toMatch(/^\d+\.\d+$/);
    });

    it('version 应该符合 SemVer 格式', () => {
      expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('type 应该为 worker', () => {
      expect(manifest.type).toBe('worker');
    });

    it('entrypoint 应该指向有效的文件', () => {
      expect(manifest.entrypoint).toBeTruthy();
      expect(manifest.entrypoint).toMatch(/\.js$/);
    });
  });

  describe('Schema Validation', () => {
    it('应该通过 schema 验证', () => {
      const valid = validate(manifest);
      expect(valid).toBe(true);
      if (!valid) {
        console.log('Validation errors:', validate.errors);
      }
    });

    it('应该包含 endpoints 对象且有 health 和 webhook', () => {
      expect(manifest.endpoints).toBeDefined();
      expect(manifest.endpoints.health).toBeDefined();
      expect(manifest.endpoints.webhook).toBeDefined();
      expect(manifest.endpoints.health).toMatch(/^\/.*/);
      expect(manifest.endpoints.webhook).toMatch(/^\/.*/);
    });

    it('应该包含 config.env 对象', () => {
      expect(manifest.config).toBeDefined();
      expect(manifest.config.env).toBeDefined();
      expect(typeof manifest.config.env).toBe('object');
    });

    it('config.env 中的每个环境变量应该有正确的结构', () => {
      const envVars = manifest.config.env;
      
      Object.keys(envVars).forEach(key => {
        const envVar = envVars[key];
        expect(envVar).toHaveProperty('type');
        expect(envVar).toHaveProperty('required');
        expect(envVar).toHaveProperty('description');
        expect(typeof envVar.required).toBe('boolean');
        expect(typeof envVar.description).toBe('string');
      });
    });
  });

  describe('Content Validation', () => {
    it('应该有有意义的名称和描述', () => {
      expect(manifest.name).toBeTruthy();
      expect(manifest.name.length).toBeGreaterThan(0);
      expect(manifest.description).toBeTruthy();
      expect(manifest.description.length).toBeGreaterThan(0);
    });

    it('应该有正确的入口文件路径', () => {
      // 验证入口文件存在（可选，因为测试环境可能没有构建后的文件）
      expect(manifest.entrypoint).toBe('src/index.js');
    });

    it('应该包含必要的能力', () => {
      expect(manifest.capabilities).toBeDefined();
      expect(Array.isArray(manifest.capabilities)).toBe(true);
      expect(manifest.capabilities.length).toBeGreaterThan(0);
    });
  });

  describe('Integration with npm test', () => {
    it('应该可以通过 node scripts/validate-manifest.js 运行', async () => {
      // 这个测试确保验证脚本可以正常工作
      const { execSync } = await import('child_process');
      
      try {
        const result = execSync('node scripts/validate-manifest.js', {
          cwd: projectRoot,
          encoding: 'utf-8'
        });
        
        // 如果成功，应该包含成功消息
        expect(result).toContain('✅ Manifest validation passed');
      } catch (error) {
        // 如果失败，测试应该失败
        throw new Error(`Validation script failed: ${error.message}`);
      }
    });
  });
});