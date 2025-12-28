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

# 清理可能误传为占位符字符串的变量
for var in AXIOM_TOKEN AXIOM_ORG_ID QSTASH_CURRENT_SIGNING_KEY UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN WORKER_NAME AXIOM_DATASET NODE_ENV SIGNATURE_EXPIRATION_WINDOW CF_KV_NAMESPACE_ID KV_PREVIEW_ID CLOUDFLARE_ACCOUNT_ID; do
    if [ "${!var}" = "\${$var}" ]; then
        unset "$var"
    fi
done

# 设置环境变量默认值
# 敏感变量如果未设置，则设为空字符串
AXIOM_TOKEN=${AXIOM_TOKEN:-}
AXIOM_ORG_ID=${AXIOM_ORG_ID:-}
QSTASH_CURRENT_SIGNING_KEY=${QSTASH_CURRENT_SIGNING_KEY:-}
UPSTASH_REDIS_REST_URL=${UPSTASH_REDIS_REST_URL:-}
UPSTASH_REDIS_REST_TOKEN=${UPSTASH_REDIS_REST_TOKEN:-}

# 可选变量设置默认值
WORKER_NAME=${WORKER_NAME:-drive-collector-lb}
AXIOM_DATASET=${AXIOM_DATASET:-drive-collector}
NODE_ENV=${NODE_ENV:-production}
SIGNATURE_EXPIRATION_WINDOW=${SIGNATURE_EXPIRATION_WINDOW:-900}
CF_KV_NAMESPACE_ID=${CF_KV_NAMESPACE_ID:-}
KV_PREVIEW_ID=${KV_PREVIEW_ID:-}

# 根据 WRANGLER_MODE 设置 CLOUDFLARE_ACCOUNT_ID
if [ "$WRANGLER_MODE" = "local" ]; then
    CLOUDFLARE_ACCOUNT_ID="unused-in-local-dev"
elif [ "$WRANGLER_MODE" = "remote" ]; then
    if [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
        echo "错误: 远程开发模式需要 CLOUDFLARE_ACCOUNT_ID"
        echo "请在 .env 文件中设置此变量"
        exit 1
    fi
else
    CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID:-}
fi

# 导出变量供 envsubst 使用
export AXIOM_TOKEN AXIOM_ORG_ID QSTASH_CURRENT_SIGNING_KEY SIGNATURE_EXPIRATION_WINDOW UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
export WORKER_NAME AXIOM_DATASET NODE_ENV CF_KV_NAMESPACE_ID KV_PREVIEW_ID CLOUDFLARE_ACCOUNT_ID

# 使用 envsubst 替换占位符
if command -v envsubst >/dev/null 2>&1; then
  envsubst '${AXIOM_TOKEN} ${AXIOM_ORG_ID} ${QSTASH_CURRENT_SIGNING_KEY} ${SIGNATURE_EXPIRATION_WINDOW} ${UPSTASH_REDIS_REST_URL} ${UPSTASH_REDIS_REST_TOKEN} ${WORKER_NAME} ${AXIOM_DATASET} ${NODE_ENV} ${CF_KV_NAMESPACE_ID} ${KV_PREVIEW_ID} ${CLOUDFLARE_ACCOUNT_ID}' < wrangler.build.toml > wrangler.toml
else
  echo "envsubst not found, falling back to sed"
  # 回退到改进的 sed 逻辑，先复制模板
  cp wrangler.build.toml wrangler.toml
  sed -i \
    -e "s|\${WORKER_NAME}|$WORKER_NAME|g" \
    -e "s|\${AXIOM_TOKEN}|$AXIOM_TOKEN|g" \
    -e 's/${AXIOM_ORG_ID}/'"$AXIOM_ORG_ID"'/g' \
    -e 's/${AXIOM_DATASET}/'"$AXIOM_DATASET"'/g' \
    -e 's/${QSTASH_CURRENT_SIGNING_KEY}/'"$QSTASH_CURRENT_SIGNING_KEY"'/g' \
    -e 's/${SIGNATURE_EXPIRATION_WINDOW}/'"$SIGNATURE_EXPIRATION_WINDOW"'/g' \
    -e "s|\${UPSTASH_REDIS_REST_URL}|$UPSTASH_REDIS_REST_URL|g" \
    -e 's/${UPSTASH_REDIS_REST_TOKEN}/'"$UPSTASH_REDIS_REST_TOKEN"'/g' \
    -e 's/${NODE_ENV}/'"$NODE_ENV"'/g' \
    -e 's/${CF_KV_NAMESPACE_ID}/'"$CF_KV_NAMESPACE_ID"'/g' \
    -e 's/${KV_PREVIEW_ID}/'"$KV_PREVIEW_ID"'/g' \
    -e 's/${CLOUDFLARE_ACCOUNT_ID}/'"$CLOUDFLARE_ACCOUNT_ID"'/g' \
    wrangler.toml
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
if grep -q '\${.*}' wrangler.toml; then
    echo "错误: wrangler.toml 中仍存在未替换的占位符变量"
    exit 1
fi

echo "wrangler.toml updated successfully"