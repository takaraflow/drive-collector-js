#!/usr/bin/env node

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Ajv from 'ajv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 获取项目根目录
const projectRoot = join(__dirname, '..');

// 读取 manifest.json
const manifestPath = join(projectRoot, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
} catch (error) {
  console.error('❌ Error reading manifest.json:', error.message);
  process.exit(1);
}

// 读取 schema
const schemaPath = join(projectRoot, 'tests', 'manifest.schema.json');
let schema;
try {
  schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
} catch (error) {
  console.error('❌ Error reading manifest.schema.json:', error.message);
  process.exit(1);
}

// 初始化 Ajv
const ajv = new Ajv({
  allErrors: true,
  verbose: true
});

// 编译验证器
const validate = ajv.compile(schema);

// 执行验证
const valid = validate(manifest);

if (valid) {
  console.log('✅ Manifest validation passed');
  console.log('   - manifest_version:', manifest.manifest_version);
  console.log('   - id:', manifest.id);
  console.log('   - name:', manifest.name);
  console.log('   - version:', manifest.version);
  console.log('   - type:', manifest.type);
  console.log('   - entrypoint:', manifest.entrypoint);
  process.exit(0);
} else {
  console.error('❌ Manifest validation failed:');
  console.error('');
  
  validate.errors.forEach((error, index) => {
    console.error(`Error ${index + 1}:`);
    console.error(`  Path: ${error.instancePath || '(root)'}`);
    console.error(`  Keyword: ${error.keyword}`);
    console.error(`  Message: ${error.message}`);
    
    if (error.params) {
      console.error(`  Params:`, JSON.stringify(error.params, null, 2));
    }
    
    if (error.keyword === 'required') {
      console.error(`  Missing property: ${error.params.missingProperty}`);
    }
    
    console.error('');
  });
  
  process.exit(1);
}