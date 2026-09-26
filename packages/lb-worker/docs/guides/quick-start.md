# 🚀 快速开始指南

欢迎使用 Load Balancer Worker！本指南将在5分钟内帮助你从零开始部署一个完整的生产就绪负载均衡器。

## 📋 前置要求

### 必需工具
```bash
# Node.js 20+
node --version

# npm 或 yarn
npm --version

# Git (可选，用于版本控制)
git --version
```

### 平台支持
- ✅ **Windows** (Windows 10/11)
- ✅ **macOS** (10.15+)
- ✅ **Linux** (Ubuntu 18.04+, CentOS 8+)
- ✅ **GitHub Actions** (CI/CD)

## 🚀 5分钟快速部署

### 步骤 1: 克隆项目

```bash
git clone https://github.com/your-org/lb-worker-js.git
cd lb-worker-js
```

### 步骤 2: 安装依赖

```bash
npm install
```

### 步骤 3: 配置Cloudflare

创建 Cloudflare 账户并获取必要信息：

```bash
# 1. 登录 Cloudflare Dashboard
# https://dash.cloudflare.com/

# 2. 获取 Account ID
# 在侧边栏 "Overview" 页面找到

# 3. 创建 KV Namespace
# 前往 "Workers & Pages" → "KV" → "Create namespace"

# 4. 创建 API Token
# 前往 "My Profile" → "API Tokens" → "Create Token"
# 权限: Account:read, Zone:read, Worker:edit
```

### 步骤 4: 配置环境变量

复制配置模板：

```bash
# 复制基础配置
cp .env.example .env

# 编辑配置文件
nano .env  # 或使用你喜欢的编辑器
```

**必填配置**:
```bash
# Cloudflare 配置
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
CF_KV_NAMESPACE_ID=your-kv-namespace-id

# Worker 名称
WORKER_NAME=lb-worker-prod

# 环境设置
NODE_ENV=prod
```

### 步骤 5: 配置 Secrets Provider

#### 选择方案 A: Infisical (推荐企业用户)

```bash
# 安装 Infisical CLI
npm install -g @infisical/cli

# 登录 Infisical
infisical login

# 获取项目信息
infisical projects list

# 设置环境变量
INFISICAL_PROJECT_ID=your-project-id
INFISICAL_TOKEN=your-service-token
```

#### 选择方案 B: Doppler (推荐新用户)

```bash
# 安装 Doppler CLI
npm install -g @dopplerhq/cli

# 登录 Doppler
doppler login

# 创建项目
doppler projects create lb-worker-prod

# 设置环境变量
SECRETS_PROVIDER=doppler
DOPPLER_PROJECT=lb-worker-prod
DOPPLER_TOKEN=dp.st.dev.xxxxxx
```

#### 选择方案 C: 传统 .env 文件

直接在 `.env` 文件中设置所有secrets：

```bash
# Webhook 签名验证
QSTASH_CURRENT_SIGNING_KEY=your-qstash-key
QSTASH_NEXT_SIGNING_KEY=your-next-qstash-key

# Redis 缓存 (可选)
UPSTASH_REDIS_REST_URL=redis://user:pass@host:port
UPSTASH_REDIS_REST_TOKEN=your-redis-token

# 日志服务 (可选)
AXIOM_TOKEN=your-axiom-token
AXIOM_DATASET=lb-worker-logs
AXIOM_ORG_ID=your-axiom-org-id
```

### 步骤 6: 选择部署方式

#### 开发环境 (本地测试)
```bash
# 本地开发模式
npm run dev:dev

# 远程开发模式 (使用真实 Cloudflare 资源)
npm run dev:prod
```

#### 生产环境部署
```bash
# 使用增强构建 (推荐)
npm run deploy:prod

# 或使用传统构建
npm run build && npm run deploy
```

## ✅ 验证部署

