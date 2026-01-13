# Cloudflare KV 缓存重构说明

## 背景
在之前的架构中，Cloudflare KV 被作为分布式缓存（Cache Provider）的一个选项。但由于 KV 的最终一致性（Eventually Consistent）特性，其在分布式锁和高频心跳场景下表现不佳。为了优化系统性能并简化缓存逻辑，现决定将 Cloudflare KV 从缓存系统中彻底剔除。

## 变更内容

### 1. 代码重构
- **`CacheService.js`**: 移除了对 `CloudflareKVCache` 的所有引用。KV 不再参与缓存的自动发现、实例化及故障转移（Failover）逻辑。
- **`CloudflareKVCache.js`**: 该文件被保留，但仅作为底层操作能力的代码库。其内部实现了 `get/set/list/delete` 等基础功能，供日后非缓存类的 KV 操作调用。
- **配置检测**: 为 `CloudflareKVCache` 增加了 `detectConfig` 静态方法，支持独立于缓存系统的配置加载。

### 2. 环境变量标准化
为了统一命名规范并消除歧义，所有 `CF_` 前缀的环境变量已重命名为 `CLOUDFLARE_` 全拼。同时移除了专门用于缓存的 `CF_CACHE_` 命名前缀。

| 旧变量名 | 新变量名 (CLOUDFLARE_KV_) | 说明 |
| :--- | :--- | :--- |
| `CF_CACHE_ACCOUNT_ID` / `CF_KV_ACCOUNT_ID` | `CLOUDFLARE_KV_ACCOUNT_ID` | KV 账户 ID |
| `CF_CACHE_NAMESPACE_ID` / `CF_KV_NAMESPACE_ID` | `CLOUDFLARE_KV_NAMESPACE_ID` | KV 命名空间 ID |
| `CF_CACHE_TOKEN` / `CF_KV_TOKEN` | `CLOUDFLARE_KV_TOKEN` | KV API 令牌 |
| `CF_ACCOUNT_ID` | `CLOUDFLARE_ACCOUNT_ID` | 通用账户 ID |
| `CF_D1_*` | `CLOUDFLARE_D1_*` | D1 数据库相关变量同步更名 |

### 3. Manifest 更新
- 移除了 `manifest.json` 中 `capabilities` 相关的 KV 缓存描述。
- 移除了 `CACHE_PROVIDER` 和 `KV_PROVIDER` 枚举中的 `cloudflare` 选项。
- 更新了环境字段定义，使用新的全拼命名。

## 影响范围
- **缓存系统**: 现在默认将不再自动连接到 Cloudflare KV。建议使用 Redis、Valkey 或 Upstash 作为生产环境的分布式缓存。
- **D1 数据库**: 仅涉及环境变量更名，功能不受影响。
- **运维**: 需要更新 `.env` 文件或 CI/CD 中的环境变量名称。

## 后续建议
Cloudflare KV 目前保留的代码能力可用于存储一些不要求强一致性、低频更新但需要持久化的元数据（如静态配置映射等）。如需使用，请直接实例化 `CloudflareKVCache` 类。
