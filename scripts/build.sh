#!/bin/bash

# 检测 node 命令路径 - 使用 npm 所在目录的 node
# 在 Windows Git Bash 环境下，npm 命令通常能找到 node
if command -v node >/dev/null 2>&1; then
    NODE_CMD="node"
elif command -v npm >/dev/null 2>&1; then
    # 通过 npm 找到 node 的位置
    NODE_CMD=$(dirname $(which npm))/node
    if [ ! -f "$NODE_CMD" ]; then
        # 尝试直接使用 node.exe
        NODE_CMD="node.exe"
    fi
else
    echo "错误: 未找到 node 命令"
    exit 1
fi

# 检查是否在 GitHub Actions 环境中
if [ "$GITHUB_ACTIONS" = "true" ]; then
    echo "检测到 GitHub Actions 环境..."
    # 在 GHA 中，我们依赖 generate-wrangler-vars.js 通过 --var 注入业务变量
    # build.sh 主要负责生成基础的 wrangler.toml 结构
fi

# 使用 Node.js 脚本处理所有构建逻辑
# 这样可以确保在任何环境下都能正常工作，无需担心 shell 命令的兼容性
$NODE_CMD scripts/build-logic.js

# 检查执行结果
if [ $? -ne 0 ]; then
    echo "错误: build-logic.js 执行失败"
    exit 1
fi

# 继续执行 esbuild 构建
# 注意：版本号注入已经在 build-logic.js 中处理，这里只需要执行 esbuild
echo "执行 esbuild 构建..."

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