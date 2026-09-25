# ⚙️ 配置指南

本指南详细说明了 Load Balancer Worker 的所有配置选项和最佳实践。

## 📋 配置概览

Load Balancer Worker 支持多种配置方式：

- **环境变量** (推荐) - 通过 `.env` 文件或 CI/CD 系统
- **Manifest 文件** - `manifest.json` 定义项目结构和行为
- **Secrets 管理** - Infisical 或 Doppler 集成
- **运行时配置** - 通过 API 动态配置

## 🌍 环境变量配置

### 核心配置

| 变量名 | 类型 | 必填 | 默认值 | 说明 |
|---------|------|------|---------|------|
| `NODE_ENV` | string | 否 | `dev` | 运行环境: `dev`, `pre`, `prod` |
| `WORKER_NAME` | string | 否 | - | Worker 名称，用于 Cloudflare 部署 |
| `VERSION` | string | 否 | - | 应用版本号，通常通过构建注入 |

### Cloudflare 配置

| 变量名 | 类型 | 必填 | 示例值 | 说明 |
|---------|------|------|---------|------|
| `CLOUDFLARE_ACCOUNT_ID` | string | 是 | `1234567890abcdef1234567890abcdef` | Cloudflare 账户 ID (32位) |
| `CLOUDFLARE_API_TOKEN` | string | 是 | `xxxxx_xxxxxx...` | Cloudflare API Token |
| `CF_KV_NAMESPACE_ID` | string | 是 | `abcdefghijklmnopqrstuvwxyz123456` | KV 命名空间 ID |
| `KV_PREVIEW_ID` | string | 否 | `fedcba0987654321fedcba0987654321` | 预览环境 KV ID |

### 应用功能配置

| 变量名 | 类型 | 必填 | 默认值 | 说明 |
|---------|------|------|---------|------|
| `QSTASH_CURRENT_SIGNING_KEY` | string | 是* | - | QStash 当前签名密钥 |
| `QSTASH_NEXT_SIGNING_KEY` | string | 否 | - | QStash 下一个签名密钥 (密钥轮换) |
| `SIGNATURE_EXPIRATION_WINDOW` | number | 否 | `900` | 签名过期窗口 (秒) |
| `SKIP_SIGNATURE_VERIFY` | boolean | 否 | `false` | 跳过签名验证 (仅测试环境) |

### 缓存配置

| 变量名 | 类型 | 必填 | 示例值 | 说明 |
|---------|------|------|---------|------|
| `CACHE_PROVIDERS` | JSON | 否 | 见下方 | 缓存提供者配置数组 |
| `UPSTASH_REDIS_REST_URL` | string | 否 | `https://redis-12345.c1.us-east-1-2.ec2.cloud.redislabs.com:12345` | Upstash Redis URL |
| `UPSTASH_REDIS_REST_TOKEN` | string | 否 | `ABC123...` | Upstash Redis Token |

### 日志配置

| 变量名 | 类型 | 必填 | 示例值 | 说明 |
|---------|------|------|---------|------|
| `AXIOM_TOKEN` | string | 否 | `xxxxx-xxxx-xxxx-xxxx` | Axiom 数据摄取 Token |
| `AXIOM_DATASET` | string | 否 | `lb-worker-logs` | Axiom 数据集名称 |
| `AXIOM_ORG_ID` | string | 否 | `my-org-id` | Axiom 组织 ID |
| `DEBUG_LOGS` | boolean | 否 | `false` | 启用详细调试日志 |

### Secrets Provider 配置

#### Infisical 配置
| 变量名 | 类型 | 必填 | 示例值 | 说明 |
|---------|------|------|---------|------|
| `SECRETS_PROVIDER` | string | 否 | `infisical` | 强制使用 Infisical |
| `INFISICAL_PROJECT_ID` | string | 是* | `your-project-id` | Infisical 项目 ID |
| `INFISICAL_TOKEN` | string | 是* | `dp.st.dev.xxxxxx` | Infisical Service Token |
| `INFISICAL_SITE_URL` | string | 否 | `https://app.infisical.com` | 自定义 Infisical 站点 URL |

