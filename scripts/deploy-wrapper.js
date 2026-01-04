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
    
    // 增强的脱敏模式：覆盖更多敏感关键词和场景
    const patterns = [
        // 1. 匹配 --var 或 export 后的敏感变量名（包含 TOKEN, KEY, SECRET, PASSWORD, PWD, URL, ID 等）
        {
            regex: /(--var\s+|export\s+)([^=]*(?:TOKEN|KEY|SECRET|PASSWORD|PWD|URL|ID|AUTH|TOKEN_|KEY_|SECRET_|PASSWORD_|PWD_|URL_|ID_|AUTH_)[^=]*)(=)([^;\s]+)/gi,
            replacement: (match, p1, p2, p3, p4) => {
                // 如果是 URL，尝试保留协议头但隐藏敏感部分
                if (p4.includes('://') && p4.length > 10) {
                    return `${p1}${p2}${p3}"***REDACTED***"`;
                }
                return `${p1}${p2}${p3}***REDACTED***`;
            }
        },
        // 2. 匹配 URL 中的密码部分 (redis://:password@host)
        {
            regex: /(redis|rediss|postgres|mysql|mongodb):\/\/([^@]+@)?([^@]+)(:\d+)?/gi,
            replacement: (match, protocol, userPass, host, port) => {
                // 如果包含密码 (:password@)
                if (userPass && userPass.includes(':')) {
                    return `${protocol}://***REDACTED***@${host}${port || ''}`;
                }
                return match;
            }
        },
        // 3. 匹配 JSON 格式中的敏感字段
        {
            regex: /("([^"]*(?:TOKEN|KEY|SECRET|PASSWORD|PWD|URL|ID|AUTH)[^"]*)"\s*:\s*)("([^"]*)"|'([^']*)')/gi,
            replacement: (match, p1, p2, p3, p4) => `${p1}"***REDACTED***"`
        }
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
        
        execSync(wranglerCmd, {
            stdio: 'inherit',
            env: { ...process.env }
        });
        
    } catch (error) {
        console.error('Deploy failed:', error.message);
        process.exit(1);
    }
}

// 直接运行，不进行复杂的 ESM 路径匹配判断，确保在 Windows 上能工作
main();