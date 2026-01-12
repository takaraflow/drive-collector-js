# 环境变量同步指南

## ⚠️ 安全警告：生产环境必须使用运行时同步

**重要变更**：从安全增强版本开始，生产环境不再推荐使用 `scripts/sync-env.js` 将密钥写入 `.env` 文件。改为在应用启动时直接从 Infisical 获取配置并注入内存，避免密钥持久化到磁盘。

## 统一原则

**无论在哪里构建（GHA、云服务商、本地、Docker），只要设置好 `INFISICAL_TOKEN` 等变量，都能自动从 Infisical 获取所有环境变量。**

## 核心机制

### 1. 运行时安全同步（推荐生产环境）

应用启动时，通过 `src/services/secrets/InfisicalSecretsProvider.js` 直接从 Infisical API 获取密钥，并注入到 `config` 对象中，**不写入磁盘**。

**启动流程**：
```javascript
// index.js
await initConfig(); // 从 Infisical 获取配置
// config 对象已包含所有密钥，可安全使用
```

**优势**：
- ✅ 密钥不落地，避免磁盘泄露风险
- ✅ 实时获取最新配置
- ✅ 支持 4 级降级（Infisical API → 本地缓存 → 云服务商配置 → 失败退出）

### 2. 传统同步模式（仅限开发/调试）

`scripts/sync-env.js` 仍保留用于开发环境，但**不建议在生产环境使用**。

**使用场景**：
- 本地开发调试
- 离线环境测试
- 需要生成 `.env` 备份

**执行命令**：
```bash
# 生成 .env 文件（仅开发）
npm run sync:env
```

### 3. 启动脚本调整

**生产环境（推荐）**：
```json
{
  "scripts": {
    "start": "cross-env NODE_MODE=all node index.js",
    "start:dispatcher": "cross-env NODE_MODE=dispatcher node index.js",
    "start:processor": "cross-env NODE_MODE=processor node index.js",
    "dev": "npm run sync:env && cross-env NODE_MODE=dev node --watch index.js"
  }
}
```

**说明**：
- `start` 命令不再执行 `sync:env`，而是依赖运行时 `initConfig()`
- `dev` 命令保留 `sync:env` 以兼容本地开发习惯

### 4. Docker 集成

#### 运行时同步（推荐生产）
```bash
docker run -d \
  -e INFISICAL_TOKEN="your-token" \
  -e INFISICAL_PROJECT_ID="your-project-id" \
  -e STRICT_SYNC=1 \
  -p 7860:7860 \
  my-app
```

容器启动时：
1. `initConfig()` 被调用
2. 从 Infisical API 获取密钥
3. 注入到内存配置对象
4. 应用启动，**不生成 `.env` 文件**

#### 开发环境（可选）
```bash
# 如果需要 .env 文件用于调试
docker run -d \
  -e INFISICAL_TOKEN="your-token" \
  -e INFISICAL_PROJECT_ID="your-project-id" \
  -e STRICT_SYNC=0 \
  -v $(pwd)/.env:/app/.env \
  -p 7860:7860 \
  my-app
```

if [ -n "$INFISICAL_TOKEN" ]; then
  node scripts/sync-env.js
fi
node index.js
```

#### 构建时同步（可选）
```bash
docker build \
  --build-arg INFISICAL_TOKEN="your-token" \
  --build-arg INFISICAL_PROJECT_ID="your-project-id" \
  -t my-app:latest .
```

Dockerfile 会在构建阶段：
1. 同步环境变量
2. 运行测试（使用同步的变量）
3. 构建最终镜像

### 4. CI/CD 集成

#### GitHub Actions
```yaml
- name: Sync from Infisical
  env:
    INFISICAL_TOKEN: ${{ secrets.INFISICAL_TOKEN }}
    INFISICAL_PROJECT_ID: ${{ secrets.INFISICAL_PROJECT_ID }}
    INFISICAL_ENV: prod
  run: npm run sync:env
```

#### GitLab CI
```yaml
deploy:
  variables:
    INFISICAL_TOKEN: $INFISICAL_TOKEN
    INFISICAL_PROJECT_ID: $INFISICAL_PROJECT_ID
    INFISICAL_ENV: prod
  script:
    - npm run sync:env
```

## 云服务商配置支持

### 与云平台环境变量的配合

**核心原则**：
云服务商的环境变量作为第4级降级方案，与 Infisical 形成互补关系。当 Infisical 服务不可用时，系统会自动使用云平台已配置的环境变量。

**支持的云平台**：
- **Cloudflare Workers/Cloudflare Pages**
- **AWS (ECS, EKS, Lambda)**
- **Google Cloud Platform (GCP)**
- **Microsoft Azure**
- **Vercel**
- **Netlify**
- **Docker 容器化部署**

### 配置示例

#### Cloudflare Workers 配置

**wrangler.toml**：
```toml
[env.production]
name = "my-app-prod"
compatibility_date = "2024-01-01"

