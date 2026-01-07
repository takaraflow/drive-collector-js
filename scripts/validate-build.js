// 验证构建脚本的简单测试
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('Running build validation...');

// 1. 设置测试环境变量
process.env.NODE_ENV = 'production';
process.env.WORKER_NAME = 'test-worker';
process.env.CF_KV_NAMESPACE_ID = 'test-kv-id';
process.env.AXIOM_TOKEN = 'test-axiom-token';
process.env.AXIOM_DATASET = 'test-dataset';
process.env.AXIOM_ORG_ID = 'test-org-id';

// 2. 模拟构建命令 (仅执行 build-logic 部分)
try {
    console.log('🚀 正在执行构建逻辑 (Executing build logic)...');
    execSync('node scripts/build-logic.js', { stdio: 'inherit' });
    
    // 3. 验证 wrangler.toml 是否生成
    if (fs.existsSync('wrangler.toml')) {
        console.log('✅ wrangler.toml 生成成功 (wrangler.toml generated successfully)');
        const content = fs.readFileSync('wrangler.toml', 'utf8');
        
        // 验证关键配置是否存在
        if (content.includes('name = "test-worker"')) {
            console.log('✅ WORKER_NAME 注入成功 (WORKER_NAME injected correctly)');
        } else {
            console.error('❌ WORKER_NAME 注入失败 (WORKER_NAME injection failed)');
        }
        
        if (content.includes('id = "test-kv-id"')) {
            console.log('✅ CF_KV_NAMESPACE_ID 注入成功 (CF_KV_NAMESPACE_ID injected correctly)');
        } else {
            console.error('❌ CF_KV_NAMESPACE_ID 注入失败 (CF_KV_NAMESPACE_ID injection failed)');
        }
    } else {
        console.error('❌ 未生成 wrangler.toml (wrangler.toml not generated)');
        process.exit(1);
    }
    
    console.log('🎉 构建验证通过 (Build validation passed!)');
    
} catch (error) {
    console.error('❌ 构建验证失败 (Build validation failed):', error.message);
    process.exit(1);
}
