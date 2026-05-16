#!/bin/bash
set -euo pipefail

# 统一CI入口脚本
# 用法: bash ci/run.sh [command] [environment]
# 命令: full, validate, sync, quick, lint, test, build
# 环境: dev, pre, prod (默认: dev)

COMMAND=${1:-full}
ENVIRONMENT=${2:-dev}

echo "🚀 开始CI流程 (命令: $COMMAND, 环境: $ENVIRONMENT)"

# 确保在项目根目录运行
cd "$(dirname "$0")/.."

case "$COMMAND" in
  full|validate|sync|quick|lint|test|build)
    ;;
  *)
    echo "❌ 未知 CI 命令: $COMMAND" >&2
    exit 2
    ;;
esac

export CI_TARGET_ENV="$ENVIRONMENT"

# 调用Node.js统一脚本
node scripts/ci-unified.js "$COMMAND"
