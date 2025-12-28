#!/bin/bash

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
CF_KV_NAMESPACE_ID=${CF_KV_NAMESPACE_ID:-}
KV_PREVIEW_ID=${KV_PREVIEW_ID:-}

# 导出变量供 envsubst 使用
export AXIOM_TOKEN AXIOM_ORG_ID QSTASH_CURRENT_SIGNING_KEY UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN
export WORKER_NAME AXIOM_DATASET NODE_ENV CF_KV_NAMESPACE_ID KV_PREVIEW_ID

# 使用 envsubst 替换占位符
if command -v envsubst >/dev/null 2>&1; then
  envsubst '${AXIOM_TOKEN} ${AXIOM_ORG_ID} ${QSTASH_CURRENT_SIGNING_KEY} ${UPSTASH_REDIS_REST_URL} ${UPSTASH_REDIS_REST_TOKEN} ${WORKER_NAME} ${AXIOM_DATASET} ${NODE_ENV} ${CF_KV_NAMESPACE_ID} ${KV_PREVIEW_ID}' < wrangler.build.toml > wrangler.toml
else
  echo "envsubst not found, falling back to sed"
  # 回退到改进的 sed 逻辑，先复制模板
  cp wrangler.build.toml wrangler.toml
  sed -i \
    -e 's/${WORKER_NAME}/'"$WORKER_NAME"'/g' \
    -e 's/${AXIOM_TOKEN}/'"$AXIOM_TOKEN"'/g' \
    -e 's/${AXIOM_ORG_ID}/'"$AXIOM_ORG_ID"'/g' \
    -e 's/${AXIOM_DATASET}/'"$AXIOM_DATASET"'/g' \
    -e 's/${QSTASH_CURRENT_SIGNING_KEY}/'"$QSTASH_CURRENT_SIGNING_KEY"'/g' \
    -e 's/${UPSTASH_REDIS_REST_URL}/'"$UPSTASH_REDIS_REST_URL"'/g' \
    -e 's/${UPSTASH_REDIS_REST_TOKEN}/'"$UPSTASH_REDIS_REST_TOKEN"'/g' \
    -e 's/${NODE_ENV}/'"$NODE_ENV"'/g' \
    -e 's/${CF_KV_NAMESPACE_ID}/'"$CF_KV_NAMESPACE_ID"'/g' \
    -e 's/${KV_PREVIEW_ID}/'"$KV_PREVIEW_ID"'/g' \
    wrangler.toml
fi

echo "wrangler.toml updated successfully"