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
    console.log('Executing build logic...');
    execSync('node scripts/build-logic.js', { stdio: 'inherit' });
    
    // 3. 验证 wrangler.toml 是否生成
    if (fs.existsSync('wrangler.toml')) {
        console.log('✅ wrangler.toml generated successfully');
        const content = fs.readFileSync('wrangler.toml', 'utf8');
        
        // 验证关键配置是否存在
        if (content.includes('name = "test-worker"')) {
            console.log('✅ WORKER_NAME injected correctly');
        } else {
            console.error('❌ WORKER_NAME injection failed');
        }
        
        if (content.includes('id = "test-kv-id"')) {
            console.log('✅ CF_KV_NAMESPACE_ID injected correctly');
        } else {
            console.error('❌ CF_KV_NAMESPACE_ID injection failed');
        }
    } else {
        console.error('❌ wrangler.toml not generated');
        process.exit(1);
    }
    
    console.log('Build validation passed!');
    
} catch (error) {
    console.error('Build validation failed:', error.message);
    process.exit(1);
}
