# 部署配置指南

本文档说明如何在不同部署环境中正确配置环境变量同步。

## 环境变量同步流程

```
┌─────────────────┐
│  环境变量来源    │
│  (Infisical)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  sync-env.js    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   .env 文件     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  应用启动       │
└─────────────────┘
```

## 1. 本地开发环境

### 使用 Infisical（推荐）

```bash
# 设置环境变量
export INFISICAL_TOKEN="your-infisical-token"
export INFISICAL_PROJECT_ID="your-project-id"
export INFISICAL_ENV="prod"  # 可选，默认 prod
export INFISICAL_SECRET_PATH="/"  # 可选，默认 /

# 运行同步脚本
npm run sync:env

# 启动应用
npm run dev
```

### 手动创建 .env

```bash
# 复制 .env.example
cp .env.example .env

# 编辑 .env 文件，填入你的配置
# 然后直接启动
npm run dev
```

## 2. Docker 部署

### 运行时同步（推荐）

```bash
# 构建镜像
docker build -t drive-collector-bot .

# 运行容器（自动同步）
docker run -d \
  --name bot \
  -e INFISICAL_TOKEN="your-token" \
  -e INFISICAL_PROJECT_ID="your-project-id" \
  -e INFISICAL_ENV="prod" \
  -p 7860:7860 \
  drive-collector-bot
```

容器启动时会自动：
1. 检测 INFISICAL_TOKEN
2. 同步环境变量到 .env
3. 启动应用

### 预生成 .env

```bash
# 本地生成 .env
export INFISICAL_TOKEN="your-token"
export INFISICAL_PROJECT_ID="your-project-id"
npm run sync:env

# 构建时包含 .env
docker build -t drive-collector-bot .

# 运行（无需再设置环境变量）
docker run -d -p 7860:7860 drive-collector-bot
```

### 使用环境变量文件

```bash
# 创建 env.list 文件
API_ID=123456
API_HASH=your_api_hash
BOT_TOKEN=your_bot_token
# ... 其他变量

# 运行容器
docker run -d \
  --env-file env.list \
  -p 7860:7860 \
  drive-collector-bot
```

## 3. CI/CD 环境

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
       
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
       
      - name: Install dependencies
        run: npm ci
       
      - name: Sync from Infisical
        env:
          INFISICAL_TOKEN: ${{ secrets.INFISICAL_TOKEN }}
          INFISICAL_PROJECT_ID: ${{ secrets.INFISICAL_PROJECT_ID }}
          INFISICAL_ENV: prod
        run: npm run sync:env
       
      - name: Build and Deploy
        run: |
          docker build -t my-app .
          # 部署命令
```

### GitLab CI

```yaml
# .gitlab-ci.yml
deploy:
  image: node:20
  script:
    - npm ci
    - npm run sync:env
    - docker build -t my-app .
    - docker push my-app:latest
  variables:
    INFISICAL_TOKEN: $INFISICAL_TOKEN
    INFISICAL_PROJECT_ID: $INFISICAL_PROJECT_ID
    INFISICAL_ENV: prod
  only:
    - main
```

## 4. 云服务商部署

### Zeabur

```bash
# 在 Zeabur 控制台设置环境变量
# 或使用 Zeabur CLI

# Zeabur 会自动检测并使用 Dockerfile
# 确保 Dockerfile 中的 CMD 正确配置了环境变量同步
```

### Northflank

```bash
# 在 Northflank 控制台设置环境变量
# 或使用 Northflank CLI

# Northflank 支持从 Infisical 同步
# 设置 INFISICAL_TOKEN 环境变量即可
```

### Railway

```bash
# Railway 支持从 .env.example 自动提示
# 或手动设置环境变量

