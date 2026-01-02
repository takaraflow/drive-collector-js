#!/bin/bash

# 1. 检测 node 命令路径 - 确保在 Windows/Linux/GHA 环境下都能找到 node
if command -v node >/dev/null 2>&1; then
    NODE_CMD="node"
elif command -v npm >/dev/null 2>&1; then
    NODE_CMD=$(dirname $(which npm))/node
    if [ ! -f "$NODE_CMD" ]; then
        NODE_CMD="node.exe"
    fi
else
    echo "错误: 未找到 node 命令"
    exit 1
fi

# 2. 检查是否在 GitHub Actions 环境中 (仅用于打印日志)
if [ "$GITHUB_ACTIONS" = "true" ]; then
    echo "检测到 GitHub Actions 环境，启动自动化构建流程..."
fi

# 3. 使用 Node.js 脚本处理所有构建逻辑 (环境变量注入、toml 生成)
# 这是最核心的一步，它会读取 GHA_SECRETS_JSON 并替换 wrangler.toml 中的占位符
$NODE_CMD scripts/build-logic.js

if [ $? -ne 0 ]; then
    echo "错误: build-logic.js 执行失败"
    exit 1
fi

# 4. 执行 esbuild 构建
echo "执行 esbuild 构建并注入版本号..."

$NODE_CMD --input-type=module -e "
import { build } from 'esbuild';
import { readFileSync } from 'fs';
const pkgStr = readFileSync('./package.json', 'utf8');
const pkg = JSON.parse(pkgStr);
await build({ 
    entryPoints: ['src/index.js'], 
    bundle: true, 
    format: 'esm', 
    outdir: 'dist', 
    external: ['node:*'], 
    define: { __VERSION__: JSON.stringify(pkg.version) } 
});
"

if [ $? -ne 0 ]; then
    echo "错误: esbuild 构建失败"
    exit 1
fi

echo "构建完成!"