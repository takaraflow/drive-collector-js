#!/bin/bash

# 设置可选环境变量默认值
WORKER_NAME=${WORKER_NAME:-lb-worker-js}
if [ -z "$CF_KV_NAMESPACE_ID" ]; then
  echo "Warning: CF_KV_NAMESPACE_ID not set, KV binding will be empty in wrangler.build.toml"
  CF_KV_NAMESPACE_ID=""
fi

# 设置默认值
if [ -z "$KV_PREVIEW_ID" ]; then
  KV_PREVIEW_ID="$CF_KV_NAMESPACE_ID"
fi

# 使用sed替换占位符
sed \
  -e "s/\${WORKER_NAME}/$WORKER_NAME/g" \
  -e "s/\${CF_KV_NAMESPACE_ID}/$CF_KV_NAMESPACE_ID/g" \
  -e "s/\${KV_PREVIEW_ID}/$KV_PREVIEW_ID/g" \
  -e "s/\${AXIOM_TOKEN}/${AXIOM_TOKEN:-}/g" \
  -e "s/\${AXIOM_ORG_ID}/${AXIOM_ORG_ID:-}/g" \
  -e "s/\${AXIOM_DATASET}/${AXIOM_DATASET:-}/g" \
  -e "s/\${QSTASH_CURRENT_SIGNING_KEY}/${QSTASH_CURRENT_SIGNING_KEY:-}/g" \
  -e "s/\${UPSTASH_REDIS_REST_URL}/${UPSTASH_REDIS_REST_URL:-}/g" \
  -e "s/\${UPSTASH_REDIS_REST_TOKEN}/${UPSTASH_REDIS_REST_TOKEN:-}/g" \
  -e "s/\${NODE_ENV}/${NODE_ENV:-production}/g" \
  wrangler.toml > wrangler.build.toml

echo "wrangler.build.toml generated successfully"