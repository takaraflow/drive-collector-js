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
# 将所有从 npm script 传来的参数 ($@) 转发给 build-logic.js
$NODE_CMD scripts/build-logic.js "$@"

if [ $? -ne 0 ]; then
    echo "错误: build-logic.js 执行失败"
    exit 1
fi

# 4. 执行 esbuild 构建
echo "执行 esbuild 构建（版本通过 Wrangler 变量注入）..."

# 尝试不同的 esbuild 执行方式
# 方式1: 使用 node_modules/esbuild/bin/esbuild（可能是 ELF/Mach-O 二进制，也可能是 JS 包装器）
if [ -f "node_modules/esbuild/bin/esbuild" ]; then
    echo "使用 node_modules/esbuild/bin/esbuild..."

    # 检测文件类型，避免把二进制当作 JS 交给 node 执行（会出现 'ELF' SyntaxError）
    MAGIC_HEX=$(head -c 4 node_modules/esbuild/bin/esbuild 2>/dev/null | od -An -tx1 2>/dev/null | tr -d ' \n')

    # 7f454c46 = ELF, cffaedfe/cafebabe 等为 Mach-O/FAT（都应该直接执行）
    if [ "$MAGIC_HEX" = "7f454c46" ] || [ "$MAGIC_HEX" = "cffaedfe" ] || [ "$MAGIC_HEX" = "cafebabe" ]; then
        node_modules/esbuild/bin/esbuild src/index.js --bundle --format=esm --outdir=dist --external:node:*
    else
        $NODE_CMD node_modules/esbuild/bin/esbuild src/index.js --bundle --format=esm --outdir=dist --external:node:*
    fi

# 方式2: 使用 node_modules/.bin/esbuild（shell wrapper；在某些 Windows 环境中 node 可能不在 PATH）
elif [ -f "node_modules/.bin/esbuild" ]; then
    echo "使用 node_modules/.bin/esbuild..."
    export PATH="$(dirname "$NODE_CMD"):$PATH"
    node_modules/.bin/esbuild src/index.js --bundle --format=esm --outdir=dist --external:node:*

# 方式3: 使用 npx
elif command -v npx >/dev/null 2>&1; then
    echo "使用 npx 运行 esbuild..."
    npx esbuild src/index.js --bundle --format=esm --outdir=dist --external:node:*
# 方式4: 使用全局安装的 esbuild
elif command -v esbuild >/dev/null 2>&1; then
    echo "使用全局 esbuild..."
    esbuild src/index.js --bundle --format=esm --outdir=dist --external:node:*
# 方式5: 回退到内联 Node.js 方式
else
    echo "使用内联 Node.js 方式运行 esbuild..."
    $NODE_CMD --input-type=module -e "
import { build } from 'esbuild';
await build({
    entryPoints: ['src/index.js'],
    bundle: true,
    format: 'esm',
    outdir: 'dist',
    external: ['node:*']
});
"
fi

if [ $? -ne 0 ]; then
    echo "错误: esbuild 构建失败"
    exit 1
fi

echo "构建完成!"