# 环境变量（作为第4级降级）
[env.production.vars]
INFISICAL_TOKEN = "your-infisical-token"
INFISICAL_PROJECT_ID = "your-project-id"
STRICT_SYNC = "0"

# 云服务商特定配置
CF_CACHE_ACCOUNT_ID = "account-id"
CF_CACHE_NAMESPACE_ID = "namespace-id"
CF_CACHE_TOKEN = "cache-token"
CF_KV_ACCOUNT_ID = "kv-account-id"
CF_KV_NAMESPACE_ID = "kv-namespace-id"
CF_KV_TOKEN = "kv-token"
```

**部署命令**：
```bash
# 部署时自动注入环境变量
wrangler deploy --env production
```

#### AWS ECS 配置

**task-definition.json**：
```json
{
  "family": "my-app",
  "containerDefinitions": [
    {
      "name": "my-app",
      "image": "my-app:latest",
      "environment": [
        {
          "name": "INFISICAL_TOKEN",
          "value": "your-infisical-token"
        },
        {
          "name": "INFISICAL_PROJECT_ID",
          "value": "your-project-id"
        },
        {
          "name": "STRICT_SYNC",
          "value": "0"
        },
        {
          "name": "UPSTASH_REDIS_REST_URL",
          "value": "https://redis.example.com"
        },
        {
          "name": "UPSTASH_REDIS_REST_TOKEN",
          "value": "redis-token"
        },
        {
          "name": "QSTASH_TOKEN",
          "value": "qstash-token"
        }
      ]
    }
  ]
}
```

#### Vercel 配置

**vercel.json**：
```json
{
  "env": {
    "INFISICAL_TOKEN": "@infisical-token",
    "INFISICAL_PROJECT_ID": "@infisical-project-id",
    "STRICT_SYNC": "0",
    "UPSTASH_REDIS_REST_URL": "@redis-url",
    "UPSTASH_REDIS_REST_TOKEN": "@redis-token",
    "QSTASH_TOKEN": "@qstash-token"
  }
}
```

**或通过 Vercel Dashboard**：
```
Project Settings → Environment Variables
```

#### Docker Compose 配置

**docker-compose.yml**：
```yaml
version: '3.8'
services:
  app:
    image: my-app:latest
    environment:
      # Infisical 配置
      - INFISICAL_TOKEN=${INFISICAL_TOKEN}
      - INFISICAL_PROJECT_ID=${INFISICAL_PROJECT_ID}
      - STRICT_SYNC=0
      
      # 云服务商配置（第4级降级）
      - UPSTASH_REDIS_REST_URL=${UPSTASH_REDIS_REST_URL}
      - UPSTASH_REDIS_REST_TOKEN=${UPSTASH_REDIS_REST_TOKEN}
      - QSTASH_TOKEN=${QSTASH_TOKEN}
      - OSS_WORKER_URL=${OSS_WORKER_URL}
      - OSS_WORKER_SECRET=${OSS_WORKER_SECRET}
      - R2_ENDPOINT=${R2_ENDPOINT}
      - R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}
      - R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}
      - R2_BUCKET=${R2_BUCKET}
      - AXIOM_TOKEN=${AXIOM_TOKEN}
      - AXIOM_ORG_ID=${AXIOM_ORG_ID}
      - AXIOM_DATASET=${AXIOM_DATASET}
      - API_ID=${API_ID}
      - API_HASH=${API_HASH}
      - BOT_TOKEN=${BOT_TOKEN}
      - OWNER_ID=${OWNER_ID}
      - RCLONE_REMOTE=${RCLONE_REMOTE}
      - REMOTE_FOLDER=${REMOTE_FOLDER}
      - RCLONE_CONF_BASE64=${RCLONE_CONF_BASE64}
      - PORT=${PORT:-7860}
    ports:
      - "${PORT:-7860}:7860"
```

### 配置管理最佳实践

#### 1. 分层配置策略

**开发环境**：
```bash
# 优先使用 Infisical，允许降级到本地
export INFISICAL_TOKEN="dev-token"
export INFISICAL_PROJECT_ID="dev-project"
export STRICT_SYNC=0
```

**生产环境**：
```bash
# 严格模式，确保配置同步
export INFISICAL_TOKEN="${INFISICAL_TOKEN}"
export INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID}"
export STRICT_SYNC=1

# 云服务商配置作为备份
export UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL}"
export UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN}"
```

#### 2. 配置优先级

```
1. Infisical CLI (最高优先级)
   ↓ 失败
2. Infisical API + 重试
   ↓ 失败
3. 本地 .env 文件缓存
   ↓ 失败
4. 云服务商环境变量 (最低优先级)
   ↓ 失败
