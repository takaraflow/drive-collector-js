# lb-worker-js

Cloudflare Worker 负载均衡器，用于多实例请求转发，支持故障转移到 Upstash Redis。

## 快速开始

### 本地开发
1. 复制 [.env.example](.env.example) 到 `.env`（`.env` 已加入 [.gitignore](.gitignore)，不会上传隐私信息）。
2. 编辑 `.env`，填写实际值（如 KV ID、Axiom Token 等）。
3. `source .env && npm run dev`

### 生产部署（Cloudflare Workers）
1. 设置 Cloudflare KV Namespace，并获取 ID。
2. **敏感环境变量使用 Secrets（推荐，避免硬编码泄露）：**
   ```
   wrangler secret put AXIOM_TOKEN
   wrangler secret put AXIOM_ORG_ID
   wrangler secret put AXIOM_DATASET  # 如需
   wrangler secret put QSTASH_CURRENT_SIGNING_KEY  # 如需
   wrangler secret put UPSTASH_REDIS_REST_URL  # 如需
   wrangler secret put UPSTASH_REDIS_REST_TOKEN  # 如需
   ```
   或通过 [Cloudflare Dashboard](https://dash.cloudflare.com/) 设置。
3. 非敏感变量（如 WORKER_NAME, CF_KV_NAMESPACE_ID）可在 `wrangler.toml` 配置或环境变量。
4. 构建：`bash scripts/build.sh`（替换占位符生成 `wrangler.build.toml`）。
5. 部署：`wrangler deploy`（或指定 config）。

**注意：** `wrangler.toml` 和 `build.sh` 使用占位符 `${VAR}` 机制，确保无隐私硬编码。

## 测试
`npm test`

## 架构
- KV 存储活跃实例列表。
- 支持 QStash 签名验证。
- 故障转移：KV 失败时切换 Upstash Redis。