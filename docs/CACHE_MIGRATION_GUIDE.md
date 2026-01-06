# Cache Service 迁移指南

本文档指导您如何从旧的环境变量配置迁移到新的 JSON 配置驱动的 `CacheService` 架构。

## 1. 概述

新的 `CacheService` 引入了 `CACHE_PROVIDERS` 环境变量，允许您通过 JSON 数组定义多个缓存提供者，支持优先级排序、故障转移和环境变量插值。

## 2. 核心概念

### 2.1 优先级 (Priority)
*   数值越小，优先级越高（1 = 最高）。
*   系统会按优先级顺序尝试连接提供者。
*   如果高优先级提供者连接失败，会自动尝试下一个。

### 2.2 故障转移 (Failover)
*   当运行中的提供者发生错误时，系统会记录失败次数。
*   达到阈值后，系统会进入“故障转移模式”，降级到内存缓存（L1）或尝试连接备用提供者。

### 2.3 环境变量插值
*   JSON 配置中支持 `${VAR}` 语法。
*   系统会在运行时自动将 `${VAR}` 替换为对应的环境变量值。

## 3. 配置字段详解

### 3.1 全局配置变量

| 变量名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `CACHE_PROVIDERS` | String (JSON) | 否 | 缓存提供者配置数组。如果不填，系统会尝试从旧的环境变量自动检测。 |
| `PRIMARY_CACHE_PROVIDER` | String | 否 | 强制指定某个提供者的 `name` 作为主提供者，用于覆盖优先级逻辑。 |

### 3.2 单个提供者配置对象字段

每个 JSON 数组中的对象包含以下字段：

| 字段名 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `name` | String | 是 | 提供者的唯一标识符，用于日志和 `PRIMARY_CACHE_PROVIDER` 覆盖。 |
| `type` | String | 是 | 提供者类型（见下文支持的类型列表）。 |
| `priority` | Number | 是 | 优先级，数值越小越优先。 |
| `host` | String | 条件 | 主机地址（TCP/TLS 类型需要）。 |
| `port` | Number | 条件 | 端口号（TCP/TLS 类型需要）。 |
| `password` | String | 否 | 密码。 |
| `db` | Number | 否 | 数据库索引，默认 0。 |
| `tls` | Object | 否 | TLS 配置。包含 `enabled`, `rejectUnauthorized`, `servername` 等字段。 |
| `restUrl` | String | 条件 | REST API 地址（Upstash/HTTP 类型需要）。 |
| `restToken` | String | 条件 | REST API Token（Upstash/HTTP 类型需要）。 |
| `accountId` | String | 条件 | Cloudflare Account ID（Cloudflare KV 类型需要）。 |
| `namespaceId` | String | 条件 | Cloudflare Namespace ID（Cloudflare KV 类型需要）。 |
| `token` | String | 条件 | Cloudflare Token（Cloudflare KV 类型需要）。 |
| `replicas` | Number | 否 | **预留字段**，未来用于连接池或负载均衡扩展。 |

## 4. 支持的 `type` 列表

| Type 值 | 对应 Provider 类 | 适用场景 | 必需字段 |
| :--- | :--- | :--- | :--- |
| `valkey` | `ValkeyCache` | 标准 Valkey (TCP) | `host`, `port` |
| `valkey` + `tls` | `ValkeyTLSCache` | Valkey (TLS/SSL) | `host`, `port`, `tls` |
| `redis` | `RedisCache` | 标准 Redis (TCP) | `host`, `port` |
| `redis` + `tls` | `RedisTLSCache` | Redis (TLS/SSL) | `host`, `port`, `tls` |
| `aiven-valkey` | `AivenVTCache` | Aiven 托管 Valkey | `host`, `port` (自动启用 TLS) |
| `upstash-rest` | `UpstashRHCache` | Upstash REST API | `restUrl`, `restToken` |
| `cloudflare-kv` | `CloudflareKVCache` | Cloudflare KV | `accountId`, `namespaceId`, `token` |
| `northflank` | `NorthFlankRTCache` | Northflank Redis | `nfRedisUrl` (或环境变量) |

## 5. 迁移步骤

### 步骤 1: 准备新的 JSON 配置

根据您当前的环境变量，构建对应的 JSON 数组。

**示例：从旧变量迁移到新配置**