### 检查部署状态
```bash
# 1. 检查 Worker 状态
npm run wrangler -- tail

# 2. 测试健康检查
curl https://your-worker.your-subdomain.workers.dev/health

# 3. 检查管理 API
curl https://your-worker.your-subdomain.workers.dev/api/instances
```

### 预期响应
健康检查应该返回：
```json
{
  "status": "healthy",
  "timestamp": "2024-01-16T20:30:00.000Z",
  "version": "1.3.1",
  "environment": "prod"
}
```

## 🔧 高级配置

### 自定义缓存策略
```bash
# 配置多级缓存 (KV + Redis)
CACHE_PROVIDERS='[
  {
    "name": "kv-primary",
    "type": "cloudflare-kv-binding",
    "binding": "KV_STORAGE",
    "priority": 1
  },
  {
    "name": "redis-backup", 
    "type": "redis",
    "url": "redis://user:pass@host:port",
    "priority": 2
  }
]'
```

### 负载均衡策略
```bash
# 默认轮询，可在 manifest.json 中配置
# 支持策略：
# - round-robin: 轮询
# - weighted: 权重
# - health-based: 基于健康状态
```

### Webhook 配置
```bash
# 签名过期时间 (秒)
SIGNATURE_EXPIRATION_WINDOW=900

# 跳过签名验证 (仅测试)
SKIP_SIGNATURE_VERIFY=false
```

## 🧪 测试部署

### 本地测试
```bash
# 运行单元测试
npm test

# 运行集成测试
npm run test:integration

# 运行性能测试
npm run test:performance
```

### 端到端测试
```bash
# 测试完整流程
npm run test:e2e

# 测试 secrets 管理
npm test secrets
```

## 🚨 故障排除

### 常见问题

#### 1. "Account ID not found"
```bash
❌ Error: Account ID not found
```
**解决方案**: 检查 `CLOUDFLARE_ACCOUNT_ID` 格式，应该为32位字符。

#### 2. "KV namespace not bound"
```bash
❌ Error: KV namespace not bound
```
**解决方案**: 确保 `CF_KV_NAMESPACE_ID` 在 `wrangler.toml` 中正确配置。

#### 3. "Secrets not found"
```bash
❌ Error: Required secrets missing
```
**解决方案**: 
- 检查 secrets provider 配置
- 验证 API tokens 有效性
- 查看 secrets 注入日志

### 调试模式

启用详细日志：
```bash
# 启用调试日志
DEBUG_LOGS=true npm run deploy:prod

# 预览构建过程
npm run build:enhanced -- --env=prod --dry-run
```

## 📊 性能优化

### 推荐配置
```bash
# 生产环境优化
NODE_ENV=prod
DEBUG_LOGS=false
SIGNATURE_EXPIRATION_WINDOW=300  # 5分钟

# 缓存优化
CACHE_PROVIDERS='[{"name":"kv","type":"cloudflare-kv-binding","priority":1}]'
```

### 监控指标
```bash
# 启用 Axiom 日志
AXIOM_TOKEN=your-token
AXIOM_DATASET=lb-worker-metrics
AXIOM_ORG_ID=your-org-id
```

## 🎉 恭喜！

你已经成功部署了 Load Balancer Worker！🎉

### 下一步建议

1. **查看完整文档**: [📚 文档导航](../docs/README.md)
2. **配置监控**: 设置 Axiom 日志和告警
3. **设置 CI/CD**: 配置 GitHub Actions 自动部署
4. **性能调优**: 根据实际负载调整配置
5. **安全加固**: 定期轮换 API tokens 和 secrets

### 获取帮助

- 📖 [完整文档](../docs/README.md)
- 🐛 [问题反馈](https://github.com/your-org/lb-worker-js/issues)
- 💬 [社区讨论](https://github.com/your-org/lb-worker-js/discussions)
- 📧 [架构指南](../docs/architecture/system-overview.md)

---

**🚀 现在就去构建你的高可用负载均衡器吧！**