5. 应用启动失败
```

#### 3. 配置验证

**启动时验证**：
```javascript
// 在应用启动时验证关键配置
function validateConfig() {
  const required = ['INFISICAL_TOKEN', 'INFISICAL_PROJECT_ID'];
  const optional = [
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'QSTASH_TOKEN', 'OSS_WORKER_URL', 'OSS_WORKER_SECRET',
    'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET', 'AXIOM_TOKEN', 'AXIOM_ORG_ID', 'AXIOM_DATASET',
    'API_ID', 'API_HASH', 'BOT_TOKEN', 'OWNER_ID',
    'RCLONE_REMOTE', 'REMOTE_FOLDER', 'RCLONE_CONF_BASE64', 'PORT'
  ];
  
  // 检查必需变量
  for (const key of required) {
    if (!process.env[key]) {
      console.warn(`⚠️  缺少必需环境变量: ${key}`);
    }
  }
  
  // 统计可用的云服务商配置
  const availableCloudVars = optional.filter(key => process.env[key]);
  console.log(`✅ 找到 ${availableCloudVars.length} 个云服务商配置变量`);
}
```

### 云服务商配置的优势

#### 1. 高可用性
- **本地部署**：云平台环境变量总是可用
- **网络隔离**：不依赖外部服务
- **快速启动**：无需网络请求

#### 2. 安全性
- **集中管理**：通过云平台统一管理
- **访问控制**：基于 IAM 策略
- **审计日志**：配置变更可追踪

#### 3. 灵活性
- **多环境支持**：开发、测试、生产环境独立配置
- **动态更新**：无需重新部署即可更新配置
- **版本控制**：支持配置版本管理

### 故障场景处理

#### 场景 1：Infisical 服务完全不可用

**触发条件**：
- Infisical 服务宕机
- 网络完全中断
- API 密钥过期

**处理流程**：
```
1. CLI 模式失败 → 2. API 模式失败 → 3. 本地缓存失败 → 4. 使用云服务商配置
```

**结果**：应用正常启动，使用云平台配置

#### 场景 2：部分配置缺失

**触发条件**：
- Infisical 返回部分变量
- 云平台配置不完整

**处理流程**：
```
1. 从 Infisical 获取完整配置
2. 云平台配置作为补充
3. 合并配置（Infisical 优先）
```

**结果**：应用获得完整配置

#### 场景 3：配置冲突

**触发条件**：
- Infisical 和云平台都有相同变量
- 值不一致

**处理策略**：
```javascript
// 配置合并策略：Infisical 优先
function mergeConfigs(infisicalVars, cloudVars) {
  return {
    ...cloudVars,      // 云平台基础配置
    ...infisicalVars   // Infisical 覆盖优先
  };
}
```

### 实际部署示例

#### 完整的 Docker 部署（生产环境）

**Dockerfile**：
```dockerfile
FROM node:18-alpine

WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制应用代码
COPY . .

# 设置启动脚本
RUN echo '#!/bin/sh\n\
if [ -n "$INFISICAL_TOKEN" ]; then\n\
  echo "🚀 同步 Infisical 环境变量..."\n\
  node scripts/sync-env.js\n\
else\n\
  echo "⚠️  未设置 INFISICAL_TOKEN，使用云服务商配置"\n\
fi\n\
echo "🚀 启动应用..."\n\
exec node index.js' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
```

**部署命令**：
```bash
# 运行容器（使用云服务商配置作为降级）
docker run -d \
  -e INFISICAL_TOKEN="your-token" \
  -e INFISICAL_PROJECT_ID="your-project-id" \
  -e STRICT_SYNC=0 \
  -e UPSTASH_REDIS_REST_URL="https://redis.example.com" \
  -e UPSTASH_REDIS_REST_TOKEN="redis-token" \
  -e QSTASH_TOKEN="qstash-token" \
  -e OSS_WORKER_URL="https://oss.example.com" \
  -e OSS_WORKER_SECRET="oss-secret" \
  -e R2_ENDPOINT="https://r2.example.com" \
  -e R2_ACCESS_KEY_ID="r2-key" \
  -e R2_SECRET_ACCESS_KEY="r2-secret" \
  -e R2_BUCKET="my-bucket" \
  -e AXIOM_TOKEN="axiom-token" \
  -e AXIOM_ORG_ID="axiom-org" \
  -e AXIOM_DATASET="axiom-dataset" \
  -e API_ID="12345" \
  -e API_HASH="abc123" \
  -e BOT_TOKEN="bot-token" \
  -e OWNER_ID="123456789" \
  -e RCLONE_REMOTE="my-remote" \
  -e REMOTE_FOLDER="/backup" \
  -e RCLONE_CONF_BASE64="base64-encoded-config" \
  -e PORT=7860 \
  -p 7860:7860 \
  --name my-app \
  my-app:latest
