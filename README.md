# LB Worker JS

Load Balancer Worker for drive-collector.

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
这将模拟 `push` 事件并执行 `deploy` 作业：
```bash
act push -j deploy --secret-file .act.secrets --eventpath event.json
```

#### 3. 运行同步清单工作流 (Sync Manifest)
```bash
act push -j update-registry --secret-file .act.secrets
```

#### 4. 使用完整镜像 (推荐)
如果你遇到环境缺失问题（如缺少 Node.js 或 apt-get），可以指定使用功能完整的镜像：
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

- `npm run deploy`: 构建并部署到 Cloudflare Workers
- `npm run validate:manifest`: 验证 manifest.json 格式
- `npm run diagnose:axiom`: 诊断 Axiom 日志

## License

ISC