# 也可以使用 Railway CLI
railway run npm run sync:env
```

## 5. 环境变量说明

### 必需变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `API_ID` | Telegram API ID | `123456` |
| `API_HASH` | Telegram API Hash | `abc123...` |
| `BOT_TOKEN` | Telegram Bot Token | `123456:ABC...` |

### 可选变量（按功能分类）

#### 基础配置
- `OWNER_ID`: 管理员用户 ID
- `RCLONE_REMOTE`: Rclone 远程名称（默认: mega）
- `REMOTE_FOLDER`: 远程文件夹路径（默认: /DriveCollectorBot）
- `PORT`: HTTP 服务器端口（默认: 7860）
- `HTTP2_ENABLED`: 是否启用 HTTP/2（默认: false）
- `HTTP2_PLAIN`: 是否使用明文 h2c（默认: false）
- `HTTP2_ALLOW_HTTP1`: 是否允许 HTTP/1.1 回退（默认: true）
- `HTTP2_TLS_KEY_PATH`: HTTP/2 TLS 私钥路径（启用 TLS 时必填）
- `HTTP2_TLS_CERT_PATH`: HTTP/2 TLS 证书路径（启用 TLS 时必填）

#### QStash（任务队列）
- `QSTASH_AUTH_TOKEN`: QStash 认证令牌
- `QSTASH_URL`: QStash 服务地址
- `LB_WEBHOOK_URL`: Webhook 回调地址

#### OSS/R2（对象存储）
- `OSS_WORKER_URL`: OSS Worker 地址
- `OSS_WORKER_SECRET`: OSS Worker 密钥
- `R2_ENDPOINT`: Cloudflare R2 端点
- `R2_ACCESS_KEY_ID`: R2 Access Key
- `R2_SECRET_ACCESS_KEY`: R2 Secret Key
- `R2_BUCKET`: R2 存储桶
- `R2_PUBLIC_URL`: R2 公共访问地址

#### Axiom（日志监控）
- `AXIOM_TOKEN`: Axiom API Token
- `AXIOM_ORG_ID`: Axiom 组织 ID
- `AXIOM_DATASET`: Axiom 数据集名称

#### Redis 缓存
- `NF_REDIS_URL`: Northflank Redis URL
- `REDIS_URL`: 通用 Redis URL
- `UPSTASH_REDIS_REST_URL`: Upstash Redis URL
- `UPSTASH_REDIS_REST_TOKEN`: Upstash Redis Token
- `CLOUDFLARE_KV_ACCOUNT_ID`: Cloudflare KV Account ID
- `CLOUDFLARE_KV_NAMESPACE_ID`: Cloudflare KV Namespace ID
- `CLOUDFLARE_KV_TOKEN`: Cloudflare KV Token

#### Telegram 代理
- `TELEGRAM_PROXY_HOST`: 代理主机
- `TELEGRAM_PROXY_PORT`: 代理端口
- `TELEGRAM_PROXY_TYPE`: 代理类型
- `TELEGRAM_PROXY_USERNAME`: 代理用户名
- `TELEGRAM_PROXY_PASSWORD`: 代理密码

#### TLS/安全配置
- `REDIS_TLS_ENABLED`: 是否启用 Redis TLS
- `REDIS_TLS_CA`: TLS CA 证书
- `REDIS_TLS_CLIENT_CERT`: TLS 客户端证书
- `REDIS_TLS_CLIENT_KEY`: TLS 客户端密钥
- `REDIS_SNI_SERVERNAME`: SNI 服务器名称

#### Infisical（环境变量同步）
- `INFISICAL_TOKEN`: Infisical API Token
- `INFISICAL_PROJECT_ID`: Infisical 项目 ID
- `INFISICAL_ENV`: Infisical 环境（默认: prod）
- `INFISICAL_SECRET_PATH`: Infisical 密钥路径（默认: /）

## 6. 故障排除

### 问题 1: 环境变量同步失败

**症状**: 启动时提示 "未找到 INFISICAL_TOKEN"

**解决**:
```bash
# 检查环境变量是否设置
echo $INFISICAL_TOKEN

# 手动运行同步脚本
npm run sync:env

# 检查 .env 文件是否生成
ls -la .env
```

### 问题 2: Docker 容器启动失败

**症状**: 容器立即退出

**解决**:
```bash
# 查看日志
docker logs <container-id>

# 检查环境变量
docker exec <container-id> env

