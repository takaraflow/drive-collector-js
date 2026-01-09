# LB Worker JS

Load Balancer Worker for drive-collector.

## 文档

- [管理员 API 文档](./docs/ADMIN_API.md) - 管理员接口使用指南
- [鉴权配置指南](./docs/AUTHENTICATION.md) - 完整的鉴权配置说明  
- [API 接口契约](./docs/CONTRACT.md) - 详细的 API 契约文档

## 本地开发与测试

### 环境要求
- Node.js ^20.0.0
- Docker Desktop (用于本地模拟 GHA)
- act (用于本地运行 GitHub Actions)

### 快速开始

1. **安装依赖**
   ```bash
   npm install
   ```

2. **本地开发**
   ```bash
   npm run dev
   ```

3. **运行测试**
    ```bash
    npm test
    ```

## 管理员 API

LB Worker 提供管理员 API 用于监控和管理负载均衡器状态：

### 快速开始

1. **配置管理员 Token**:
    ```bash
    export ADMIN_API_TOKEN="your-secure-admin-token"
    ```

2. **获取实例信息**:
    ```bash
    curl -H "Authorization: Bearer $ADMIN_API_TOKEN" \
         https://your-worker.com/api/instances
    ```

3. **健康检查**:
    ```bash
    curl https://your-worker.com/health
    ```

### 主要功能

- 🔐 **安全访问控制** - 基于 Token 的身份验证
- 📊 **实例状态监控** - 获取活跃实例列表和统计信息
- 🏥️ **健康状态检查** - 无需认证的基本健康检查
- 📈 **缓存提供者信息** - 查看当前使用的缓存后端

详细文档请参考：[管理员 API 文档](./docs/ADMIN_API.md)

## 环境约定
- 环境缩写：`dev`（开发）、`pre`（预发布）、`prod`（线上）
- 非线上环境 Worker 命名：`{env}-lb-worker-js`（例如 `dev-lb-worker-js`、`pre-lb-worker-js`），线上保持 `lb-worker-js`
- `.env` 读取优先级：`.env.<env>` > `.env`

## 本地模拟 GitHub Actions

本项目支持在本地使用 `act` 工具模拟 GitHub Actions 的执行流程，这对于调试 CI/CD 流程非常有用。

### 前置准备

1. **安装 Docker** (Windows/Mac 请安装 Docker Desktop)
2. **安装 act**:
   - Windows (Winget): `winget install nektos.act`
   - Windows (Scoop): `scoop install act`
   - macOS: `brew install act`

### 配置本地 Secrets

GitHub Actions 依赖的敏感信息需要在本地创建一个文件来模拟。

1. 复制模板文件：
   ```bash
   cp .act.secrets.example .act.secrets
   ```

2. 编辑 `.act.secrets` 并填入真实的值：
   ```ini
   INFISICAL_TOKEN=你的_Infisical_Token
   BARK_WEBHOOK_URL=你的_Bark_Webhook_URL
   BARK_DEVICE_TOKEN=你的_Bark_设备密钥
   INFISICAL_PROJECT_ID=你的_Infisical_项目ID
   ```

### 运行模拟

#### 1. 查看可用的工作流
```bash
act --list
```

#### 2. 运行部署工作流 (Deploy)
使用 npm 脚本快速切换环境：
```bash
npm run gha:dev   # 开发环境模拟
npm run gha:pre   # 预发环境模拟
npm run gha:prod  # 生产环境模拟
```

#### 3. 运行同步清单工作流 (Sync Manifest)
```bash
act push -j update-registry --secret-file .act.secrets
```

#### 4. 使用完整镜像 (推荐)
如果你遇到环境缺失问题（如缺少 Node.js 或 apt-get），可以指定使用功能完整的镜像（可与上面的 npm 脚本组合使用）：
```bash
act push -j deploy --secret-file .act.secrets --eventpath event.json -P ubuntu-latest=catthehacker/ubuntu:act-latest
```

### 常见问题

**Q: 提示 "permission denied" 或找不到文件？**
A: 在 Windows 上，尝试以管理员身份运行终端。

**Q: 为什么需要 `.act.secrets` 文件？**
A: 因为 `deploy.yml` 工作流需要 `INFISICAL_TOKEN` 来获取生产环境的密钥。本地模拟时无法访问 GitHub Secrets，所以需要手动提供。

**Q: 如何清理 act 产生的容器？**
A: `docker system prune`

## 脚本说明

- `npm run deploy:dev|pre|prod`: 构建并部署到对应环境的 Cloudflare Workers
- `npm run gha:dev|pre|prod`: 使用 act 本地模拟 GitHub Actions 部署对应环境
- `npm run validate:manifest`: 验证 manifest.json 格式
- `npm run diagnose:axiom`: 诊断 Axiom 日志

## 安全配置

项目支持多种鉴权机制，确保不同场景的安全性：

### 鉴权类型

| 类型 | 用途 | 配置文档 |
|------|------|----------|
| QStash 签名验证 | 处理来自消息队列的 Webhook 请求 | [鉴权配置指南](./docs/AUTHENTICATION.md#1-qstash-签名验证) |
| 管理员 Token | 管理 API 接口访问控制 | [鉴权配置指南](./docs/AUTHENTICATION.md#2-管理员-token-认证) |

### 环境变量

```bash
# 生产环境
ADMIN_API_TOKEN=your-secure-admin-token
QSTASH_CURRENT_SIGNING_KEY=your-signing-key
SKIP_SIGNATURE_VERIFY=false
SKIP_ADMIN_AUTH=false

# 开发环境（跳过验证）
SKIP_SIGNATURE_VERIFY=true
SKIP_ADMIN_AUTH=true
```

**⚠️ 安全提醒**:
- 生产环境必须配置强密码 Token
- 定期轮换签名密钥和访问令牌
- 使用环境变量或安全的 secret 管理系统

详细配置请参考：[鉴权配置指南](./docs/AUTHENTICATION.md)

## License

ISC
