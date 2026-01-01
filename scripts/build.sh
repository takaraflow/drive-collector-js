#!/bin/bash

if [ -f .env ]; then
    echo "发现 .env 文件，正在加载环境变量..."
    # 使用 set -a 自动导出 source 的变量
    set -a
    source .env
    set +a
fi

# 检查必需的敏感变量
echo "检查环境变量配置..."

if [ -z "$AXIOM_TOKEN" ] || [ "$AXIOM_TOKEN" = '${AXIOM_TOKEN}' ]; then
    echo "警告: AXIOM_TOKEN 未设置，请确保在生产环境中配置此变量"
fi

if [ -z "$QSTASH_CURRENT_SIGNING_KEY" ] || [ "$QSTASH_CURRENT_SIGNING_KEY" = '${QSTASH_CURRENT_SIGNING_KEY}' ]; then
    echo "警告: QSTASH_CURRENT_SIGNING_KEY 未设置，如果需要 Webhook 签名验证，请确保配置此变量"
fi

if [ -z "$UPSTASH_REDIS_REST_TOKEN" ] || [ "$UPSTASH_REDIS_REST_TOKEN" = '${UPSTASH_REDIS_REST_TOKEN}' ]; then
    echo "警告: UPSTASH_REDIS_REST_TOKEN 未设置，如果需要故障转移到 Upstash Redis，请确保配置此变量"
fi

if [ -z "$UPSTASH_REDIS_REST_URL" ] || [ "$UPSTASH_REDIS_REST_URL" = '${UPSTASH_REDIS_REST_URL}' ]; then
    echo "警告: UPSTASH_REDIS_REST_URL 未设置，如果需要故障转移到 Upstash Redis，请确保配置此变量"
fi

if [ -z "$AXIOM_ORG_ID" ] || [ "$AXIOM_ORG_ID" = '${AXIOM_ORG_ID}' ]; then
    echo "警告: AXIOM_ORG_ID 未设置，日志功能可能受限"
fi

# 定义所有需要替换的变量列表
if command -v jq >/dev/null 2>&1; then
    echo "使用 jq 从 manifest.json 动态提取环境变量..."
    # 提取类型为 string, number, boolean 的配置项键名
    # 过滤掉 binding (type=kv-namespace 等)
    RAW_VARS=$(jq -r '.config.env | to_entries[] | select(.value.type? | IN("string","number","boolean")) | .key' manifest.json)
    
    # 手动添加不在 manifest.json config.env 中的关键部署变量
    RAW_VARS="${RAW_VARS}"$'\n'"WORKER_NAME"$'\n'"CLOUDFLARE_ACCOUNT_ID"$'\n'"CF_KV_NAMESPACE_ID"$'\n'"KV_PREVIEW_ID"

    if [ -n "$RAW_VARS" ]; then
        # 转换为 bash 数组
        IFS=$'\n' read -r -d '' -a VARS_TO_SUBST <<< "$RAW_VARS"
    else
        echo "警告: 无法从 manifest.json 提取变量，回退到硬编码列表"
        FALLBACK_NEEDED=true
    fi
else
    echo "警告: jq 未安装，回退到硬编码列表"
    FALLBACK_NEEDED=true
fi

if [ "$FALLBACK_NEEDED" = "true" ]; then
    VARS_TO_SUBST=(
    "AXIOM_DATASET"
    "AXIOM_ORG_ID"
    "AXIOM_TOKEN"
    "CF_CACHE_ACCOUNT_ID"
    "CF_CACHE_NAMESPACE_ID"
    "CF_CACHE_TOKEN"
    "CF_KV_NAMESPACE_ID"
    "CLOUDFLARE_ACCOUNT_ID"
    "KV_PREVIEW_ID"
    "NF_REDIS_HOST"
    "NF_REDIS_PORT"
    "NF_REDIS_SNI_SERVERNAME"
    "NF_REDIS_TLS_CA"
    "NF_REDIS_TLS_CLIENT_CERT"
    "NF_REDIS_TLS_CLIENT_KEY"
    "NF_REDIS_TLS_ENABLED"
    "NF_REDIS_TLS_REJECT_UNAUTHORIZED"
    "NF_REDIS_PASSWORD"
    "NF_REDIS_URL"
    "NODE_ENV"
    "OSS_WORKER_SECRET"
    "OSS_WORKER_URL"
    "QSTASH_CURRENT_SIGNING_KEY"
    "QSTASH_NEXT_SIGNING_KEY"
    "R2_ACCESS_KEY_ID"
    "R2_BUCKET"
    "R2_ENDPOINT"
    "R2_PUBLIC_URL"
    "R2_SECRET_ACCESS_KEY"
    "REDIS_HOST"
    "REDIS_MAX_RETRIES"
    "REDIS_PORT"
    "REDIS_RESTART_DELAY"
    "SIGNATURE_EXPIRATION_WINDOW"
    "SKIP_SIGNATURE_VERIFY"
    "UPSTASH_REDIS_REST_TOKEN"
    "UPSTASH_REDIS_REST_URL"
    "WORKER_NAME"
    )
fi