# 手动测试同步
docker exec <container-id> node scripts/sync-env.js
```

### 问题 3: CI/CD 环境变量未同步

**症状**: 构建成功但应用无法运行

**解决**:
1. 确保正确设置了 `INFISICAL_TOKEN` 和 `INFISICAL_PROJECT_ID`
2. 使用 `npm run sync:env`
3. 检查 secrets 是否正确传递

## 7. 最佳实践

1. **永远不要提交 .env 文件到 Git**
   - 在 `.gitignore` 中添加 `.env`
   - 使用 `.env.example` 作为模板

2. **使用 Infisical 管理敏感信息**
   - 集中管理所有环境变量
   - 支持多环境（dev/staging/prod）

3. **Docker 部署优先使用运行时同步**
   - 避免在镜像中硬编码敏感信息
   - 支持动态配置更新

4. **CI/CD 使用统一的同步方式**
   - 确保构建环境有完整配置
   - 便于调试和验证

5. **定期轮换密钥**
   - 更新 Infisical Token
   - 更新 API Token
   - 更新数据库密码

## 8. 配置示例

### 完整的 .env.example

```bash
# Telegram 配置 (必需)
API_ID=12345678
API_HASH=your_api_hash_here
BOT_TOKEN=your_bot_token_here
OWNER_ID=123456789

# Rclone 配置
RCLONE_REMOTE=mega
REMOTE_FOLDER=/DriveCollectorBot

# HTTP 服务器
PORT=7860
HTTP2_ENABLED=false
HTTP2_PLAIN=false
HTTP2_ALLOW_HTTP1=true
HTTP2_TLS_KEY_PATH=
HTTP2_TLS_CERT_PATH=

# QStash (可选)
QSTASH_AUTH_TOKEN=
QSTASH_URL=https://qstash.upstash.io
LB_WEBHOOK_URL=

# OSS/R2 (可选)
OSS_WORKER_URL=
OSS_WORKER_SECRET=
R2_ENDPOINT=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PUBLIC_URL=

# Axiom (可选)
AXIOM_TOKEN=
AXIOM_ORG_ID=
AXIOM_DATASET=drive-collector

# Redis (可选，优先级: Upstash > Northflank > 通用)
NF_REDIS_URL=
REDIS_URL=
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
CLOUDFLARE_KV_ACCOUNT_ID=
CLOUDFLARE_KV_NAMESPACE_ID=
CLOUDFLARE_KV_TOKEN=

# Telegram 代理 (可选)
TELEGRAM_PROXY_HOST=
TELEGRAM_PROXY_PORT=
TELEGRAM_PROXY_TYPE=
TELEGRAM_PROXY_USERNAME=
TELEGRAM_PROXY_PASSWORD=

# Redis TLS (可选)
REDIS_TLS_ENABLED=false
REDIS_TLS_CA=
REDIS_TLS_CLIENT_CERT=
REDIS_TLS_CLIENT_KEY=
REDIS_SNI_SERVERNAME=

# Infisical (可选，用于自动同步)
INFISICAL_TOKEN=
INFISICAL_PROJECT_ID=
INFISICAL_ENV=prod
INFISICAL_SECRET_PATH=/

# Rclone 配置文件 (可选，Base64 编码)
RCLONE_CONF_BASE64=
```

## 9. 环境变量优先级

应用启动时，环境变量的加载优先级如下：

1. **系统环境变量**（最高优先级）
2. **.env 文件**（通过 sync-env 生成）
3. **默认值**（代码中定义）

对于 Redis 配置，优先级为：
1. `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
2. `NF_REDIS_URL` / `NF_REDIS_HOST` / `NF_REDIS_PORT`
3. `REDIS_URL` / `REDIS_HOST` / `REDIS_PORT`

## 10. 安全建议

1. **不要在日志中输出敏感信息**
   - sync-env.js 会过滤敏感信息
   - 确保 logger 不记录环境变量

2. **使用最小权限原则**
   - Infisical Token 只读权限
   - Redis 用户限制权限

3. **定期审计**
   - 检查环境变量使用情况
   - 清理未使用的变量
   - 更新过期的密钥

4. **备份策略**
   - 定期备份 .env 文件（加密存储）
   - 记录 Infisical 配置

---

如有问题，请参考 [README.md](README.md) 或联系项目维护者。
