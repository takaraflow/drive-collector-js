#!/usr/bin/env node

/**
 * 跨平台的 deploy 包装器
 * 替代 eval "$(node scripts/generate-wrangler-vars.js)"，确保在 Windows 和 Linux 下都能工作
 */

import { generateWranglerCommand } from './generate-wrangler-vars.js';
import { execSync } from 'child_process';

function main() {
    try {
        // 生成 wrangler 命令
        const command = generateWranglerCommand();
        
        console.log('Generated command:', command);
        
        // 执行命令
        // 注意：在 Windows 下，export 语法可能不兼容，所以这里只执行 wrangler 部分
        // 额外的 exports 应该在 build 阶段已经处理
        
        // 如果命令包含 exports，需要分别处理
        const parts = command.split('; ');
        let wranglerCmd = command;
        
        if (parts.length > 1) {
            // 有 exports，需要先执行 exports
            const exports = parts.slice(0, -1);
            const cmd = parts[parts.length - 1];
            
            // 执行 exports
            for (const exp of exports) {
                if (exp.trim().startsWith('export ')) {
                    const match = exp.match(/export\s+([^=]+)=(.*)/);
                    if (match) {
                        const [, key, value] = match;
                        // 移除引号
                        const cleanValue = value.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
                        process.env[key] = cleanValue;
                        console.log(`Set env: ${key}=${cleanValue}`);
                    }
                }
            }
            
            wranglerCmd = cmd;
        }
        
        // 执行 wrangler 命令
        console.log('Executing:', wranglerCmd);
        execSync(wranglerCmd, { stdio: 'inherit' });
        
    } catch (error) {
        console.error('Deploy failed:', error.message);
        process.exit(1);
    }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
    main();
}