```

#### 云平台一键部署

**AWS CloudFormation 模板**：
```yaml
AWSTemplateFormatVersion: '2010-09-09'
Resources:
  MyApp:
    Type: AWS::ECS::TaskDefinition
    Properties:
      Family: my-app
      ContainerDefinitions:
        - Name: my-app
          Image: my-app:latest
          Environment:
            - Name: INFISICAL_TOKEN
              Value: !Ref InfisicalToken
            - Name: INFISICAL_PROJECT_ID
              Value: !Ref InfisicalProjectId
            - Name: STRICT_SYNC
              Value: "0"
            - Name: UPSTASH_REDIS_REST_URL
              Value: !Ref RedisUrl
            - Name: UPSTASH_REDIS_REST_TOKEN
              Value: !Ref RedisToken
            - Name: QSTASH_TOKEN
              Value: !Ref QStashToken
          Secrets:
            - Name: INFISICAL_TOKEN
              ValueFrom: !Ref InfisicalTokenSecret
            - Name: INFISICAL_PROJECT_ID
              ValueFrom: !Ref InfisicalProjectIdSecret
```

### 配置同步状态监控

**健康检查端点**：
```javascript
// 在应用中添加配置状态检查
app.get('/health/config', (req, res) => {
  const config = {
    infisical: {
      token: !!process.env.INFISICAL_TOKEN,
      projectId: !!process.env.INFISICAL_PROJECT_ID,
      available: process.env.INFISICAL_TOKEN && process.env.INFISICAL_PROJECT_ID
    },
    cloud: {
      redis: !!process.env.UPSTASH_REDIS_REST_URL,
      qstash: !!process.env.QSTASH_TOKEN,
      oss: !!process.env.OSS_WORKER_URL,
      r2: !!process.env.R2_ENDPOINT,
      axiom: !!process.env.AXIOM_TOKEN,
      telegram: !!process.env.BOT_TOKEN,
      rclone: !!process.env.RCLONE_REMOTE
    },
    syncMode: process.env.STRICT_SYNC === '1' ? 'strict' : 'fallback',
    timestamp: new Date().toISOString()
  };
  
  res.json(config);
});
```

通过这种配置支持，系统具备了在任何云环境中稳定运行的能力，同时保持了配置的灵活性和安全性。

## 降级机制

### 1. 完整降级链（4级降级）

**优化后的降级方案**：
```
第1级: Infisical CLI 模式
       ↓ 失败
第2级: Infisical API 模式 (带3次重试)
       ↓ 失败
第3级: 本地 .env 文件缓存
       ↓ 失败
第4级: 云服务商 Dashboard 配置的环境变量
       ↓ 失败
      ❌ 所有方案失败 → 退出
```

**降级策略**：
- **严格模式 (STRICT_SYNC=1)**: CLI → API (重试3次) → 失败退出
- **非严格模式 (STRICT_SYNC=0)**: CLI → API (重试3次) → 本地缓存 → 云服务商配置 → 失败退出

### 2. CLI 模式（第1级）

**特点**：
- 性能最好，推荐使用
- 需要安装 Infisical CLI 工具
- 自动处理引号问题

**执行命令**：
```bash
infisical export --env=prod --projectId=xxx --format=dotenv
```

**失败场景**：
- 未安装 Infisical CLI
- CLI 命令执行错误
- 网络连接问题

### 3. API 模式（第2级）

**特点**：
- 无需安装 CLI 工具
- 使用 REST API 获取密钥
- 带自动重试机制

**重试策略**：
```javascript
const MAX_RETRIES = 3; // API 最大重试次数
const RETRY_DELAY = 1000; // 重试延迟（毫秒）
```

**重试流程**：
```
API 调用失败 → 等待 1s → 第 2 次尝试 → 等待 1s → 第 3 次尝试 → 决定降级策略
```

**失败场景**：
- INFISICAL_TOKEN 无效
- 网络连接问题
- Infisical 服务不可用
- API 限流

### 4. 本地 .env 文件缓存（第3级）

**特点**：
- 离线可用
- 快速响应
- 需要提前准备

**缓存检查逻辑**：
```javascript
function checkLocalCache() {
    if (fs.existsSync(envFilePath)) {
        const envVars = readEnvFile();
        if (Object.keys(envVars).length > 0) {
            return envVars; // 返回缓存的变量
        }
    }
    return null; // 缓存不可用
}
```

**使用场景**：
- 开发环境离线工作
- Infisical 服务临时不可用
- 网络不稳定环境
- 快速启动测试

**准备方法**：
```bash
# 1. 正常同步一次
export INFISICAL_TOKEN="xxx"
export INFISICAL_PROJECT_ID="xxx"
node scripts/sync-env.js

# 2. 备份 .env 文件
cp .env .env.backup