#### Doppler 配置
| 变量名 | 类型 | 必填 | 示例值 | 说明 |
|---------|------|------|---------|------|
| `SECRETS_PROVIDER` | string | 否 | `doppler` | 强制使用 Doppler |
| `DOPPLER_PROJECT` | string | 是* | `lb-worker-prod` | Doppler 项目名 |
| `DOPPLER_TOKEN` | string | 是* | `dp.st.dev.xxxxxx` | Doppler Service Token |
| `DOPPLER_API_TOKEN` | string | 否 | `your-api-token` | Doppler API Token |
| `DOPPLER_SERVICE_ACCOUNT_TOKEN` | string | 否 | `dp.sa.xxxxxx` | Doppler Service Account Token |
| `DOPPLER_API_KEY` | string | 否 | `your-api-key` | Doppler API Key (Legacy) |
| `DOPPLER_API_HOST` | string | 否 | `https://api.doppler.com` | Doppler API Host |

## 📋 缓存提供者配置

### JSON 配置格式

```bash
export CACHE_PROVIDERS='[
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
    "priority": 2,
    "timeout": 5000,
    "options": {
      "enableAutoPipelining": true,
      "maxRetriesPerRequest": 3
    }
  }
]'
```

### 支持的缓存类型

#### Cloudflare KV (cloudflare-kv-binding)
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 提供者唯一标识 |
| `type` | string | 是 | 必须为 `cloudflare-kv-binding` |
| `binding` | string | 是 | wrangler.toml 中的 KV 绑定名称 |
| `priority` | number | 否 | 优先级，数字越小优先级越高 |

#### Redis (redis)
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 是 | 提供者唯一标识 |
| `type` | string | 是 | 必须为 `redis` |
| `url` | string | 是 | Redis 连接 URL |
| `priority` | number | 否 | 优先级 |
| `timeout` | number | 否 | 连接超时 (毫秒) |
| `options` | object | 否 | Redis 客户端选项 |

### 优先级和故障转移

1. **主缓存**: `priority` 值最小的提供者
2. **故障转移**: 主缓存失败时自动切换到下一个
3. **重试机制**: 内置指数退避重试
4. **健康检查**: 定期检查提供者可用性

## 🔧 构建时配置

### 环境特定配置

#### 开发环境 (.env.dev)
```bash
# 开发环境配置
NODE_ENV=dev
WORKER_NAME=lb-worker-js-dev
DEBUG_LOGS=true
SKIP_SIGNATURE_VERIFY=false
CACHE_PROVIDERS='[{"name":"local-kv","type":"cloudflare-kv-binding","binding":"KV_STORAGE","priority":1}]'
```

#### 预生产环境 (.env.pre)
```bash
# 预生产环境配置
NODE_ENV=pre
WORKER_NAME=lb-worker-js-pre
DEBUG_LOGS=false
SIGNATURE_EXPIRATION_WINDOW=600
CACHE_PROVIDERS='[{"name":"kv-primary","type":"cloudflare-kv-binding","binding":"KV_STORAGE","priority":1},{"name":"redis-backup","type":"redis","url":"redis://prod:pass@cache.prod.com:6379","priority":2}]'
```

#### 生产环境 (.env.prod)
```bash
# 生产环境配置
NODE_ENV=prod
WORKER_NAME=lb-worker-js-prod
DEBUG_LOGS=false
SIGNATURE_EXPIRATION_WINDOW=300
CACHE_PROVIDERS='[{"name":"kv-primary","type":"cloudflare-kv-binding","binding":"KV_STORAGE","priority":1},{"name":"redis-backup","type":"redis","url":"redis://prod:pass@cache.prod.com:6379","priority":2}]'
```

### Secrets 管理

#### 使用 Infisical
```bash
# 强制使用 Infisical
export SECRETS_PROVIDER=infisical

# 项目配置
export INFISICAL_PROJECT_ID=your-project-id
export INFISICAL_TOKEN=dp.st.dev.xxxxxx

# 构建时自动注入 secrets
npm run build:enhanced -- --env=prod
```

#### 使用 Doppler
```bash
# 强制使用 Doppler
export SECRETS_PROVIDER=doppler

# 项目配置
export DOPPLER_PROJECT=lb-worker-prod
export DOPPLER_TOKEN=dp.st.dev.xxxxxx

# 构建时自动注入 secrets
npm run build:enhanced -- --env=prod
```

#### 禁用 Secrets 管理
```bash
# 仅使用环境变量，跳过 secrets provider
export USE_ORCHESTRATED_SECRETS=false

# 使用传统构建方式
npm run build -- --env=prod
```

## 📄 Manifest 配置

### manifest.json 结构

