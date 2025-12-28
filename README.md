# lb-worker-js

Cloudflare Worker 负载均衡器，用于多实例请求转发，支持故障转移到 Upstash Redis。

## 快速开始

### 本地开发
1. 复制 [.env.example](.env.example) 到 `.env`（`.env` 已加入 [.gitignore](.gitignore)，不会上传隐私信息）。
2. 编辑 `.env`，填写实际值（如 KV ID、Axiom Token 等）。
3. `source .env && npm run dev`

### 生产部署（Cloudflare Workers）
1. **配置 KV Namespace**：
   1. **创建 KV Namespace**（如果没有）：[Workers & Pages > KV](https://dash.cloudflare.com/?to=/:account/workers-and-pages/kv) > Create namespace，记下 Namespace ID，填入 [`wrangler.build.toml`](wrangler.build.toml) 的 `[[kv_namespaces]]`：
      ```
      [[kv_namespaces]]
      binding = "KV_STORAGE"
      id = "your-namespace-id"
      preview_id = "your-preview-id"
      ```
   2. **绑定到 Worker**：Workers > [你的 Worker] > Settings > Variables > KV Namespace Bindings > Add binding：
      - Variable name: `KV_STORAGE`
      - KV namespace: 选择你的 namespace
2. **敏感环境变量使用 Secrets（推荐，避免硬编码泄露）：**
   ```
   wrangler secret put AXIOM_TOKEN
   wrangler secret put AXIOM_ORG_ID
   wrangler secret put AXIOM_DATASET
   wrangler secret put QSTASH_CURRENT_SIGNING_KEY  # 如需
   wrangler secret put UPSTASH_REDIS_REST_URL  # 如需
   wrangler secret put UPSTASH_REDIS_REST_TOKEN  # 如需
   ```
   或通过 [Cloudflare Dashboard](https://dash.cloudflare.com/) 设置。
3. **🚀 GitHub Actions CI/CD**（推荐）：

   ### 创建 CLOUDFLARE_API_TOKEN
   1. [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) > Create Token > Custom token
   2. **Permissions**（至少）：
      | Resource | Permission |
      |----------|------------|
      | Account · Cloudflare Workers | Edit |
   3. Continue to summary > Create Token，复制 value。

   ### 配置 Secrets & Variables
   Repo Settings > Secrets and variables > Actions（默认分组，非 Environment-specific）：

   **Secrets**：
   | Name | 描述 |
   |------|------|
   | `CLOUDFLARE_API_TOKEN` | 上步 API Token |
   | `AXIOM_TOKEN` | Axiom ingestion token |
   | `AXIOM_ORG_ID` | Axiom organization ID |
   | `QSTASH_CURRENT_SIGNING_KEY` | QStash 当前 signing key (可选) |
   | `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis token (可选) |

   **Variables**：
   | Name | 描述 |
   |------|------|
   | `WORKER_NAME` | Worker 名称 (e.g. `lb-worker-js`) |
   | `AXIOM_DATASET` | Axiom dataset |
   | `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL (可选) |

   **注意：** 以上 Secrets 和 Variables 位于 Actions 默认分组（main branch），非 Environment-specific。

   如果使用 Environment "production"，需在 workflow 的 jobs 中设置 `environment: production`，并进行 manual approval。

   4. Push 到 `main`，触发 [deploy.yml](.github/workflows/deploy.yml) 自动部署。

   ### 本地 Deploy
   ```
   export WORKER_NAME=your-worker-name
   # 其他 env vars from .env
   npm run deploy
   ```

   ### Troubleshooting
   - **Token error**：确认 API Token 有 "Cloudflare Workers: Edit" 权限，重试。
   - **Wrangler version warning**：运行 `npm i wrangler@latest -g` 更新。
   - **Deploy 失败**：检查 Actions logs，确认 secrets/vars 已设。

**注意：** `wrangler.toml` 和 `build.sh` 使用占位符 `${VAR}` 机制，确保无隐私硬编码。Secrets 优先于 env vars 中的 vars。

## 测试
`npm test`

## 架构
- KV 存储活跃实例列表。
- 支持 QStash 签名验证。
- 故障转移：KV 失败时切换 Upstash Redis。