假设您当前使用：
*   `VALKEY_URL`: `redis://user:pass@valkey.internal:6379/0`
*   `UPSTASH_REDIS_REST_URL`: `https://us1-upstash.io`
*   `UPSTASH_REDIS_REST_TOKEN`: `token123`

**新的 `CACHE_PROVIDERS` 配置：**

```json
[
  {
    "name": "primary-valkey",
    "type": "valkey",
    "host": "valkey.internal",
    "port": 6379,
    "password": "pass",
    "db": 0,
    "priority": 1
  },
  {
    "name": "backup-upstash",
    "type": "upstash-rest",
    "restUrl": "https://us1-upstash.io",
    "restToken": "token123",
    "priority": 2
  }
]
```

### 步骤 2: 使用环境变量插值 (推荐)

为了安全起见，不要在 JSON 中硬编码密码。使用 `${VAR}`：

```json
[
  {
    "name": "primary-valkey",
    "type": "valkey",
    "host": "${VALKEY_HOST}",
    "port": "${VALKEY_PORT}",
    "password": "${VALKEY_PASSWORD}",
    "priority": 1
  }
]
```

然后在环境变量中设置：
*   `VALKEY_HOST=valkey.internal`
*   `VALKEY_PORT=6379`
*   `VALKEY_PASSWORD=your_secret_password`

### 步骤 3: 设置 `CACHE_PROVIDERS`

将构建好的 JSON 字符串设置为 `CACHE_PROVIDERS` 环境变量。

**注意：** JSON 字符串中不能包含换行符（在某些部署平台可能需要转义）。

### 步骤 4: 验证配置

系统启动时会输出日志：
```
[CacheService] Instantiating ValkeyCache for 'primary-valkey'
[CacheService] Connected to primary provider: Valkey (primary-valkey)
```

如果看到 `MemoryCache`，说明配置解析失败或连接失败，请检查日志。

## 6. 高级配置

### 6.1 TLS 配置示例

```json
[
  {
    "name": "secure-valkey",
    "type": "valkey",
    "host": "secure-valkey.internal",
    "port": 6380,
    "tls": {
      "enabled": true,
      "rejectUnauthorized": true,
      "servername": "secure-valkey.internal"
    },
    "priority": 1
  }
]
```

### 6.2 强制指定主提供者

如果您有多个配置，但想强制使用其中一个（即使它的优先级不是最高）：

```bash
# 环境变量
PRIMARY_CACHE_PROVIDER=backup-upstash
```

### 6.3 仅使用旧环境变量 (向后兼容)

如果您不设置 `CACHE_PROVIDERS`，系统会尝试使用旧的环境变量（如 `VALKEY_URL`, `REDIS_URL`, `UPSTASH_REDIS_REST_URL` 等）自动构建一个提供者。

## 7. 常见问题

**Q: 我可以同时配置多个同类型的提供者吗？**
A: 可以。只要它们的 `name` 不同，且 `priority` 不同即可。

**Q: `replicas` 字段有什么用？**
A: 目前是预留字段。未来版本可能会用于创建连接池或实现读写分离。

**Q: 如果 `CACHE_PROVIDERS` 格式错误会怎样？**
A: 系统会记录错误日志，并回退到旧的环境变量检测逻辑。如果旧逻辑也无效，系统将仅使用内存缓存（L1）。

**Q: 如何测试配置是否正确？**
A: 可以在代码中调用 `cache.getConnectionInfo()` 查看当前连接的提供者信息。

**Q: `CACHE_PROVIDERS`、`VALKEY_*`、`REDIS_*` 如果我同时填了这些，优先级是什么？**
A: **`CACHE_PROVIDERS` 拥有最高优先级。**
1.  如果设置了 `CACHE_PROVIDERS`，系统会**完全忽略** `VALKEY_*`、`REDIS_*`、`UPSTASH_*` 等所有旧的环境变量。
2.  只有当 `CACHE_PROVIDERS` **未设置** 或 **为空** 时，系统才会回退到检测旧的环境变量（`VALKEY_URL`, `REDIS_URL` 等）来自动构建一个提供者。
3.  **建议：** 迁移时，一旦确认 `CACHE_PROVIDERS` 配置无误，可以移除旧的 `VALKEY_*`/`REDIS_*` 环境变量以避免混淆。