# Load Balancer Worker - Documentation

## 📚 文档概览

本文档库提供了Load Balancer Worker的完整使用指南和技术文档。

### 🎯 快速开始

| 需求 | 文档 |
|------|------|
| **项目概述** | [📖 系统概览](./architecture/system-overview.md) |
| **快速部署** | [🚀 快速开始指南](./guides/quick-start.md) |
| **配置指南** | [⚙️ 配置指南](./guides/configuration.md) |

### 🔧 集成指南

| 功能 | 文档 |
|------|------|
| **Secrets管理** | [🔐 Secrets管理指南](./guides/secrets-management.md) |
| **Infisical集成** | [🔑 Infisical集成指南](./integration/infisical.md) |
| **Doppler集成** | [🌐 Doppler集成指南](./integration/doppler.md) |
| **GitHub Actions** | [🔄 CI/CD集成指南](./integration/github-actions.md) |
| **本地开发** | [💻 本地开发指南](./guides/local-development.md) |

### 🏗️ 架构文档

| 组件 | 文档 |
|------|------|
| **系统架构** | [📐 架构概览](./architecture/system-overview.md) |
| **Secrets架构** | [🔐 Secrets管理架构](./architecture/secrets-architecture.md) |
| **缓存系统** | [💾 缓存系统设计](./architecture/cache-system.md) |
| **负载均衡** | [⚖️ 负载均衡策略](./architecture/load-balancing.md) |

### 📖 API文档

| API | 文档 |
|-----|------|
| **管理API** | [🔧 管理API](./api/admin-api.md) |
| **健康检查** | [❤️ 健康检查API](./api/health-check.md) |
| **Webhook API** | [🪝 Webhook处理API](./api/webhook-api.md) |

### 🧪 测试指南

| 测试类型 | 文档 |
|----------|------|
| **单元测试** | [🧪 单元测试指南](./guides/testing-unit.md) |
| **集成测试** | [🔗 集成测试指南](./guides/testing-integration.md) |
| **性能测试** | [⚡ 性能测试指南](./guides/testing-performance.md) |

### 🚀 部署指南

| 环境 | 文档 |
|------|------|
| **开发环境** | [🛠️ 开发环境部署](./guides/deployment-dev.md) |
| **预生产环境** | [🧪 预生产部署](./guides/deployment-pre.md) |
| **生产环境** | [🚀 生产环境部署](./guides/deployment-prod.md) |

### 🔧 故障排除

| 问题类型 | 文档 |
|----------|------|
| **常见问题** | [❓ 常见问题](./troubleshooting/faq.md) |
| **调试指南** | [🔍 调试指南](./troubleshooting/debugging.md) |
| **性能优化** | [⚡ 性能优化](./troubleshooting/performance.md) |
| **错误码参考** | [🔢 错误码参考](./troubleshooting/error-codes.md) |

### 📝 参考文档

| 参考 | 文档 |
|------|------|
| **环境变量** | [🌍 环境变量参考](./reference/environment-variables.md) |
| **配置项** | [⚙️ 配置项参考](./reference/configuration-options.md) |
| **Manifest Schema** | [📋 Manifest Schema参考](./reference/manifest-schema.md) |
| **更新日志** | [📅 更新日志](./reference/changelog.md) |

---

## 🚀 快速导航

### 我想要...
```bash
# 🚀 快速开始项目
查看 ./guides/quick-start.md

# 🔐 设置secrets管理
查看 ./guides/secrets-management.md

# 🌐 集成Doppler/Infisical
查看 ./integration/doppler.md 或 ./integration/infisical.md

# 🚀 部署到生产环境
查看 ./guides/deployment-prod.md

# 🔧 调试问题
查看 ./troubleshooting/debugging.md

# 🧪 运行测试
查看 ./guides/testing-integration.md
```

### 找特定信息...
```bash
# 🌍 环境变量列表
查看 ./reference/environment-variables.md

# 📋 Manifest配置说明
查看 ./reference/manifest-schema.md

# 📅 最近更新内容
查看 ./reference/changelog.md

# ❓ 常见问题解答
查看 ./troubleshooting/faq.md
```

## 📊 文档统计

| 类型 | 文档数量 |
|------|----------|
| 📖 概览文档 | 1 |
| 🎯 快速开始 | 2 |
| 🔧 集成指南 | 5 |
| 🏗️ 架构文档 | 4 |
| 📖 API文档 | 3 |
| 🧪 测试指南 | 3 |
| 🚀 部署指南 | 3 |
| 🔧 故障排除 | 4 |
| 📝 参考文档 | 4 |

**总计**: 29个核心文档文件

---

## 📝 文档贡献

### 如何贡献
1. **创建新文档**: 在相应的子目录中创建文件
2. **更新现有文档**: 编辑对应的文档文件
3. **更新导航**: 更新本README.md中的导航链接
4. **遵循规范**: 使用Markdown格式，遵循文档结构规范

### 文档规范
- ✅ 使用清晰、简洁的中文描述
- ✅ 包含代码示例和使用说明
- ✅ 添加适当的emoji图标增强可读性
- ✅ 提供完整的配置示例
- ✅ 包含故障排除和调试信息

### 文档结构规范
```
docs/
├── README.md                    # 主导航文档 (本文件)
├── guides/                      # 用户指南
├── architecture/                # 架构设计文档
├── integration/                 # 集成指南
├── api/                       # API文档
├── troubleshooting/            # 故障排除
└── reference/                 # 参考文档
```

---

## 🔗 相关链接

- [GitHub Repository](https://github.com/your-org/lb-worker-js)
- [项目主页](https://github.com/your-org/lb-worker-js#readme)
- [问题反馈](https://github.com/your-org/lb-worker-js/issues)
- [变更请求](https://github.com/your-org/lb-worker-js/pulls)

---

**💡 提示**: 建议将此页面加入书签，作为访问所有文档的入口点。
