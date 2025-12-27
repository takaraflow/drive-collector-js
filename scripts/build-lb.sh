#!/bin/bash

# 复制 wrangler.toml 到临时构建文件
cp wrangler.toml wrangler.build.toml

# 使用环境变量替换占位符
sed -i "s/\${KV_NAMESPACE_ID}/$KV_NAMESPACE_ID/g" wrangler.build.toml
sed -i "s/\${KV_PREVIEW_ID}/$KV_PREVIEW_ID/g" wrangler.build.toml
sed -i "s/\${QSTASH_SIGNING_KEY}/$QSTASH_SIGNING_KEY/g" wrangler.build.toml
sed -i "s/\${UPSTASH_REDIS_REST_URL}/$UPSTASH_REDIS_REST_URL/g" wrangler.build.toml
sed -i "s/\${UPSTASH_REDIS_REST_TOKEN}/$UPSTASH_REDIS_REST_TOKEN/g" wrangler.build.toml

# 构建 lb.js
npx esbuild src/worker/lb.js --bundle --outdir=dist