# 3. 后续可使用备份
cp .env.backup .env
export STRICT_SYNC=0
node scripts/sync-env.js
```

### 5. 云服务商 Dashboard 配置（第4级）

**特点**：
- 从当前进程环境变量提取
- 无需额外配置
- 作为最终保底方案

**支持的变量列表**：
```javascript
const cloudVariables = [
    // Cloudflare 相关
    'CF_CACHE_ACCOUNT_ID', 'CF_CACHE_NAMESPACE_ID', 'CF_CACHE_TOKEN',
    'CF_KV_ACCOUNT_ID', 'CF_KV_NAMESPACE_ID', 'CF_KV_TOKEN',
    
    // Upstash 相关
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    
    // QStash 相关
    'QSTASH_AUTH_TOKEN', 'QSTASH_TOKEN', 'QSTASH_CURRENT_SIGNING_KEY',
    'QSTASH_NEXT_SIGNING_KEY', 'QSTASH_URL', 'LB_WEBHOOK_URL',
    
    // OSS 相关
    'OSS_WORKER_URL', 'OSS_WORKER_SECRET',
    
    // R2 相关
    'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
    'R2_BUCKET', 'R2_PUBLIC_URL',
    
    // Axiom 相关
    'AXIOM_TOKEN', 'AXIOM_ORG_ID', 'AXIOM_DATASET',
    
    // Redis 相关
    'REDIS_URL', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD', 'REDIS_TOKEN',
    'NF_REDIS_URL', 'NF_REDIS_HOST', 'NF_REDIS_PORT', 'NF_REDIS_PASSWORD',
    
    // Telegram 相关
    'API_ID', 'API_HASH', 'BOT_TOKEN', 'OWNER_ID',
    
    // Rclone 相关
    'RCLONE_REMOTE', 'REMOTE_FOLDER', 'RCLONE_CONF_BASE64',
    
    // Worker 配置
    'PORT'
];
```

**使用场景**：
- 云服务商部署时自动注入
- 容器化部署
- CI/CD 环境
- 作为最终保底方案

### 6. 严格模式开关

**STRICT_SYNC 环境变量**：
- `STRICT_SYNC=1`（默认）：严格模式，必须成功同步
- `STRICT_SYNC=0`：非严格模式，允许降级

**严格模式行为**：
```
CLI 失败 → API 失败（3 次重试）→ ❌ 直接退出（不允许降级）
```

**非严格模式行为**：
```
CLI 失败 → API 失败（3 次重试）→ 本地缓存 → 云服务商配置 → ✅ 成功或退出
```

### 7. 引号处理机制

**核心问题**：
Infisical 在某些情况下会返回带引号的值，例如：
- `KEY="value"` 或 `KEY='value'`
- JSON 格式的值：`{"key": "value"}`
- 包含特殊字符的值：`KEY="value with spaces"`

**自动引号去除逻辑**：
```javascript
function stripQuotes(value) {
    if (typeof value !== 'string') return value;
    
    let trimmed = value.trim();
    
    // 检查并去除外层引号（支持单引号、双引号）
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || 
        (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
        return trimmed.slice(1, -1);
    }
    
    return trimmed;
}
```

**处理场景**：
- CLI 导出的带引号值：`KEY="value"`
- API 返回的带引号值：`"value"` 或 `'value'`
- .env 文件中的带引号值：`KEY="value"`
- 云服务商环境变量的带引号值

**实际应用示例**：
```javascript
// 输入：Infisical 返回 "my-secret-value"
// 输出：my-secret-value

// 输入：Infisical 返回 '{"api_key": "abc123"}'
// 输出：{"api_key": "abc123"}（保持 JSON 格式）

// 输入：Infisical 返回 'value with spaces'
// 输出：value with spaces
```

**引号处理的优势**：
- ✅ 自动清理，无需手动干预
- ✅ 保持数据完整性
- ✅ 兼容各种格式（字符串、JSON、特殊字符）
- ✅ 避免因引号导致的配置错误

### 8. 完整降级流程图

```
┌─────────────────────────────────────────┐
│         启动同步脚本                      │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│      第1级: CLI 模式                      │
│      (infisical CLI)                     │
└──────────────────┬──────────────────────┘
                   │ 失败
                   ▼
┌─────────────────────────────────────────┐
│      第2级: API 模式                      │
│      (REST API)                          │
└──────────────────┬──────────────────────┘
                   │ 失败
                   ▼
┌─────────────────────────────────────────┐
│      重试 3 次                           │
│      (每次间隔 1s)                       │
└──────────────────┬──────────────────────┘
                   │ 最终失败
                   ▼
┌─────────────────────────────────────────┐
│      检查模式开关                        │
│      STRICT_SYNC?                        │
└──────────┬──────────────────────────────┘
           │
      ┌────┴────┐
      │         │
      ▼         ▼
    严格      非严格
     │         │
     │         ▼
     │    ┌──────────────────┐
     │    │  第3级: 本地缓存  │
     │    │  (.env 文件)     │
     │    └──────┬───────────┘
     │           │ 失败
     │           ▼
     │    ┌──────────────────┐
     │    │  第4级: 云配置    │
     │    │  (Dashboard)     │
     │    └──────┬───────────┘
     │           │ 失败
     │           ▼
     │      ┌──────────┐
     │      │   失败   │
     │      │  退出   │
     │      └──────────┘
     │
     ▼
