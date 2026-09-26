# 🌐 Load Balancer Worker

[![Tests](https://img.shields.io/github/actions/workflows/test/badge.svg)](https://github.com/your-org/lb-worker-js/actions/workflows/test)
[![Version](https://img.shields.io/github/v/release/your-org/lb-worker-js)](https://github.com/your-org/lb-worker-js/releases)
[![License](https://img.shields.io/github/license/your-org/lb-worker-js)](https://github.com/your-org/lb-worker-js/blob/main/LICENSE)

专为 **drive-collector-js** 设计的高可用负载均衡器，支持 QStash 签名验证、动态实例发现与多层级故障转移。使用企业级 secrets 管理和统一的 CacheService 架构。

## ✨ 核心特性

### 🔐 **企业级 Secrets 管理**
- 🏗️ **三层架构设计**: BaseSecretsProvider → CloudSecretsProvider → 具体 Provider
- 🔄 **双 Provider 支持**: Infisical + Doppler，统一接口，自动切换
- ⚙️ **构建时注入**: 自动化的 secrets 注入和 wrangler 集成
- 🛡️ **安全优先级**: Service Token > API Token > Service Account > API Key
- 📊 **完整审计**: 构建元数据、变更追踪、访问日志

### ⚖️ **智能负载均衡**
- 🎯 **多策略支持**: 轮询、加权、健康状态分发
- 🔄 **动态发现**: 实时实例注册和健康监控
- ⚡ **故障转移**: 自动故障检测和无缝切换
- 🔒 **分布式锁**: 防止并发冲突，保证数据一致性
- 📈 **性能监控**: 请求分发统计和实时指标

### 💾 **多级缓存系统**
- 🌍 **Provider 抽象**: 统一接口支持多种存储后端
- ⚡ **Cloudflare KV**: 边缘分布式缓存，全球低延迟
- 🔥 **Redis 集成**: 高性能内存数据库，故障转移备份
- 🧠 **智能降级**: 自动故障转移和连接池管理
- 📊 **缓存统计**: 命中率、延迟监控和性能指标

### 📝 **可观测性**
- 📊 **结构化日志**: Console + Axiom 双重输出
- 🔍 **OpenTelemetry**: 分布式追踪和性能监控
- ❤️ **健康检查**: 多端点健康状态监控
- 📈 **指标收集**: 实时性能指标和告警集成

## 🚀 快速开始

### 1. 安装配置
```bash
git clone https://github.com/your-org/lb-worker-js.git
cd lb-worker-js
npm install
cp .env.example .env
```

### 2. 选择 Secrets Provider

#### 方案 A: Infisical (企业推荐)
```bash
# 安装 CLI
npm install -g @infisical/cli
infisical login

# 配置环境变量
INFISICAL_PROJECT_ID=your-project
INFISICAL_TOKEN=dp.st.dev.xxxxxx
SECRETS_PROVIDER=infisical
```

#### 方案 B: Doppler (现代推荐)
```bash
# 安装 CLI
npm install -g @dopplerhq/cli
doppler login

# 配置环境变量
DOPPLER_PROJECT=your-project
DOPPLER_TOKEN=dp.st.dev.xxxxxx
SECRETS_PROVIDER=doppler
```

### 3. 部署
```bash
# 开发环境
npm run dev:dev

# 生产部署 (自动 secrets 注入)
npm run deploy:prod

# 预览构建过程
npm run build:enhanced -- --env=prod --dry-run
```

## 📚 完整文档

### 🎯 快速导航
| 需求 | 文档 |
|------|------|
| **快速开始** | [🚀 快速开始指南](docs/guides/quick-start.md) |
| **配置指南** | [⚙️ 配置指南](docs/guides/configuration.md) |
| **系统概览** | [📐 系统架构概览](docs/architecture/system-overview.md) |

### 🔧 详细指南
| 功能 | 文档 |
|------|------|
| **Secrets管理** | [🔐 Secrets管理指南](docs/guides/secrets-management.md) |
| **Infisical集成** | [🔑 Infisical集成指南](docs/integration/infisical.md) |
| **Doppler集成** | [🌐 Doppler集成指南](docs/integration/doppler.md) |
| **GitHub Actions** | [🔄 CI/CD集成指南](docs/integration/github-actions.md) |

### 🏗️ 架构设计
| 组件 | 文档 |
|------|------|
| **Secrets架构** | [🔐 Secrets管理架构](docs/architecture/secrets-architecture.md) |
| **缓存系统** | [💾 缓存系统设计](docs/architecture/cache-system.md) |
| **负载均衡** | [⚖️ 负载均衡策略](docs/architecture/load-balancing.md) |

### 📖 API文档
| API | 文档 |
|-----|------|
| **管理API** | [🔧 管理员API](docs/api/admin-api.md) |
| **健康检查** | [❤️ 健康检查API](docs/api/health-check.md) |
| **Webhook处理** | [🪝 Webhook处理API](docs/api/webhook-api.md) |

### 🧪 测试指南
| 测试类型 | 文档 |
|----------|------|
| **单元测试** | [🧪 单元测试指南](docs/guides/testing-unit.md) |
| **集成测试** | [🔗 集成测试指南](docs/guides/testing-integration.md) |
| **性能测试** | [⚡ 性能测试指南](docs/guides/testing-performance.md) |

### 🚀 部署指南
| 环境 | 文档 |
|------|------|
| **开发环境** | [🛠️ 开发环境部署](docs/guides/deployment-dev.md) |
| **预生产环境** | [🧪 预生产部署](docs/guides/deployment-pre.md) |
| **生产环境** | [🚀 生产环境部署](docs/guides/deployment-prod.md) |

### 🔧 故障排除
| 问题类型 | 文档 |
|----------|------|
| **常见问题** | [❓ 常见问题](docs/troubleshooting/faq.md) |
| **调试指南** | [🔍 调试指南](docs/troubleshooting/debugging.md) |
| **性能优化** | [⚡ 性能优化](docs/troubleshooting/performance.md) |

### 📝 参考文档
| 参考 | 文档 |
|------|------|
| **环境变量** | [🌍 环境变量参考](docs/reference/environment-variables.md) |
| **配置项** | [⚙️ 配置项参考](docs/reference/configuration-options.md) |
| **更新日志** | [📅 更新日志](docs/reference/changelog.md) |

## 🧪 测试

```bash
# 运行测试套件
npm test

# 运行特定测试
npm test -- --testNamePattern="secrets"
npm test -- --testNamePattern="cache"
npm test -- --testNamePattern="load-balancer"

# 生成覆盖率报告
npm run test:coverage
```

## 📊 性能指标

### 基准性能
- 🚀 **响应时间**: P95 < 100ms
- ⚡ **吞吐量**: > 1000 RPS
- 📈 **可用性**: 99.9% SLA
- 🔄 **故障转移**: < 5s 检测时间

### 监控集成
- 📊 **Axiom**: 结构化日志和指标
- ❤️ **健康检查**: 多端点状态监控
- 🔍 **OpenTelemetry**: 分布式追踪支持

## 🛡️ 安全

### 多层安全防护
- 🔐 **Secrets管理**: 企业级 secrets 管理和自动轮换
- 🔑 **身份验证**: QStash Signature V2 + Admin API 认证
- 🔒 **传输加密**: 强制 TLS/SSL 加密传输
- 🛡️ **输入验证**: 严格的请求参数验证

### 合规性
- ✅ **GDPR 合规**: 数据处理和隐私保护
- ✅ **SOC 2 合规**: 安全控制和审计
- ✅ **ISO 27001**: 信息安全管理体系
- ✅ **OWASP 安全**: 遵循安全最佳实践

## 🔄 版本管理

- **语义化版本**: 遵循 SemVer 规范
- **自动化发布**: GitHub Actions 自动发布
- **变更日志**: 详细的变更记录
- **向后兼容**: 保持 API 稳定性

## 🤝 贡献

欢迎贡献代码、文档和反馈！

### 开发环境
```bash
# Fork 并克隆
git clone https://github.com/your-username/lb-worker-js.git
cd lb-worker-js

# 安装依赖
npm install

# 创建功能分支
git checkout -b feature/your-feature

# 开发和测试
npm run dev:dev
npm test
```

### 代码规范
- ✅ 使用 ES2022+ 语法
- ✅ 遵循 ESLint 规则
- ✅ 编写单元测试
- ✅ 添加 JSDoc 注释
- ✅ 遵循 Conventional Commits

---

**🚀 准备好构建高可用的负载均衡器了吗？**

[查看完整文档](./docs/README.md) | [快速开始](./docs/guides/quick-start.md) | [问题反馈](https://github.com/your-org/lb-worker-js/issues)

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
