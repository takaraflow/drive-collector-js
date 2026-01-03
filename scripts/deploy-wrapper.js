#!/usr/bin/env node

/**
 * 跨平台的 deploy 包装器
 * 替代 eval "$(node scripts/generate-wrangler-vars.js)"，确保在 Windows 和 Linux 下都能工作
 */

import { generateWranglerCommand } from './generate-wrangler-vars.js';
import { execSync } from 'child_process';

/**
 * 脱敏敏感信息
 * @param {string} str - 需要脱敏的字符串
 * @returns {string} - 脱敏后的字符串
 */
function redactSensitiveInfo(str) {
    if (!str) return str;
    
    // 脱敏常见的敏感信息模式
    const patterns = [
        // API Keys/Vars (处理 --var key=value 格式)
        { regex: /(--var\s+[^=]+=)([^ ]+)/g, replacement: (match, prefix, value) => `${prefix}***REDACTED***` },
        // 环境变量值 (引号内的内容)
        { regex: /(export\s+\w+=)"([^"]{10,})"/g, replacement: (match, prefix, value) => `${prefix}"***REDACTED***"` },
        // Tokens (引号内且较长的内容)
        { regex: /"[a-zA-Z0-9_\-\.]{40,}"/g, replacement: '"***REDACTED***"' },
    ];
    
    let result = str;
    for (const { regex, replacement } of patterns) {
        result = result.replace(regex, replacement);
    }
    return result;
}

function main() {
    try {
        // 生成 wrangler 命令
        const command = generateWranglerCommand();
        
        // 脱敏后输出命令
        console.log('Generated command:', redactSensitiveInfo(command));
        
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
                        // 脱敏后输出环境变量设置
                        console.log(`Set env: ${key}=***REDACTED***`);
                    }
                }
            }
            
            wranglerCmd = cmd;
        }
        
        // 执行 wrangler 命令（脱敏后输出）
        console.log('Executing wrangler command...');
        execSync(wranglerCmd, { stdio: 'inherit' });
        
    } catch (error) {
        console.error('Deploy failed:', error.message);
        process.exit(1);
    }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
    main();
}