┌──────────┐
│  成功    │
│  继续运行│
└──────────┘
```

### 9. 降级方案检查清单

当遇到同步问题时，按以下顺序尝试：

- [ ] **第1级：CLI 模式**
  - [ ] 检查是否安装 `infisical` 命令
  - [ ] 验证 `INFISICAL_PROJECT_ID` 是否正确
  - [ ] 检查网络连接

- [ ] **第2级：API 模式**
  - [ ] 验证 `INFISICAL_TOKEN` 是否有效
  - [ ] 等待 3 次重试完成
  - [ ] 检查 Infisical 服务状态

- [ ] **第3级：本地缓存**
  - [ ] 设置 `STRICT_SYNC=0`
  - [ ] 检查 `.env` 文件是否存在
  - [ ] 验证 `.env` 文件内容
  - [ ] 必要时从 `.env.example` 创建

- [ ] **第4级：云服务商配置**
  - [ ] 检查云平台环境变量设置
  - [ ] 验证必要的变量是否已配置
  - [ ] 确认环境变量已注入到进程

- [ ] **手动干预**
  - [ ] 从其他环境复制配置
  - [ ] 手动创建 `.env` 文件
  - [ ] 联系运维团队获取备份配置

## 使用场景

### 开发环境（推荐 STRICT_SYNC=0）

**推荐配置**：
```bash
# 开发环境配置
export INFISICAL_TOKEN="your-dev-token"
export INFISICAL_PROJECT_ID="your-project-id"
export STRICT_SYNC=0  # 允许降级，提高开发效率

# 启动应用
npm run dev
```

**优势**：
- ✅ 网络波动时不影响开发
- ✅ Infisical 服务临时不可用仍可工作
- ✅ 可使用本地 `.env` 文件快速测试
- ✅ 减少开发环境的依赖

**典型场景**：
- 本地开发调试
- 离线开发
- Infisical 服务维护期间
- 网络不稳定环境

### 生产环境（默认 STRICT_SYNC=1）

**推荐配置**：
```bash
# 生产环境配置
export INFISICAL_TOKEN="${INFISICAL_TOKEN}"  # 从 secrets 获取
export INFISICAL_PROJECT_ID="${INFISICAL_PROJECT_ID}"
export STRICT_SYNC=1  # 严格模式，确保配置正确

# 启动应用
npm start
```

**优势**：
- ✅ 确保配置完全同步
- ✅ 配置错误时快速失败
- ✅ 避免使用过期的本地缓存
- ✅ 强制验证 Infisical 连接

**典型场景**：
- 生产部署
- CI/CD 流水线
- 自动化部署
- 关键业务环境

### 混合场景

**CI/CD 构建阶段**：
```yaml
# 构建时使用严格模式
- name: Sync Config
  env:
    INFISICAL_TOKEN: ${{ secrets.INFISICAL_TOKEN }}
    INFISICAL_PROJECT_ID: ${{ secrets.INFISICAL_PROJECT_ID }}
    STRICT_SYNC: 1
  run: npm run sync:env
```

**Docker 运行时**：
```bash
# 运行时可使用非严格模式
docker run -d \
  -e INFISICAL_TOKEN="xxx" \
  -e INFISICAL_PROJECT_ID="xxx" \
  -e STRICT_SYNC=0 \
  -p 7860:7860 \
  my-app
```

## 故障排除指南

### Infisical 服务不可用时的处理

**症状**：
- API 调用超时
- 返回 HTTP 5xx 错误
- 连接被拒绝

**应对策略**：

1. **开发环境**：
   ```bash
   # 方案 A：使用本地缓存
   export STRICT_SYNC=0
   node scripts/sync-env.js
   
   # 方案 B：手动准备 .env 文件
   cp .env.example .env
   # 编辑 .env 填入必要配置
   ```

2. **生产环境**：
   ```bash
   # 方案 A：等待服务恢复后重试
   # 方案 B：准备备用配置
   export INFISICAL_TOKEN="备用-token"
   export INFISICAL_PROJECT_ID="备用-project-id"
   npm run sync:env
   ```

3. **紧急启动**：
   ```bash
   # 使用本地配置文件
   export STRICT_SYNC=0
   # 确保 .env 文件存在且有效
   node scripts/sync-env.js
   ```

### 网络问题的应对

**常见网络问题**：
- DNS 解析失败
- 代理配置错误
- 防火墙限制
- 网络分区

**诊断步骤**：

1. **检查网络连接**：
   ```bash
   # 测试网络连通性
   ping app.infisical.com
   curl -I https://app.infisical.com/api/v3/health
   
   # 检查代理设置
   echo $HTTP_PROXY
   echo $HTTPS_PROXY
   ```

2. **验证 DNS 解析**：
   ```bash
   nslookup app.infisical.com
   dig app.infisical.com
   ```

3. **测试 API 访问**：
   ```bash
   # 手动测试 API
   curl -H "Authorization: Bearer $INFISICAL_TOKEN" \
     "https://app.infisical.com/api/v3/secrets/raw?workspaceId=$INFISICAL_PROJECT_ID&environment=prod"
   ```

**解决方案**：

```bash
# 1. 配置代理（如果需要）
export HTTP_PROXY="http://proxy.company.com:8080"
export HTTPS_PROXY="http://proxy.company.com:8080"