```json
{
  "manifest_version": "1.1",
  "id": "lb-worker-js",
  "name": "QStash Load Balancer",
  "version": "1.3.1",
  "type": "worker",
  "entrypoint": "src/index.js",
  "runtime": {
    "type": "nodejs",
    "version": "nodejs20"
  },
  "config": {
    "env": {
      "VARIABLE_NAME": {
        "type": "string",
        "required": true,
        "description": "变量说明"
      }
    }
  }
}
```

### 环境变量类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `string` | 字符串值 | `"hello world"` |
| `number` | 数字值 | `42` |
| `boolean` | 布尔值 | `true` |
| `kv-namespace` | KV 命名空间绑定 | `"KV_STORAGE"` |

## 🚀 运行时配置

### 通过 API 动态配置

```javascript
// 更新负载均衡策略
const response = await fetch(`${WORKER_URL}/api/config`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${ADMIN_API_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    loadBalancingStrategy: 'weighted',
    weights: { 'instance1': 0.7, 'instance2': 0.3 }
  })
});
```

### 配置热更新

```javascript
// 监听配置变更事件
import { configManager } from './config-manager.js';

configManager.on('configChanged', (changes) => {
  console.log('Configuration updated:', changes);
  
  // 自动重启相关服务
  if (changes.some(c => c.key.startsWith('CACHE_'))) {
    await reinitializeCacheServices();
  }
});
```

## 🛡️ 安全配置

### 最佳实践

#### 1. 环境隔离
```bash
# ✅ 推荐做法
NODE_ENV=prod
WORKER_NAME=lb-worker-prod

# ❌ 避免做法
NODE_ENV=production
WORKER_NAME=same-name-for-all-envs
```

#### 2. Secrets 管理
```bash
# ✅ 推荐做法
SECRETS_PROVIDER=infisical  # 或 doppler
INFISICAL_PROJECT_ID=project-id
INFISICAL_TOKEN=service-token

# ❌ 避免做法
QSTASH_KEY=hardcoded-secret-value
REDIS_PASSWORD=another-secret
```

#### 3. 最小权限原则
```bash
# Cloudflare API Token 权限最小化
# Account:read (读取账户信息)
# Zone:read (读取区域配置)
# Worker:edit (编辑和部署 Worker)
# 避免给予过多权限
```

### 配置验证

```bash
# 验证配置完整性
npm run validate:manifest

# 检查环境变量
npm run check:environment

# 验证 secrets 配置
npm run validate:secrets
```

### 配置监控

```bash
# 监控配置变更
DEBUG_LOGS=true npm run dev

# 查看 secrets 注入日志
cat secrets-metadata.json

# 监控缓存性能
AXIOM_TOKEN=your-token npm run test:performance
```

## 🔄 配置迁移

### 从旧版本升级

```bash
# 1. 备份现有配置
cp .env .env.backup.$(date +%Y%m%d)

# 2. 检查新的配置要求
npm run doctor:config

# 3. 更新配置文件
nano .env

# 4. 验证新配置
npm run validate:all
```

### 环境间同步

```bash
# 从生产环境复制配置到开发环境
npm run sync:config --from=prod --to=dev

# 导出配置模板
npm run export:template --env=prod > prod.template.env
```

## 🧪 配置测试

### 单元测试配置
```bash
# 测试配置加载
npm test -- --testNamePattern="configuration"

# 测试环境变量处理
npm test -- --testNamePattern="env-variables"

# 测试缓存配置
npm test -- --testNamePattern="cache-config"
```

### 集成测试配置
```bash
# 端到端配置测试
npm run test:e2e -- --config=test

# 不同环境配置测试
npm run test:integration -- --env=dev,pre,prod
```

## 📊 配置参考

### 环境变量完整列表
[查看完整的环境变量参考](./reference/environment-variables.md)

### Manifest Schema
[查看详细的 manifest 配置规范](./reference/manifest-schema.md)

### 常见配置组合
[查看预设的配置模板](./reference/configuration-templates.md)

---

## 🔗 相关文档

- [🚀 快速开始](./quick-start.md)
- [🔐 Secrets 管理](./secrets-management.md)
- [📚 文档导航](../README.md)
- [🏗️ 系统架构](../architecture/system-overview.md)

---

**💡 提示**: 如果遇到配置问题，请查看 [故障排除指南](../troubleshooting/faq.md) 或提交 [Issue](https://github.com/your-org/lb-worker-js/issues)。