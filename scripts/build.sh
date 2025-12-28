#!/bin/bash

# 设置可选环境变量默认值
WORKER_NAME=${WORKER_NAME:-drive-collector-lb}

# 使用sed直接在wrangler.toml中替换占位符
sed -i \
  -e "s/\${WORKER_NAME}/$WORKER_NAME/g" \
  -e "s/\${AXIOM_TOKEN}/${AXIOM_TOKEN:-}/g" \
  -e "s/\${AXIOM_ORG_ID}/${AXIOM_ORG_ID:-}/g" \
  -e "s/\${AXIOM_DATASET}/${AXIOM_DATASET:-}/g" \
  -e "s/\${QSTASH_CURRENT_SIGNING_KEY}/${QSTASH_CURRENT_SIGNING_KEY:-}/g" \
  -e "s/\${UPSTASH_REDIS_REST_URL}/${UPSTASH_REDIS_REST_URL:-}/g" \
  -e "s/\${UPSTASH_REDIS_REST_TOKEN}/${UPSTASH_REDIS_REST_TOKEN:-}/g" \
  -e "s/\${NODE_ENV}/${NODE_ENV:-production}/g" \
  wrangler.toml


echo "wrangler.toml updated successfully"