# 2. 使用备用 DNS
# 修改 /etc/hosts 或 DNS 配置

# 3. 降级到本地缓存
export STRICT_SYNC=0
node scripts/sync-env.js

# 4. 手动准备配置
# 复制 .env.example 并手动填写
```

### 如何手动降级

**场景 1：临时禁用 Infisical 同步**

```bash
# 方法 A：使用本地 .env 文件
export STRICT_SYNC=0
# 确保 .env 文件存在
node scripts/sync-env.js  # 会使用本地缓存

# 方法 B：直接使用 .env 文件
# 跳过同步脚本，直接启动应用
NODE_MODE=dev node index.js
```

**场景 2：准备本地缓存文件**

```bash
# 1. 从 Infisical 导出当前配置
export INFISICAL_TOKEN="your-token"
export INFISICAL_PROJECT_ID="your-project-id"
node scripts/sync-env.js

# 2. 备份 .env 文件
cp .env .env.backup

# 3. 后续可使用备份
cp .env.backup .env
export STRICT_SYNC=0
node scripts/sync-env.js
```

**场景 3：Docker 环境降级**

```bash
# 1. 准备本地 .env 文件
# 2. 挂载到容器中
docker run -d \
  -v $(pwd)/.env:/app/.env \
  -e STRICT_SYNC=0 \
  -p 7860:7860 \
  my-app

# 或者完全跳过同步
docker run -d \
  -v $(pwd)/.env:/app/.env \
  -e INFISICAL_TOKEN="" \
  -p 7860:7860 \
  my-app
```

**场景 4：CI/CD 环境降级**

```yaml
# GitHub Actions 示例
- name: Sync with fallback
  env:
    INFISICAL_TOKEN: ${{ secrets.INFISICAL_TOKEN }}
    INFISICAL_PROJECT_ID: ${{ secrets.INFISICAL_PROJECT_ID }}
    STRICT_SYNC: ${{ secrets.STRICT_SYNC || '0' }}
  run: |
    # 尝试同步，失败则使用缓存
    npm run sync:env || echo "使用本地缓存"
    
- name: Verify config
  run: |
    if [ ! -f .env ]; then
      echo "错误：缺少配置文件"
      exit 1
    fi
```

### 降级方案检查清单

当遇到同步问题时，按以下顺序尝试：

- [ ] **检查基础配置**
  - [ ] INFISICAL_TOKEN 是否设置？
  - [ ] INFISICAL_PROJECT_ID 是否正确？
  - [ ] 网络连接是否正常？

- [ ] **尝试自动重试**
  - [ ] 等待 3 秒（3 次重试）
  - [ ] 检查重试日志

- [ ] **启用降级模式**
  - [ ] 设置 `STRICT_SYNC=0`
  - [ ] 重新运行同步脚本

- [ ] **使用本地缓存**
  - [ ] 检查 `.env` 文件是否存在
  - [ ] 验证 `.env` 文件内容
  - [ ] 必要时从 `.env.example` 创建

- [ ] **使用云服务商配置**
  - [ ] 检查云平台环境变量设置
  - [ ] 验证必要的变量是否已配置

- [ ] **手动干预**
  - [ ] 从其他环境复制配置
  - [ ] 手动创建 `.env` 文件
  - [ ] 联系运维团队获取备份配置

### 监控和日志

**查看同步日志**：
```bash
# 运行同步脚本查看详细日志
node scripts/sync-env.js

# 输出示例：
# 🚀 开始同步 Infisical 环境变量...
# 📋 配置信息:
#    严格模式: ON (必须成功)
#    重试次数: 3
#    本地缓存: 可用
# 🔍 检测到 Infisical CLI，使用 CLI 模式...
# ✅ 已更新 .env 文件，共 25 个变量
```

**错误诊断**：
```bash
# 详细错误信息
DEBUG=1 node scripts/sync-env.js