# 清理可能误传为占位符字符串的变量，并设置默认值
for var in "${VARS_TO_SUBST[@]}"; do
    # 如果变量值等于其占位符形式（例如 AXIOM_TOKEN 等于 ${AXIOM_TOKEN}），则清空该变量
    if [ "${!var}" = "\${$var}" ]; then
        unset "$var"
    fi
    
    # 尝试从 manifest.json 获取默认值（仅当 jq 可用时）
    MANIFEST_DEFAULT=""
    if command -v jq >/dev/null 2>&1; then
        MANIFEST_DEFAULT=$(jq -r --arg v "$var" '.config.env[$v].default // empty' manifest.json)
    fi

    # 优先级：环境变量 > Manifest 默认值 > 空字符串
    # 注意：bash 变量扩展 ${!var:-$MANIFEST_DEFAULT} 会在变量未设置或为空时使用默认值
    export "$var"="${!var:-$MANIFEST_DEFAULT}"
done

# 特殊默认值设置
export WORKER_NAME=${WORKER_NAME:-drive-collector-lb}
export AXIOM_DATASET=${AXIOM_DATASET:-drive-collector}
export NODE_ENV=${NODE_ENV:-production}
export SIGNATURE_EXPIRATION_WINDOW=${SIGNATURE_EXPIRATION_WINDOW:-900}

# 根据 WRANGLER_MODE 设置 CLOUDFLARE_ACCOUNT_ID
if [ "$WRANGLER_MODE" = "local" ]; then
    export CLOUDFLARE_ACCOUNT_ID="unused-in-local-dev"
elif [ "$WRANGLER_MODE" = "remote" ]; then
    if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
        echo "错误: 远程开发模式需要 CLOUDFLARE_ACCOUNT_ID"
        echo "请在 .env 文件中设置此变量"
        exit 1
    fi
fi

# 构建 envsubst 的变量列表字符串
ENVSUBST_VARS=""
for var in "${VARS_TO_SUBST[@]}"; do
    ENVSUBST_VARS="$ENVSUBST_VARS \${$var}"
done

# 使用 envsubst 替换占位符
if command -v envsubst >/dev/null 2>&1; then
  # 确保所有变量都已导出，以便 envsubst 能读取到
  envsubst "$ENVSUBST_VARS" < wrangler.build.toml > wrangler.toml
else
  echo "envsubst not found, falling back to sed"
  # 回退到 sed 逻辑
  cp wrangler.build.toml wrangler.toml
  for var in "${VARS_TO_SUBST[@]}"; do
      # 获取变量值
      val="${!var}"
      # 使用 sed 替换，注意处理斜杠等特殊字符
      # 这里使用 | 作为分隔符，并尝试转义
      # 注意：sed 在处理包含换行符或复杂字符的值时可能脆弱
      sed -i "s|\${$var}|$val|g" wrangler.toml
  done
fi

# 处理 preview_id
if [ -z "$KV_PREVIEW_ID" ]; then
  if [ "$NODE_ENV" != "production" ] && [ -n "$CF_KV_NAMESPACE_ID" ]; then
    # 本地开发模式且设置了生产 ID：提供占位符以绕过 Wrangler 的强制校验
    DUMMY_ID="00000000000000000000000000000000"
    # 极端情况处理：如果生产 ID 恰好也是这个占位符，则换一个
    if [ "$DUMMY_ID" = "$CF_KV_NAMESPACE_ID" ]; then
      DUMMY_ID="ffffffffffffffffffffffffffffffff"
    fi
    sed -i "s|preview_id = .*|preview_id = \"$DUMMY_ID\"|g" wrangler.toml
    echo "本地开发模式：已设置占位符 preview_id 以绕过 Wrangler 验证。"
  else
    # 生产环境或完全没有 KV 配置：移除 preview_id 行
    sed -i '/preview_id = .*/d' wrangler.toml
    echo "已从 wrangler.toml 中移除 preview_id。"

    if [ -z "$CF_KV_NAMESPACE_ID" ]; then
      # 如果两者都为空，移除整个 kv_namespaces 绑定
      sed -i '/^\[\[kv_namespaces\]\]/,/^\[/ { /^\[\[kv_namespaces\]\]/d; /^\[/!d; }' wrangler.toml
    fi
  fi
fi

if [ "$WRANGLER_MODE" = "local" ]; then
    echo "本地开发模式：移除 KV ID 以强制使用本地模拟"
    sed -i '/^id = /d' wrangler.toml
    sed -i '/^preview_id = /d' wrangler.toml
elif [ "$WRANGLER_MODE" = "remote" ]; then
    echo "远程开发模式：检查 KV 配置"
    if [ -z "$CF_KV_NAMESPACE_ID" ] || [ -z "$KV_PREVIEW_ID" ]; then
        echo "错误: 远程开发模式需要 CF_KV_NAMESPACE_ID 和 KV_PREVIEW_ID"
        echo "请在 .env 文件中设置这些变量"
        exit 1
    fi
fi

# 校验构建结果：检查是否还有未替换的占位符
# 排除掉允许为空且在 .env 中明确说明是可选的变量
# 在 GHA 中，如果这些变量未设置，它们将被替换为空字符串，这在 TOML 中是允许的
if grep -q '\${.*}' wrangler.toml; then
    echo "检查未替换的占位符..."
    # 允许这些变量在没有值的情况下被替换为空字符串，而不是导致构建失败
    # 如果占位符仍然存在，说明它们甚至没有被加入到待替换列表或者替换逻辑失效了
    echo "错误: wrangler.toml 中仍存在未替换的占位符变量"
    # 打印出具体的未替换变量，方便调试
    grep -o '\${[^}]*}' wrangler.toml
    exit 1
fi

# 自动更新 src/index.js 中的版本号
echo "wrangler.toml updated successfully. VERSION will be injected dynamically via esbuild --define during build."