# 检查退出码
echo $?
# 0 = 成功
# 1 = 失败
```

### 最佳实践总结

1. **开发环境**：始终使用 `STRICT_SYNC=0`
2. **生产环境**：使用 `STRICT_SYNC=1`，但准备应急预案
3. **定期备份**：定期导出并备份 `.env` 文件
4. **监控告警**：设置 Infisical 服务健康监控
5. **文档化**：记录所有降级操作和恢复流程

通过这套完善的降级方案，系统具备了强大的容错能力，能够在各种异常情况下保持可用性。

## 环境变量配置

### 必需变量

- `INFISICAL_TOKEN` - Infisical API Token
- `INFISICAL_PROJECT_ID` - 项目 ID

### 可选变量

- `INFISICAL_ENV` - 环境名称（默认：`prod`）
- `INFISICAL_SECRET_PATH` - 密钥路径（默认：`/`）
- `STRICT_SYNC` - 严格模式开关（默认：`1`）

## 工作流程

### 1. 本地开发
```
设置 INFISICAL_TOKEN → npm run sync:env → 生成 .env → 启动应用
```

### 2. Docker 运行
```
docker run (带 INFISICAL_TOKEN) → 容器启动 → sync-env → 生成 .env → 启动应用
```

### 3. CI/CD 构建
```
CI 设置 INFISICAL_TOKEN → npm run sync:env → 生成 .env → npm test → docker build
```

### 4. Docker 构建（可选）
```
docker build --build-arg INFISICAL_TOKEN → 构建阶段同步 → 运行测试 → 生成镜像
```

## 最佳实践

1. **统一使用 Infisical**：所有环境变量都从 Infisical 获取，避免分散管理
2. **本地开发**：设置 `INFISICAL_TOKEN` 环境变量，使用 `npm run dev`
3. **Docker 部署**：使用运行时同步，传递 `INFISICAL_TOKEN`
4. **CI/CD**：在 CI 中设置 `INFISICAL_TOKEN`，使用 `npm run sync:env`，并添加引号清理步骤
5. **安全**：永远不要提交 `.env` 文件到 Git
6. **备份**：定期备份 Infisical 配置
7. **降级准备**：开发环境使用 `STRICT_SYNC=0`，生产环境准备应急预案
8. **引号处理**：CI 中自动清理，本地脚本内置处理，确保值纯净

## CI/CD 中的引号处理

### 问题背景
Infisical 返回的环境变量值可能包含额外的引号：
- `KEY="value"` - 双引号包裹
- `KEY='value'` - 单引号包裹
- `KEY="it's a test"` - 值内部包含引号

### 解决方案
**运行时模式**：`InfisicalClient` 已内置引号去除逻辑，无需额外处理。

**传统模式**（仅开发）：`sync:env` 脚本会自动清理引号。

```yaml
# .github/workflows/ci.yml (仅开发环境需要)
- name: Sync environment variables from Infisical
  run: npm run sync:env

- name: Clean up quotes in environment variables
  if: success() || failure()
  run: |
    if [ -f .env ]; then
      # 移除值中的外层引号
      sed -i 's/="\([^"]*\)"/=\1/g' .env
      sed -i "s/='\([^']*\)'/=\1/g" .env
      # 移除值开头和结尾的引号
      sed -i 's/^"\(.*\)"$/\1/' .env
      sed -i "s/^'\(.*\)'$/\1/" .env
      echo "✅ Quotes cleaned up"
    fi
```

### 处理示例
| 原始值 | 处理后 |
|--------|--------|
| `API_KEY="abc123"` | `API_KEY=abc123` |
| `BOT_TOKEN='xyz789'` | `BOT_TOKEN=xyz789` |
| `MESSAGE="Hello \"World\""` | `MESSAGE=Hello "World"` |
| `URL=https://example.com` | `URL=https://example.com` (不变) |

### 本地开发
本地 `scripts/sync-env.js` 已内置 `stripQuotes()` 函数，会自动处理引号，无需额外步骤。

### CI/CD 完整流程
```yaml
# 完整的 CI/CD 引号处理流程
- name: Sync from Infisical
  env:
    INFISICAL_TOKEN: ${{ secrets.INFISICAL_TOKEN }}
    INFISICAL_PROJECT_ID: ${{ secrets.INFISICAL_PROJECT_ID }}
  run: npm run sync:env

- name: Clean up quotes
  if: success() || failure()
  run: |
    if [ -f .env ]; then
      sed -i 's/="\([^"]*\)"/=\1/g' .env
      sed -i "s/='\([^']*\)'/=\1/g" .env
      sed -i 's/^"\(.*\)"$/\1/' .env
      sed -i "s/^'\(.*\)'$/\1/" .env
    fi

- name: Verify environment
  run: |
    # 验证关键变量已正确设置
    if [ -z "$BOT_TOKEN" ]; then
      echo "❌ BOT_TOKEN is missing"
      exit 1
    fi
    echo "✅ Environment is ready"

## 优势

### 统一性
- 无论在哪里构建，流程一致
- 减少配置差异导致的问题
- 便于维护和调试

### 安全性
- 敏感信息集中管理
- 避免在多个地方重复配置
- 支持密钥轮换和版本控制

### 灵活性
- 支持多种构建环境
- 可选择 CLI 或 API 模式
- 适应不同的部署需求

### 容错性
- 3 次自动重试机制
- 本地缓存降级支持
- 严格/非严格模式切换
- 完善的故障恢复流程
- 4级降级链保障

## 相关文件

- `scripts/sync-env.js` - 主同步脚本（包含降级逻辑）
- `Dockerfile` - 容器构建文件
- `package.json` - npm 脚本定义
- `.github/workflows/deploy-example.yml` - CI/CD 示例
- `docs/DEPLOYMENT_CONFIG.md` - 部署配置指南

## 参考资料

- [Infisical 官方文档](https://infisical.com/docs)
- [Docker 环境变量文档](https://docs.docker.com/engine/reference/run/#env-environment-variables)
- [GitHub Actions 环境变量](https://docs.github.com/en/actions/learn-github-actions/variables)